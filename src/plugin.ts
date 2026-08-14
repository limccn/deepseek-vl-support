// Agent Plugins portable package support (install --target plugin):
// materializes the plugin directory (~/.deepseek-vl/plugin/) from the
// package root and registers/unregisters it for GitHub Copilot, Cursor,
// Kiro, OpenClaw, and Hermes Agent.
//
// Safety rules (same as the rest of the installer):
//  - external commands are only run when not dry-running; every failure is
//    captured into the per-client result and never blocks other clients
//  - file writes (Cursor copy, Copilot settings.json fallback) are backed
//    up / marker-checked exactly like the Claude/Codex installers
//  - Kiro has no CLI automation surface: it always gets precise guidance.
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

export type PluginClient = "copilot" | "cursor" | "kiro" | "openclaw" | "hermes";

export const PLUGIN_CLIENTS: readonly PluginClient[] = [
  "copilot",
  "cursor",
  "kiro",
  "openclaw",
  "hermes",
];

export const PLUGIN_CLIENT_LABELS: Record<PluginClient, string> = {
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  kiro: "Kiro",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
};

const CLI_BINS: Partial<Record<PluginClient, string>> = {
  copilot: "copilot",
  openclaw: "openclaw",
  hermes: "hermes",
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

/** Resolve a bare executable name against PATH (Windows tries .cmd/.exe). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
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

/** Detect which of the 5 clients is available on this machine. CLI clients
 *  (copilot/openclaw/hermes) are probed via PATH; GUI clients (cursor/kiro)
 *  via their config directory in the user home. */
export function detectPluginClients(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<PluginClient, PluginClientDetection> {
  const out = {} as Record<PluginClient, PluginClientDetection>;
  for (const client of PLUGIN_CLIENTS) {
    const binName = CLI_BINS[client];
    if (binName !== undefined) {
      const bin = findOnPath(binName, env);
      out[client] = {
        detected: bin !== null,
        bin,
        reason: bin ? `found ${bin}` : `${binName} not found on PATH`,
      };
    } else {
      const dir = client === "cursor" ? join(home, ".cursor") : join(home, ".kiro");
      const found = existsSync(dir);
      out[client] = {
        detected: found,
        bin: null,
        reason: found ? `found ${dir}` : `${dir} not found`,
      };
    }
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

const REGISTERS: Record<PluginClient, (o: PluginClientOptions, d: PluginClientDetection) => Promise<PluginClientResult>> = {
  copilot: registerCopilot,
  cursor: async (o, d) => registerCursor(o, d),
  kiro: async (o) => registerKiro(o),
  openclaw: registerOpenClaw,
  hermes: registerHermes,
};

const UNREGISTERS: Record<PluginClient, (o: PluginClientOptions, d: PluginClientDetection) => Promise<PluginClientResult>> = {
  copilot: unregisterCopilot,
  cursor: async (o) => unregisterCursor(o),
  kiro: async (o) => unregisterKiro(o),
  openclaw: unregisterOpenClaw,
  hermes: unregisterHermes,
};

async function runPerClient(
  table: Record<PluginClient, (o: PluginClientOptions, d: PluginClientDetection) => Promise<PluginClientResult>>,
  opts: PluginClientOptions,
  detection: Record<PluginClient, PluginClientDetection>,
): Promise<PluginClientResult[]> {
  const clients = opts.clients ?? [...PLUGIN_CLIENTS];
  const results: PluginClientResult[] = [];
  for (const client of PLUGIN_CLIENTS) {
    if (!clients.includes(client)) {
      results.push({ client, status: "skipped", detail: "not requested (--clients)" });
      continue;
    }
    try {
      results.push(await table[client](opts, detection[client]));
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
