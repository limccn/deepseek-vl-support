// Agent Plugins portable package support (install --target <agent list>):
// materializes the plugin directory (~/.deepseek-vl/plugin/) from the
// package root and registers/unregisters it for the 10 Agent Plugins
// clients: GitHub Copilot, Cursor, Kiro, OpenClaw, Hermes Agent, VS Code,
// ChatGPT & Codex, Grok Bot, NanoClaw, and generic "other" spec-compliant
// agents.
//
// Safety rules (same as the rest of the installer):
//  - external commands are only run when not dry-running; every failure is
//    captured into the per-client result and never blocks other clients
//  - file writes (Cursor copy, Copilot/VS Code settings.json fallbacks) are
//    backed up / marker-checked exactly like the Claude/Codex installers
//  - clients with no automation surface (Kiro, `other`) or whose CLI is not
//    detected (codex/grok/ncl/code missing from PATH) get precise guidance
//    instead of failing — always via the normal "manual" status, never a
//    thrown error
//  - the materialized plugin dir keeps exactly the 4 spec entries
//    (plugin.json, mcp.json, .mcp.json, skills/); client-specific shims
//    (e.g. the Codex local marketplace) live OUTSIDE it under
//    ~/.deepseek-vl/marketplace/
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { backupFile, readTextFile } from "./codex.ts";
import {
  CONFIG_DIR,
  CURSOR_PLUGIN_DIRNAME,
  CURSOR_PLUGIN_MARKER,
  CURSOR_PLUGIN_MARKER_FILE,
  PKG_NAME,
  PLUGIN_DIRNAME,
  PLUGIN_GITHUB_SLUG,
  PLUGIN_REPO,
} from "./identity.ts";

export type PluginClient =
  | "copilot"
  | "cursor"
  | "kiro"
  | "openclaw"
  | "hermes"
  | "vscode"
  | "chatgpt-codex"
  | "grok"
  | "nanoclaw"
  | "other";

export const PLUGIN_CLIENTS: readonly PluginClient[] = [
  "copilot",
  "cursor",
  "kiro",
  "openclaw",
  "hermes",
  "vscode",
  "chatgpt-codex",
  "grok",
  "nanoclaw",
  "other",
];

/** Every agent the installer can target: the native integrations
 *  (claude/codex/opencode plus the five CLI-agent integrations qwen/reasonix/
 *  kilo/workbuddy/devin, registered in src/cliagents.ts), the three skill-copy
 *  consumers (trae/pi/dsh, registered in src/skillagents.ts), and the ten
 *  Agent Plugins plugin clients. */
export type Agent =
  | "claude"
  | "codex"
  | "opencode"
  | "trae"
  | "pi"
  | "omp"
  | "dsh"
  | "qwen"
  | "reasonix"
  | "kilo"
  | "workbuddy"
  | "devin"
  | PluginClient;

export type AgentKind = "native" | "plugin" | "skill";

/** Declarative kind table — the single source of truth for which agents are
 *  native integrations, Agent Plugins clients, or skill-copy consumers.
 *  TypeScript enforces completeness (adding an Agent without a kind is a
 *  compile error), so the old name-comparison isPluginAgent cannot silently
 *  miss a new agent. */
export const AGENT_KINDS: Record<Agent, AgentKind> = {
  claude: "native",
  codex: "native",
  opencode: "native",
  qwen: "native",
  reasonix: "native",
  kilo: "native",
  workbuddy: "native",
  devin: "native",
  trae: "skill",
  pi: "skill",
  omp: "skill",
  dsh: "skill",
  copilot: "plugin",
  cursor: "plugin",
  kiro: "plugin",
  openclaw: "plugin",
  hermes: "plugin",
  vscode: "plugin",
  "chatgpt-codex": "plugin",
  grok: "plugin",
  nanoclaw: "plugin",
  other: "plugin",
};

// CLI-class agents first (native, then skill-copy), Oh My Pi right after
// Pi, the five new CLI-agent integrations (qwen/reasonix/kilo/workbuddy/
// devin) in CLI→IDE order after dsh, plugin clients last: the wizard groups
// them in the same order.
export const AGENTS: readonly Agent[] = [
  "claude",
  "codex",
  "opencode",
  "trae",
  "pi",
  "omp",
  "dsh",
  "qwen",
  "reasonix",
  "kilo",
  "workbuddy",
  "devin",
  ...PLUGIN_CLIENTS,
];

export function isPluginAgent(a: Agent): a is PluginClient {
  return AGENT_KINDS[a] === "plugin";
}

export const PLUGIN_CLIENT_LABELS: Record<PluginClient, string> = {
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  kiro: "Kiro",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  vscode: "VS Code",
  "chatgpt-codex": "ChatGPT & Codex",
  grok: "Grok Bot",
  nanoclaw: "NanoClaw",
  other: "Other agents (Agent Plugins open standard)",
};

/** Pure-name labels for every agent in the wizard menu (R5: no detection
 *  annotations, no explanatory parentheses). The "WorkBuddy (CodeBuddy Code)"
 *  label is a compound name (same precedent as "ChatGPT & Codex"), not an
 *  annotation: the tool is distributed as both names and the menu must be
 *  unambiguous. Plugin clients reuse their existing labels (the `other`
 *  label is descriptive, not an annotation). */
export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  trae: "Trae",
  pi: "Pi Coding Agent",
  omp: "Oh My Pi",
  dsh: "DeepSeek Harness",
  qwen: "Qwen Code",
  reasonix: "Reasonix",
  kilo: "Kilo Code",
  workbuddy: "WorkBuddy (CodeBuddy Code)",
  devin: "Devin",
  ...PLUGIN_CLIENT_LABELS,
};

export type PluginClientStatus = "ok" | "skipped" | "failed" | "manual";

export interface PluginClientResult {
  client: PluginClient;
  status: PluginClientStatus;
  detail: string;
}

export interface PluginClientDetection {
  detected: boolean;
  bin: string | null; // resolved executable path (CLI clients only)
  reason: string;
}

export interface PluginClientOptions {
  home: string;
  pluginDir: string; // absolute path of the materialized plugin dir
  clients?: PluginClient[];
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function trimErr(s: string): string {
  const t = s.trim();
  const line = t.split(/\r?\n/)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Quote an argument for the Windows cmd.exe command line: wrap in double
 *  quotes with embedded quotes doubled. Backslashes stay literal (cmd does
 *  not process them; JSON-style \\ escaping would corrupt Windows paths). */
function winQuote(a: string): string {
  return `"${a.replace(/"/g, '""')}"`;
}

/** Build the spawn command for a resolved executable. On Windows, .cmd/.bat
 *  shims are launched through the platform command interpreter (per the
 *  Agent Plugins spec §7.2.1 a .bat/.cmd wrapper may require one). Node
 *  cannot exec .cmd directly on some builds (EINVAL), and passing the
 *  command line as argv to cmd.exe gets re-quoted by CreateProcess; instead
 *  the fully quoted command string goes through shell:true, which invokes
 *  cmd.exe with the correct wrapping. */
function spawnCommand(bin: string, args: string[]): { cmd: string; argv: string[]; shell: boolean } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const cmdline = `"${bin}"${args.map((a) => ` ${winQuote(a)}`).join("")}`;
    return { cmd: cmdline, argv: [], shell: true };
  }
  return { cmd: bin, argv: args, shell: false };
}

/** Run a command with a timeout, capturing stdout/stderr. Never throws. */
function runCmd(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const { cmd, argv, shell } = spawnCommand(bin, args);
    const child = spawn(cmd, argv, {
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message ?? String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- detection

/** Resolve a bare executable name against PATH. On Windows, real executable
 *  extensions come first (PATHEXT order): npm installs an extensionless
 *  POSIX sh shim next to `.cmd`/`.ps1` shims, and raw-spawning the sh script
 *  fails CreateProcess with ENOENT (R5 real-machine finding) — so a `.cmd`
 *  sibling must win over the extensionless file. The extensionless probe
 *  stays last as the fallback for true extensionless executables. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

type ClientDetector = (home: string, env: NodeJS.ProcessEnv) => PluginClientDetection;

/** PATH-probe detector for clients whose CLI is the automation surface. */
function cliDetector(binName: string): ClientDetector {
  return (_home, env) => {
    const bin = findOnPath(binName, env);
    return {
      detected: bin !== null,
      bin,
      reason: bin ? `found ${bin}` : `${binName} not found on PATH`,
    };
  };
}

/** Config-dir probe for GUI clients without a CLI surface (Cursor, Kiro). */
function dirDetector(label: string, dirOf: (home: string) => string): ClientDetector {
  return (home) => {
    const dir = dirOf(home);
    const found = existsSync(dir);
    return { detected: found, bin: null, reason: found ? `found ${dir}` : `${dir} not found` };
  };
}

/** VS Code: the `code` CLI on PATH, or a user settings dir in the platform
 *  config location (Windows %APPDATA%\Code\User, elsewhere
 *  ~/.config/Code/User — both derived from `home` so detection stays
 *  hermetic and testable). */
const vscodeDetector: ClientDetector = (home, env) => {
  const bin = findOnPath("code", env);
  if (bin !== null) return { detected: true, bin, reason: `found ${bin}` };
  const userDir = join(vscodeUserSettingsPath(home), "..");
  const found = existsSync(userDir);
  return {
    detected: found,
    bin: null,
    reason: found ? `found ${userDir}` : `no VS Code user settings dir (${userDir}) and code not on PATH`,
  };
};

/** Per-client detection table — every client declares its own detector, or
 *  is absent (guidance-only, like `other`). There is NO catch-all branch: a
 *  new client must decide explicitly how (and whether) it is detected. */
const CLIENT_DETECTORS: Partial<Record<PluginClient, ClientDetector>> = {
  copilot: cliDetector("copilot"),
  openclaw: cliDetector("openclaw"),
  hermes: cliDetector("hermes"),
  "chatgpt-codex": cliDetector("codex"),
  grok: cliDetector("grok"),
  nanoclaw: cliDetector("ncl"),
  vscode: vscodeDetector,
  cursor: dirDetector("Cursor", (h) => join(h, ".cursor")),
  kiro: dirDetector("Kiro", (h) => join(h, ".kiro")),
  // other: no detection surface — always guidance-only
};

/** Whether the client has a real detector entry (`other` — and any future
 *  guidance-only client — does not: detectPluginClients reports it as
 *  undetected with a synthetic "no detection surface" reason, so callers
 *  that want to distinguish "not detected" from "not detectable" must ask). */
export function clientHasDetector(c: PluginClient): boolean {
  return CLIENT_DETECTORS[c] !== undefined;
}

/** Detect which of the 10 clients is available on this machine. CLI clients
 *  are probed via PATH; GUI clients via their config directory in the user
 *  home; `other` has no detector and always reports guidance-only. */
export function detectPluginClients(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<PluginClient, PluginClientDetection> {
  const out = {} as Record<PluginClient, PluginClientDetection>;
  for (const client of PLUGIN_CLIENTS) {
    const detector = CLIENT_DETECTORS[client];
    out[client] =
      detector === undefined
        ? { detected: false, bin: null, reason: "no detection surface — guidance only" }
        : detector(home, env);
  }
  return out;
}

// ---------------------------------------------------------------- materialize

// .mcp.json: Copilot's native MCP convention (byte-identical to mcp.json,
// build-synced — real-machine finding R4).
const PLUGIN_PACKAGE_FILES = ["plugin.json", "mcp.json", ".mcp.json", "skills"];

export interface MaterializeResult {
  written: string[]; // destination paths written (or that would be written)
  missing: string[];
}

/** Copy the Agent Plugins package files from the package root into the
 *  materialized plugin dir (idempotent overwrite). With dryRun only the
 *  destination list is produced, nothing touches disk. */
export function materializePluginDir(
  srcRoot: string,
  destRoot: string,
  dryRun: boolean,
): MaterializeResult {
  const written: string[] = [];
  const missing: string[] = [];
  for (const rel of PLUGIN_PACKAGE_FILES) {
    const src = join(srcRoot, rel);
    const dest = join(destRoot, rel);
    if (!existsSync(src)) {
      missing.push(src);
      continue;
    }
    written.push(dest);
    if (dryRun) continue;
    mkdirSync(destRoot, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
  }
  return { written, missing };
}

// ---------------------------------------------------------------- copilot

const COPILOT_SETTINGS_FILENAME = "settings.json";
const COPILOT_ENABLED_PLUGINS_KEY = "enabledPlugins";

function copilotSettingsFile(home: string): string {
  return join(home, ".copilot", COPILOT_SETTINGS_FILENAME);
}

function readCopilotSettings(
  file: string,
): { data: Record<string, unknown> } | null {
  const raw = readTextFile(file);
  if (raw === null) return null;
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`not a JSON object: ${file}`);
  }
  return { data };
}

function copilotEntryPresent(data: Record<string, unknown>): boolean {
  const arr = data[COPILOT_ENABLED_PLUGINS_KEY];
  return Array.isArray(arr) && arr.includes(PLUGIN_REPO);
}

function copilotEntryAdded(data: Record<string, unknown>): boolean {
  if (copilotEntryPresent(data)) return false;
  const arr = (data[COPILOT_ENABLED_PLUGINS_KEY] as unknown[] | undefined) ?? [];
  arr.push(PLUGIN_REPO);
  data[COPILOT_ENABLED_PLUGINS_KEY] = arr;
  return true;
}

/** Remove our enabledPlugins entries; returns how many were removed. */
function copilotEntryRemoved(data: Record<string, unknown>): number {
  const arr = data[COPILOT_ENABLED_PLUGINS_KEY];
  if (!Array.isArray(arr)) return 0;
  const kept = arr.filter((e) => !(typeof e === "string" && e.includes(PKG_NAME)));
  const removed = arr.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length) data[COPILOT_ENABLED_PLUGINS_KEY] = kept;
  else delete data[COPILOT_ENABLED_PLUGINS_KEY];
  return removed;
}

/** Fallback when the copilot CLI is unavailable: declarative
 *  `enabledPlugins` entry in ~/.copilot/settings.json. */
function copilotSettingsInstall(opts: PluginClientOptions): PluginClientResult {
  const file = copilotSettingsFile(opts.home);
  const entry = PLUGIN_REPO;
  if (opts.dryRun) {
    return {
      client: "copilot",
      status: "ok",
      detail: `[dry-run] would add "${entry}" to ${COPILOT_ENABLED_PLUGINS_KEY} in ${file} (copilot CLI not found)`,
    };
  }
  try {
    const settings = readCopilotSettings(file);
    if (settings === null) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ [COPILOT_ENABLED_PLUGINS_KEY]: [entry] }, null, 2) + "\n",
        "utf8",
      );
      return {
        client: "copilot",
        status: "ok",
        detail: `wrote ${file} with "${entry}" (copilot CLI not found; restart Copilot to load it)`,
      };
    }
    if (copilotEntryPresent(settings.data)) {
      return {
        client: "copilot",
        status: "ok",
        detail: `already present in ${file} — idempotent, no change`,
      };
    }
    copilotEntryAdded(settings.data);
    const backup = backupFile(file);
    writeFileSync(file, JSON.stringify(settings.data, null, 2) + "\n", "utf8");
    return {
      client: "copilot",
      status: "ok",
      detail: `added "${entry}" to ${file}${backup ? ` (backup: ${backup})` : ""} (copilot CLI not found)`,
    };
  } catch (e) {
    return {
      client: "copilot",
      status: "manual",
      detail: `cannot modify ${file}: ${e instanceof Error ? e.message : String(e)}. Manual: run \`copilot plugin install ${PLUGIN_REPO}\`.`,
    };
  }
}

async function registerCopilot(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) return copilotSettingsInstall(opts);

  const installCmd = `copilot plugin install ${PLUGIN_REPO} && copilot plugin marketplace add ${PLUGIN_REPO}`;
  if (opts.dryRun) {
    return {
      client: "copilot",
      status: "ok",
      detail: `[dry-run] would run: ${installCmd}`,
    };
  }
  const list = await runCmd(bin, ["plugin", "list"], { env: opts.env });
  if (list.code === 0 && list.stdout.includes(PKG_NAME)) {
    return {
      client: "copilot",
      status: "ok",
      detail: `already installed (${bin} plugin list) — idempotent, no change`,
    };
  }
  const install = await runCmd(bin, ["plugin", "install", PLUGIN_REPO], { env: opts.env });
  if (install.code !== 0) {
    return {
      client: "copilot",
      status: "failed",
      detail: `copilot plugin install failed: ${trimErr(install.stderr || install.stdout)}`,
    };
  }
  const marketplace = await runCmd(bin, ["plugin", "marketplace", "add", PLUGIN_REPO], { env: opts.env });
  const extra =
    marketplace.code === 0
      ? "marketplace registered"
      : `marketplace add failed (warning): ${trimErr(marketplace.stderr || marketplace.stdout)}`;
  return {
    client: "copilot",
    status: "ok",
    detail: `installed via ${bin}; ${extra}. Verify with \`copilot plugin list\`.`,
  };
}

async function unregisterCopilot(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const notes: string[] = [];
  if (detection.bin !== null) {
    if (opts.dryRun) {
      notes.push("[dry-run] would run: copilot plugin uninstall deepseek-vl-support");
    } else {
      const r = await runCmd(detection.bin, ["plugin", "uninstall", "deepseek-vl-support"], { env: opts.env });
      notes.push(
        r.code === 0
          ? "uninstalled via copilot CLI"
          : `copilot plugin uninstall failed: ${trimErr(r.stderr || r.stdout)}`,
      );
    }
  } else {
    notes.push("copilot CLI not found (skipping CLI uninstall)");
  }

  const file = copilotSettingsFile(opts.home);
  try {
    const settings = readCopilotSettings(file);
    if (settings === null) {
      notes.push(`no ${file} — nothing to clean`);
    } else {
      const removed = copilotEntryRemoved(settings.data);
      if (removed === 0) {
        notes.push(`no ${PKG_NAME} entries in ${file}`);
      } else if (opts.dryRun) {
        notes.push(`[dry-run] would remove ${removed} enabledPlugins entr(y/ies) from ${file}`);
      } else {
        const backup = backupFile(file);
        writeFileSync(file, JSON.stringify(settings.data, null, 2) + "\n", "utf8");
        notes.push(`removed ${removed} enabledPlugins entr(y/ies) from ${file}${backup ? ` (backup: ${backup})` : ""}`);
      }
    }
  } catch (e) {
    notes.push(`${file} invalid JSON — left untouched`);
  }
  return { client: "copilot", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- cursor

function registerCursor(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): PluginClientResult {
  const dest = join(opts.home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME);
  if (!detection.detected) {
    return {
      client: "cursor",
      status: "manual",
      detail: `Cursor not detected (~/.cursor missing). Manual: copy ${opts.pluginDir} to ${dest} and restart Cursor (Developer: Reload Window).`,
    };
  }
  if (opts.dryRun) {
    return {
      client: "cursor",
      status: "ok",
      detail: `[dry-run] would copy plugin dir to ${dest} and write ${CURSOR_PLUGIN_MARKER_FILE}`,
    };
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(opts.pluginDir, dest, { recursive: true, force: true });
  writeFileSync(join(dest, CURSOR_PLUGIN_MARKER_FILE), `${CURSOR_PLUGIN_MARKER}\n`, "utf8");
  return {
    client: "cursor",
    status: "ok",
    detail: `copied plugin to ${dest}. Restart Cursor or run "Developer: Reload Window" to load it.`,
  };
}

function unregisterCursor(opts: PluginClientOptions): PluginClientResult {
  const dest = join(opts.home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME);
  const marker = join(dest, CURSOR_PLUGIN_MARKER_FILE);
  if (!existsSync(dest)) {
    return { client: "cursor", status: "ok", detail: `not present: ${dest} — nothing to remove` };
  }
  if (!existsSync(marker)) {
    return {
      client: "cursor",
      status: "skipped",
      detail: `${dest} exists without our marker (${CURSOR_PLUGIN_MARKER_FILE}) — user-authored, kept`,
    };
  }
  if (opts.dryRun) {
    return { client: "cursor", status: "ok", detail: `[dry-run] would delete ${dest} (marker present)` };
  }
  rmSync(dest, { recursive: true, force: true });
  return { client: "cursor", status: "ok", detail: `removed ${dest}` };
}

// ---------------------------------------------------------------- vscode

// VS Code loads Agent Plugins from chat.pluginLocations — a JSON map of
// absolute plugin directory paths in the user settings.json. No CLI needed:
// the whole automation surface is a settings write (research:
// vscode-agent-plugins.md). Uninstall removes only entries whose key contains
// our config dir name (".deepseek-vl" — the marker), never user entries; the
// file is backed up to .bak before every modification, like the Copilot
// settings fallback.
const VSCODE_CHAT_KEY = "chat";
const VSCODE_PLUGIN_LOCATIONS_KEY = "pluginLocations";
const VSCODE_USER_DIRS = ["Code", "Code - Insiders"];

/** User settings.json for VS Code, derived from the home dir so the
 *  installer stays hermetic and testable (on Windows homedir() already is
 *  %USERPROFILE%; APPDATA = %USERPROFILE%\AppData\Roaming). Prefers the
 *  stable "Code" dir over "Code - Insiders" when both exist. */
export function vscodeUserSettingsPath(home: string): string {
  const base = process.platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  for (const name of VSCODE_USER_DIRS) {
    const dir = join(base, name, "User");
    if (existsSync(dir)) return join(dir, "settings.json");
  }
  return join(base, "Code", "User", "settings.json");
}

/** Get or create the chat.pluginLocations object (attaches it to `data`
 *  when absent). Returns null when chat/pluginLocations exist with a
 *  non-object type — a user-authored schema violation we never clobber. */
function vscodeLocations(data: Record<string, unknown>): Record<string, unknown> | null {
  const chatRaw = data[VSCODE_CHAT_KEY];
  if (chatRaw !== undefined && (typeof chatRaw !== "object" || Array.isArray(chatRaw))) return null;
  const chat = (chatRaw as Record<string, unknown> | undefined) ?? {};
  const plRaw = chat[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (plRaw !== undefined && (typeof plRaw !== "object" || Array.isArray(plRaw))) return null;
  const pl = (plRaw as Record<string, unknown> | undefined) ?? {};
  chat[VSCODE_PLUGIN_LOCATIONS_KEY] = pl;
  data[VSCODE_CHAT_KEY] = chat;
  return pl;
}

/** Remove our chat.pluginLocations entries (key contains CONFIG_DIR — the
 *  ".deepseek-vl" marker); returns how many were removed. Also drops the
 *  empty chat/pluginLocations containers once nothing is left inside. */
function vscodeLocationsRemoved(data: Record<string, unknown>): number {
  const chat = data[VSCODE_CHAT_KEY];
  if (typeof chat !== "object" || chat === null || Array.isArray(chat)) return 0;
  const chatObj = chat as Record<string, unknown>;
  const pl = chatObj[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (typeof pl !== "object" || pl === null || Array.isArray(pl)) return 0;
  const locations = pl as Record<string, unknown>;
  let removed = 0;
  for (const key of Object.keys(locations)) {
    if (key.includes(CONFIG_DIR)) {
      delete locations[key];
      removed++;
    }
  }
  if (removed === 0) return 0;
  if (Object.keys(locations).length === 0) delete chatObj[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (Object.keys(chatObj).length === 0) delete data[VSCODE_CHAT_KEY];
  return removed;
}

function registerVscode(opts: PluginClientOptions, detection: PluginClientDetection): PluginClientResult {
  const file = vscodeUserSettingsPath(opts.home);
  const dir = opts.pluginDir;
  if (!detection.detected) {
    return {
      client: "vscode",
      status: "manual",
      detail: `VS Code not detected (no \`code\` CLI and no user settings dir). Manual: open the VS Code settings (JSON) and add "chat.pluginLocations": { "${dir}": true }, then reload the window.`,
    };
  }
  if (opts.dryRun) {
    return {
      client: "vscode",
      status: "ok",
      detail: `[dry-run] would set chat.pluginLocations["${dir}"] = true in ${file}`,
    };
  }
  const raw = readTextFile(file);
  if (raw === null) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ chat: { pluginLocations: { [dir]: true } } }, null, 2) + "\n", "utf8");
    return {
      client: "vscode",
      status: "ok",
      detail: `wrote ${file} with chat.pluginLocations["${dir}"] = true (restart VS Code or run "Developer: Reload Window")`,
    };
  }
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) {
      return {
        client: "vscode",
        status: "manual",
        detail: `cannot modify ${file}: not a JSON object. Manual: add "chat.pluginLocations": { "${dir}": true } to your VS Code settings.`,
      };
    }
    const locations = vscodeLocations(data);
    if (locations === null) {
      return {
        client: "vscode",
        status: "manual",
        detail: `cannot modify ${file}: "chat" or "chat.pluginLocations" is not a JSON object — left untouched. Manual: add "chat.pluginLocations": { "${dir}": true } to your VS Code settings.`,
      };
    }
    if (locations[dir] !== undefined) {
      return { client: "vscode", status: "ok", detail: `already present in ${file} — idempotent, no change` };
    }
    locations[dir] = true;
    const backup = backupFile(file);
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    return {
      client: "vscode",
      status: "ok",
      detail: `set chat.pluginLocations["${dir}"] = true in ${file}${backup ? ` (backup: ${backup})` : ""} (restart VS Code or run "Developer: Reload Window")`,
    };
  } catch (e) {
    return {
      client: "vscode",
      status: "manual",
      detail: `cannot modify ${file}: ${e instanceof Error ? e.message : String(e)}. Manual: add "chat.pluginLocations": { "${dir}": true } to your VS Code settings.`,
    };
  }
}

function unregisterVscode(opts: PluginClientOptions): PluginClientResult {
  const file = vscodeUserSettingsPath(opts.home);
  const raw = readTextFile(file);
  if (raw === null) {
    return { client: "vscode", status: "ok", detail: `no ${file} — nothing to clean` };
  }
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) {
      return { client: "vscode", status: "ok", detail: `${file} is not a JSON object — left untouched` };
    }
    const removed = vscodeLocationsRemoved(data);
    if (removed === 0) {
      return { client: "vscode", status: "ok", detail: `no chat.pluginLocations entries for us in ${file}` };
    }
    if (opts.dryRun) {
      return {
        client: "vscode",
        status: "ok",
        detail: `[dry-run] would remove ${removed} chat.pluginLocations entr${removed === 1 ? "y" : "ies"} from ${file}`,
      };
    }
    const backup = backupFile(file);
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    return {
      client: "vscode",
      status: "ok",
      detail: `removed ${removed} chat.pluginLocations entr${removed === 1 ? "y" : "ies"} from ${file}${backup ? ` (backup: ${backup})` : ""}`,
    };
  } catch (e) {
    return { client: "vscode", status: "ok", detail: `${file} invalid JSON — left untouched` };
  }
}

// ---------------------------------------------------------------- chatgpt-codex

// ChatGPT & Codex load the same marketplace model as the codex CLI. Codex
// discovers marketplace manifests under <root>/.agents/plugins/
// marketplace.json (a root-level marketplace.json is NOT read — research:
// chatgpt-codex-plugins.md), so the installer maintains a LOCAL marketplace
// shim OUTSIDE the materialized plugin dir: ~/.deepseek-vl/marketplace/,
// which carries a copy of the plugin. The materialized dir keeps exactly its
// 4 spec entries.
const CODEX_MARKETPLACE_NAME = PKG_NAME;

/** Local marketplace shim root for the codex CLI: ~/.deepseek-vl/marketplace/. */
export function codexMarketplaceDir(home: string): string {
  return join(home, CONFIG_DIR, "marketplace");
}

/** Write the local marketplace shim (manifest + plugin copy) OUTSIDE the
 *  materialized dir. Returns null when dry-running (nothing on disk). */
function writeCodexMarketplaceShim(opts: PluginClientOptions): { manifest: string } | null {
  if (opts.dryRun) return null;
  const root = codexMarketplaceDir(opts.home);
  const manifest = join(root, ".agents", "plugins", "marketplace.json");
  const copyDest = join(root, "plugin");
  mkdirSync(join(manifest, ".."), { recursive: true });
  cpSync(opts.pluginDir, copyDest, { recursive: true, force: true });
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: CODEX_MARKETPLACE_NAME,
        owner: { name: PLUGIN_GITHUB_SLUG.split("/")[0] },
        plugins: [
          {
            name: PKG_NAME,
            source: { source: "local", path: "./plugin" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "development",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { manifest };
}

async function registerChatGptCodex(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  const shimRoot = codexMarketplaceDir(opts.home);
  const pluginRef = `${PKG_NAME}@${CODEX_MARKETPLACE_NAME}`;
  // Write the local marketplace shim BEFORE the CLI check: the manual path
  // (ChatGPT desktop app, no codex CLI) points the user at shimRoot, so the
  // marketplace dir must exist for those instructions to be actionable.
  // Dry-run safe (returns null, writes nothing).
  const shim = writeCodexMarketplaceShim(opts);
  if (bin === null) {
    return {
      client: "chatgpt-codex",
      status: "manual",
      detail:
        `codex CLI not found; marketplace shim written to ${shimRoot}. Manual: in the ChatGPT desktop app (or Codex) add the local marketplace ${shimRoot} and install the "deepseek-vl-support" plugin from it — ` +
        `or run \`codex plugin marketplace add ${shimRoot}\` and \`codex plugin add ${pluginRef}\`.`,
    };
  }
  if (opts.dryRun) {
    return {
      client: "chatgpt-codex",
      status: "ok",
      detail: `[dry-run] would write the local marketplace shim (${shimRoot}/.agents/plugins/marketplace.json + plugin copy) and run: codex plugin marketplace add ${shimRoot} && codex plugin add ${pluginRef}`,
    };
  }
  const list = await runCmd(bin, ["plugin", "list"], { env: opts.env });
  if (list.code === 0 && list.stdout.includes(PKG_NAME)) {
    return {
      client: "chatgpt-codex",
      status: "ok",
      detail: `already installed (${bin} plugin list) — idempotent, no change; marketplace shim refreshed at ${shim?.manifest}`,
    };
  }
  const addMkt = await runCmd(bin, ["plugin", "marketplace", "add", shimRoot], { env: opts.env });
  if (addMkt.code !== 0) {
    return {
      client: "chatgpt-codex",
      status: "failed",
      detail: `codex plugin marketplace add failed: ${trimErr(addMkt.stderr || addMkt.stdout)}. Manual: \`codex plugin marketplace add ${shimRoot}\` then \`codex plugin add ${pluginRef}\`.`,
    };
  }
  const add = await runCmd(bin, ["plugin", "add", pluginRef], { env: opts.env });
  if (add.code !== 0) {
    return {
      client: "chatgpt-codex",
      status: "failed",
      detail: `codex plugin add failed: ${trimErr(add.stderr || add.stdout)}. Manual: \`codex plugin add ${pluginRef}\`.`,
    };
  }
  return {
    client: "chatgpt-codex",
    status: "ok",
    detail: `installed via ${bin} (marketplace ${shimRoot} + ${pluginRef}). Start a new Codex thread (or ChatGPT session) to load the skill and MCP tools.`,
  };
}

async function unregisterChatGptCodex(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const notes: string[] = [];
  const pluginRef = `${PKG_NAME}@${CODEX_MARKETPLACE_NAME}`;
  if (detection.bin === null) {
    notes.push("codex CLI not found (skipping CLI uninstall)");
  } else if (opts.dryRun) {
    notes.push(`[dry-run] would run: codex plugin remove ${pluginRef}`);
  } else {
    const r = await runCmd(detection.bin, ["plugin", "remove", pluginRef], { env: opts.env });
    notes.push(
      r.code === 0
        ? `removed via codex CLI (${pluginRef})`
        : `codex plugin remove failed: ${trimErr(r.stderr || r.stdout)} — remove it in the ChatGPT/Codex plugins UI`,
    );
  }
  notes.push(`marketplace registration + shim (${codexMarketplaceDir(opts.home)}) kept — harmless; re-run install to refresh`);
  return { client: "chatgpt-codex", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- grok

// Grok Bot / Grok Build: the `grok` CLI is the automation surface
// (research: grok-bot-plugins.md). `grok plugin install <dir> --trust` takes
// the materialized dir directly. Guidance notes: our shipped .mcp.json
// matches Grok's dot-prefixed MCP convention, but whether the Grok loader
// ALSO reads the spec mcp.json is unverified — verify with `grok inspect`
// (live-verification caveat, docs/e2e-real-endpoint.md §9.8).
async function registerGrok(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "grok",
      status: "manual",
      detail:
        `grok CLI not found. Manual: copy ${opts.pluginDir} to ~/.grok/plugins/deepseek-vl-support (auto-trusted) and start a new session, ` +
        `or install it with \`grok plugin install ${opts.pluginDir} --trust\`. Our shipped .mcp.json matches Grok's dot-prefixed MCP convention; ` +
        `verify MCP tools with \`grok inspect\` after installing (whether Grok also reads the spec mcp.json is not confirmed).`,
    };
  }
  if (opts.dryRun) {
    return { client: "grok", status: "ok", detail: `[dry-run] would run: grok plugin install ${opts.pluginDir} --trust` };
  }
  const list = await runCmd(bin, ["plugin", "list"], { env: opts.env });
  if (list.code === 0 && list.stdout.includes(PKG_NAME)) {
    return { client: "grok", status: "ok", detail: `already installed (${bin} plugin list) — idempotent, no change` };
  }
  const install = await runCmd(bin, ["plugin", "install", opts.pluginDir, "--trust"], { env: opts.env });
  if (install.code !== 0) {
    return {
      client: "grok",
      status: "failed",
      detail: `grok plugin install failed: ${trimErr(install.stderr || install.stdout)}. Manual: \`grok plugin install ${opts.pluginDir} --trust\`.`,
    };
  }
  return {
    client: "grok",
    status: "ok",
    detail: `installed via ${bin} (trusted). Plugins load after pressing r in the Plugins tab or in a new session; verify MCP tools with \`grok inspect\`.`,
  };
}

async function unregisterGrok(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "grok",
      status: "manual",
      detail: "grok CLI not found. Manual: run `grok plugin uninstall deepseek-vl-support` (or remove ~/.grok/plugins/deepseek-vl-support).",
    };
  }
  if (opts.dryRun) {
    return { client: "grok", status: "ok", detail: "[dry-run] would run: grok plugin uninstall deepseek-vl-support --confirm" };
  }
  const r = await runCmd(bin, ["plugin", "uninstall", "deepseek-vl-support", "--confirm"], { env: opts.env });
  if (r.code === 0) {
    return { client: "grok", status: "ok", detail: "uninstalled via grok CLI" };
  }
  return {
    client: "grok",
    status: "failed",
    detail: `grok plugin uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`grok plugin uninstall deepseek-vl-support\`.`,
  };
}

// ---------------------------------------------------------------- nanoclaw

// NanoClaw stamps plugins as agent "templates" from a local templates dir
// (NANOCLAW_TEMPLATES_DIR, default ~/.deepseek-vl/nanoclaw-templates/) via
// `ncl groups create --template <ref> --name "<name>"`. NanoClaw REJECTS
// symlinks (full-tree lstat walk), so the installer always copies, never
// links. Stamping does not wire a channel; tasks start paused. There is no
// plugin uninstall — removal is manual (delete the stamped group).
// (research: nanoclaw-templates.md)
const NANOCLAW_TEMPLATES_ENV = "NANOCLAW_TEMPLATES_DIR";
const NANOCLAW_GROUP_NAME = "DeepSeek Vision";

function nanoclawTemplatesDir(home: string, env: NodeJS.ProcessEnv): string {
  return env[NANOCLAW_TEMPLATES_ENV] ?? join(home, CONFIG_DIR, "nanoclaw-templates");
}

async function registerNanoClaw(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  const env = opts.env ?? process.env;
  const templatesDir = nanoclawTemplatesDir(opts.home, env);
  const templateDest = join(templatesDir, PKG_NAME);
  const stamp = `ncl groups create --template ${PKG_NAME} --name "${NANOCLAW_GROUP_NAME}"`;
  if (bin === null) {
    return {
      client: "nanoclaw",
      status: "manual",
      detail:
        `ncl CLI not found. Manual: copy ${opts.pluginDir} to ${templateDest} (NanoClaw rejects symlinks — always copy), ` +
        `then stamp it with \`${stamp}\` (set NANOCLAW_TEMPLATES_DIR=${templatesDir} if you keep the template outside your project templates/ dir).`,
    };
  }
  if (opts.dryRun) {
    return {
      client: "nanoclaw",
      status: "ok",
      detail: `[dry-run] would copy the plugin to ${templateDest} and run: ${stamp} (with NANOCLAW_TEMPLATES_DIR=${templatesDir})`,
    };
  }
  mkdirSync(templatesDir, { recursive: true });
  cpSync(opts.pluginDir, templateDest, { recursive: true, force: true });
  const stampEnv = { ...env, [NANOCLAW_TEMPLATES_ENV]: templatesDir };
  const r = await runCmd(bin, ["groups", "create", "--template", PKG_NAME, "--name", NANOCLAW_GROUP_NAME], { env: stampEnv });
  if (r.code !== 0) {
    return {
      client: "nanoclaw",
      status: "failed",
      detail: `ncl groups create failed: ${trimErr(r.stderr || r.stdout)}. Manual: ${stamp}`,
    };
  }
  const extra = env[NANOCLAW_TEMPLATES_ENV]
    ? `template copied to your NANOCLAW_TEMPLATES_DIR (${templatesDir})`
    : `template copied to ${templateDest} — keep NANOCLAW_TEMPLATES_DIR=${templatesDir} set (or move it into your project templates/ dir)`;
  return {
    client: "nanoclaw",
    status: "ok",
    detail: `stamped via ${bin}: ${stamp}. ${extra}. Wire a channel with \`ncl wirings create\`; tasks start paused.`,
  };
}

function unregisterNanoClaw(opts: PluginClientOptions): PluginClientResult {
  return {
    client: "nanoclaw",
    status: "manual",
    detail:
      `NanoClaw has no plugin uninstall. Manual: delete the stamped group in the NanoClaw app (or restamp with \`ncl groups create --template ${PKG_NAME} --yes\` + \`ncl groups restart --id <group-id>\`). ` +
      `The template copy (${join(nanoclawTemplatesDir(opts.home, opts.env ?? process.env), PKG_NAME)}) stays unless you pass --purge-config.`,
  };
}

// ---------------------------------------------------------------- other

// Generic "other spec-compliant agent": materialize + guidance only. The
// portable contract is "a directory with plugin.json at its root" — anything
// a client does beyond that is client-specific (research:
// generic-other-agent.md).
function otherGuidance(pluginDirPath: string): string {
  return (
    `Manual: install the plugin directory (${pluginDirPath}) or the repo (${PLUGIN_REPO}) in your agent per its plugin docs. ` +
    `Enable/trust the plugin if your agent requires it, restart the agent or start a new session, then verify the "deepseek-vision" skill ` +
    `(may appear namespaced, e.g. deepseek-vl-support:deepseek-vision) or the describe_image / vision_status MCP tools. ` +
    `Same standard: agent-plugins.org/specification.`
  );
}

function registerOther(opts: PluginClientOptions): PluginClientResult {
  return { client: "other", status: "manual", detail: otherGuidance(opts.pluginDir) };
}

function unregisterOther(opts: PluginClientOptions): PluginClientResult {
  return {
    client: "other",
    status: "manual",
    detail:
      `Manual: uninstall the plugin in your agent (uninstall plugin / remove marketplace entry / delete the local dir). ` +
      `The materialized dir (${opts.pluginDir}) is kept unless you pass --purge-config.`,
  };
}

// ---------------------------------------------------------------- kiro

function registerKiro(opts: PluginClientOptions): PluginClientResult {
  return {
    client: "kiro",
    status: "manual",
    detail: `Kiro has no CLI automation surface. Manual: Kiro → Powers panel → Add Custom Power → Import power from a folder → select ${opts.pluginDir}.`,
  };
}

function unregisterKiro(opts: PluginClientOptions): PluginClientResult {
  return {
    client: "kiro",
    status: "manual",
    detail: `Manual: Kiro → Powers panel → find the power → remove it (imported from ${opts.pluginDir}).`,
  };
}

// ---------------------------------------------------------------- openclaw

async function registerOpenClaw(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "openclaw",
      status: "manual",
      detail: `OpenClaw CLI not found on PATH. Manual: \`openclaw plugins install ${opts.pluginDir}\` then \`openclaw gateway restart\`.`,
    };
  }
  if (opts.dryRun) {
    return {
      client: "openclaw",
      status: "ok",
      detail: `[dry-run] would run: openclaw plugins install ${opts.pluginDir} && openclaw gateway restart`,
    };
  }
  const list = await runCmd(bin, ["plugins", "list"], { env: opts.env });
  if (list.code === 0 && list.stdout.includes(PKG_NAME)) {
    return {
      client: "openclaw",
      status: "ok",
      detail: `already installed (${bin} plugins list) — idempotent, no change`,
    };
  }
  const install = await runCmd(bin, ["plugins", "install", opts.pluginDir], { env: opts.env });
  if (install.code !== 0) {
    return {
      client: "openclaw",
      status: "failed",
      detail: `openclaw plugins install failed: ${trimErr(install.stderr || install.stdout)}`,
    };
  }
  const restart = await runCmd(bin, ["gateway", "restart"], { env: opts.env });
  const extra =
    restart.code === 0
      ? "gateway restarted"
      : `gateway restart failed (warning): ${trimErr(restart.stderr || restart.stdout)} — run \`openclaw gateway restart\` manually`;
  return {
    client: "openclaw",
    status: "ok",
    detail: `installed via ${bin}; ${extra}. Verify with \`openclaw plugins list\`.`,
  };
}

async function unregisterOpenClaw(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "openclaw",
      status: "manual",
      detail: "OpenClaw CLI not found on PATH. Manual: run `openclaw plugins uninstall deepseek-vl-support`.",
    };
  }
  if (opts.dryRun) {
    return {
      client: "openclaw",
      status: "ok",
      detail: "[dry-run] would run: openclaw plugins uninstall deepseek-vl-support",
    };
  }
  const r = await runCmd(bin, ["plugins", "uninstall", "deepseek-vl-support"], { env: opts.env });
  if (r.code === 0) {
    return { client: "openclaw", status: "ok", detail: "uninstalled via openclaw CLI" };
  }
  return {
    client: "openclaw",
    status: "failed",
    detail: `openclaw plugins uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`openclaw plugins uninstall deepseek-vl-support\`.`,
  };
}

// ---------------------------------------------------------------- hermes

async function registerHermes(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "hermes",
      status: "manual",
      detail: `Hermes CLI not found on PATH. Manual: \`hermes plugins install ${PLUGIN_GITHUB_SLUG} --no-enable\` then \`hermes plugins enable deepseek-vl-support\`.`,
    };
  }
  const commands = [
    `hermes plugins install ${PLUGIN_GITHUB_SLUG} --no-enable`,
    "hermes plugins enable deepseek-vl-support",
  ];
  if (opts.dryRun) {
    return {
      client: "hermes",
      status: "ok",
      detail: `[dry-run] would run: ${commands.join(" && ")}`,
    };
  }
  const list = await runCmd(bin, ["plugins", "list"], { env: opts.env });
  if (list.code === 0 && list.stdout.includes(PKG_NAME)) {
    const enable = await runCmd(bin, ["plugins", "enable", "deepseek-vl-support"], { env: opts.env });
    const extra = enable.code === 0 ? "enabled" : `enable failed (warning): ${trimErr(enable.stderr || enable.stdout)}`;
    return {
      client: "hermes",
      status: "ok",
      detail: `already installed (${bin} plugins list) — re-enabled, ${extra}`,
    };
  }
  const install = await runCmd(bin, ["plugins", "install", PLUGIN_GITHUB_SLUG, "--no-enable"], { env: opts.env });
  if (install.code !== 0) {
    return {
      client: "hermes",
      status: "failed",
      detail: `hermes plugins install failed: ${trimErr(install.stderr || install.stdout)}`,
    };
  }
  const enable = await runCmd(bin, ["plugins", "enable", "deepseek-vl-support"], { env: opts.env });
  const extra =
    enable.code === 0
      ? "enabled"
      : `enable failed (warning): ${trimErr(enable.stderr || enable.stdout)} — run \`hermes plugins enable deepseek-vl-support\` manually`;
  return {
    client: "hermes",
    status: "ok",
    detail: `installed via ${bin}; ${extra}. Verify with \`hermes plugins list\`.`,
  };
}

async function unregisterHermes(
  opts: PluginClientOptions,
  detection: PluginClientDetection,
): Promise<PluginClientResult> {
  const bin = detection.bin;
  if (bin === null) {
    return {
      client: "hermes",
      status: "manual",
      detail: "Hermes CLI not found on PATH. Manual: run `hermes plugins uninstall deepseek-vl-support`.",
    };
  }
  if (opts.dryRun) {
    return {
      client: "hermes",
      status: "ok",
      detail: "[dry-run] would run: hermes plugins uninstall deepseek-vl-support",
    };
  }
  const r = await runCmd(bin, ["plugins", "uninstall", "deepseek-vl-support"], { env: opts.env });
  if (r.code === 0) {
    return { client: "hermes", status: "ok", detail: "uninstalled via hermes CLI" };
  }
  return {
    client: "hermes",
    status: "failed",
    detail: `hermes plugins uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`hermes plugins uninstall deepseek-vl-support\`.`,
  };
}

// ---------------------------------------------------------------- drivers

type RegisterDriver = (o: PluginClientOptions, d: PluginClientDetection) => Promise<PluginClientResult>;
type UnregisterDriver = (o: PluginClientOptions, d: PluginClientDetection) => Promise<PluginClientResult>;

const REGISTERS: Record<PluginClient, RegisterDriver> = {
  copilot: registerCopilot,
  cursor: async (o, d) => registerCursor(o, d),
  kiro: async (o) => registerKiro(o),
  openclaw: registerOpenClaw,
  hermes: registerHermes,
  vscode: async (o, d) => registerVscode(o, d),
  "chatgpt-codex": registerChatGptCodex,
  grok: registerGrok,
  nanoclaw: registerNanoClaw,
  other: async (o) => registerOther(o),
};

const UNREGISTERS: Record<PluginClient, UnregisterDriver> = {
  copilot: unregisterCopilot,
  cursor: async (o) => unregisterCursor(o),
  kiro: async (o) => unregisterKiro(o),
  openclaw: unregisterOpenClaw,
  hermes: unregisterHermes,
  vscode: async (o) => unregisterVscode(o),
  "chatgpt-codex": unregisterChatGptCodex,
  grok: unregisterGrok,
  nanoclaw: async (o) => unregisterNanoClaw(o),
  other: async (o) => unregisterOther(o),
};

// Module-load completeness assertion: every plugin client MUST have a
// register and an unregister driver (or an explicit manual/guidance driver,
// like kiro/other). Runs once at import time so a new client without
// drivers fails loudly at startup, never as a silent "undefined is not a
// function" inside runPerClient.
for (const client of PLUGIN_CLIENTS) {
  if (!(client in REGISTERS)) {
    throw new Error(`installer bug: no register driver for plugin client "${client}"`);
  }
  if (!(client in UNREGISTERS)) {
    throw new Error(`installer bug: no unregister driver for plugin client "${client}"`);
  }
}

async function runPerClient(
  table: Record<PluginClient, RegisterDriver | UnregisterDriver>,
  opts: PluginClientOptions,
  detection: Record<PluginClient, PluginClientDetection>,
): Promise<PluginClientResult[]> {
  const clients = opts.clients ?? [...PLUGIN_CLIENTS];
  const results: PluginClientResult[] = [];
  for (const client of clients) {
    const driver = table[client];
    if (driver === undefined) {
      // unreachable after the module-load assertion; kept loud anyway
      results.push({
        client,
        status: "failed",
        detail: `no driver registered for plugin client "${client}" (installer bug)`,
      });
      continue;
    }
    try {
      results.push(await driver(opts, detection[client]));
    } catch (e) {
      results.push({
        client,
        status: "failed",
        detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

export async function installPluginClients(
  opts: PluginClientOptions,
  detection: Record<PluginClient, PluginClientDetection>,
): Promise<PluginClientResult[]> {
  return runPerClient(REGISTERS, opts, detection);
}

export async function uninstallPluginClients(
  opts: PluginClientOptions,
  detection: Record<PluginClient, PluginClientDetection>,
): Promise<PluginClientResult[]> {
  return runPerClient(UNREGISTERS, opts, detection);
}

/** Materialized plugin dir: ~/.deepseek-vl/plugin/. */
export function pluginDir(home: string = homedir()): string {
  return join(home, CONFIG_DIR, PLUGIN_DIRNAME);
}
