// CLI-agent integration support (install --target <agent list>): five agents
// that read Agent Skills / MCP configs natively but do NOT implement the
// Agent Plugins open standard, each integrated via its own native mechanism
// (research: qwen-code.md, reasonix.md, kilo-code.md, workbuddy.md, devin.md):
//   - qwen       (native kind): skill copied to .qwen/skills/ (it does not
//                 read .agents/skills/); mcpServers + PreToolUse hook written
//                 to .qwen/settings.json (JSONC) with hook.cjs copied to
//                 .qwen/hooks/
//   - reasonix   (native kind): shared .agents/skills/ skill (project) /
//                 ~/.agents/skills/ (global); project .mcp.json entry; global
//                 MCP via a managed [[plugins]] block in config.toml; hook in
//                 settings.json (project .reasonix/ or the Reasonix home)
//   - kilo       (native kind): shared .agents/skills/ skill; mcp entry in
//                 .kilo/kilo.json (project) / ~/.config/kilo/kilo.json(c)
//   - workbuddy  (native kind): skill copied to .codebuddy/skills/ (it does
//                 not read .agents/skills/); mcpServers entry in project
//                 .mcp.json (JSONC) / ~/.codebuddy/.mcp.json (global)
//   - devin      (native kind): shared .agents/skills/ skill; mcpServers
//                 entry in .devin/mcp_config.json (project) / the Devin
//                 config dir (global)
//
// Safety rules (same as skillagents.ts / plugin.ts / install.ts):
//  - JSON config files are deep-merged (foreign keys never touched), backed
//    up to `<file>.bak` before the first modification, and unparseable /
//    JSONC-commented files are left untouched and reported as manual with
//    precise guidance
//  - skill copies and hook.cjs copies carry the SKILL_MARKER / HOOK_MARKER so
//    uninstall can tell ours from user-authored files; the shared
//    .agents/skills/ tree is NEVER deleted here (only codex removes it)
//  - a failing agent never blocks the others (per-agent try/catch)
//  - hook tool-name matching (matcher "Read") follows the Claude schema and
//    is pending real-machine verification — a silent no-op is harmless, the
//    skill + MCP main channels are unaffected
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFile, readTextFile } from "./codex.ts";
import { hookEntriesAdded, hookEntriesRemoved } from "./hooksettings.ts";
import type { SettingsFile } from "./hooksettings.ts";
import {
  HOOK_FILENAME,
  HOOK_MARKER,
  MCP_SERVER_NAME,
  PKG_NAME,
  SKILL_DIRNAME,
  SKILL_MARKER,
} from "./identity.ts";
import { packagedHookPath } from "./paths.ts";
import { findOnPath } from "./plugin.ts";
import {
  jsonEntryAdded,
  jsonEntryRemoved,
  readJsonConfig,
  removeSkillTree,
  writeSharedAgentsSkill,
  writeSkillTree,
} from "./skillagents.ts";

/** The five CLI-agent integrations handled by this module. */
export type CliAgent = "qwen" | "reasonix" | "kilo" | "workbuddy" | "devin";

export const CLI_AGENTS: readonly CliAgent[] = ["qwen", "reasonix", "kilo", "workbuddy", "devin"];

// ---------------------------------------------------------------- detection

export interface CliAgentDetection {
  detected: boolean;
  bin: string | null; // resolved executable path (CLI agents only)
  reason: string;
}

type CliDetector = (home: string, env: NodeJS.ProcessEnv) => CliAgentDetection;

/** Platform home dirs. Reasonix stores its user config at %APPDATA%\reasonix
 *  on Windows and ~/.reasonix elsewhere; Devin at %APPDATA%\devin on Windows
 *  and ~/.config/devin elsewhere (research: reasonix.md, devin.md). */
export function reasonixHome(home: string): string {
  return process.platform === "win32" ? join(home, "AppData", "Roaming", "reasonix") : join(home, ".reasonix");
}

export function devinHome(home: string): string {
  return process.platform === "win32" ? join(home, "AppData", "Roaming", "devin") : join(home, ".config", "devin");
}

/** CLI-first detector with config-dir fallbacks (first existing dir wins). */
function cliOrDirDetector(bins: string[], label: string, dirsOf: (home: string) => string[]): CliDetector {
  return (home, env) => {
    for (const binName of bins) {
      const bin = findOnPath(binName, env);
      if (bin !== null) return { detected: true, bin, reason: `found ${bin}` };
    }
    for (const dir of dirsOf(home)) {
      if (existsSync(dir)) return { detected: true, bin: null, reason: `found ${dir}` };
    }
    const dirList = dirsOf(home).join(", ");
    return { detected: false, bin: null, reason: `${label} not on PATH and no ${dirList}` };
  };
}

const CLI_DETECTORS: Record<CliAgent, CliDetector> = {
  qwen: cliOrDirDetector(["qwen", "qwen-code"], "Qwen Code", (h) => [join(h, ".qwen")]),
  reasonix: cliOrDirDetector(["reasonix"], "Reasonix", (h) => [reasonixHome(h)]),
  kilo: cliOrDirDetector(
    ["kilo"],
    "Kilo Code",
    (h) => [join(h, ".config", "kilo"), join(h, ".kilo"), join(h, ".kilocode")],
  ),
  workbuddy: cliOrDirDetector(
    ["codebuddy", "cbc", "codebuddy-code"],
    "WorkBuddy",
    (h) => [join(h, ".codebuddy")],
  ),
  devin: cliOrDirDetector(["devin"], "Devin", (h) => [devinHome(h)]),
};

/** Install hints for the "was not detected — install it first" warning. */
export const CLI_NOT_DETECTED_HINTS: Record<CliAgent, string> = {
  qwen: "npm i -g @qwen-code/qwen-code",
  reasonix: "npm i -g reasonix",
  kilo: "npm i -g @kilocode/cli",
  workbuddy: "npm i -g @tencent-ai/codebuddy-code",
  devin: "the Devin CLI — https://devin.ai/download (no official npm package)",
};

/** Detect which of the five CLI agents is available on this machine
 *  (PATH probe first, then config-dir fallback). */
export function detectCliAgents(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<CliAgent, CliAgentDetection> {
  const out = {} as Record<CliAgent, CliAgentDetection>;
  for (const agent of CLI_AGENTS) out[agent] = CLI_DETECTORS[agent](home, env);
  return out;
}

// ---------------------------------------------------------------- results

export type CliAgentStatus = "ok" | "skipped" | "failed" | "manual";

export interface CliAgentResult {
  agent: CliAgent;
  status: CliAgentStatus;
  detail: string;
}

export interface CliAgentOptions {
  cwd: string;
  home: string;
  /** Scope of the install: global writes to the user config dirs, project
   *  writes to <cwd>. Both scopes are supported for all five agents. */
  global?: boolean;
  update?: boolean;
  dryRun?: boolean;
  /** Keep/overwrite answer from the install wizard (R4): passed through to
   *  the skill-tree writes (qwen/workbuddy via writeSkillTree,
   *  reasonix/kilo/devin via writeSharedAgentsSkill); undefined keeps the
   *  legacy marker/update rules. */
  skillAction?: "keep" | "overwrite";
  env?: NodeJS.ProcessEnv;
  agents?: CliAgent[];
  log?: (msg: string) => void;
  warnings?: string[];
}

// ---------------------------------------------------------------- file helpers

/** Mirror of install.ts's writeManagedFile / skillagents.ts's writeManagedFile:
 *  never overwrite a user-authored file that lacks our marker, keep managed
 *  files without --update, dry-run prints instead of writing. */
function writeMarkedFile(
  target: string,
  content: string,
  opts: { update?: boolean; dryRun?: boolean; marker: string },
  log: (msg: string) => void,
  warnings: string[],
): void {
  if (existsSync(target)) {
    const existing = readTextFile(target) ?? "";
    if (!existing.includes(opts.marker)) {
      warnings.push(`skip ${target}: exists without our marker (user-authored).`);
      return;
    }
    if (!opts.update) {
      log(`exists (managed) — keep, use --update to refresh.`);
      return;
    }
  }
  if (opts.dryRun) {
    log(`[dry-run] would write ${target}`);
    return;
  }
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
  log(`wrote ${target}`);
}

/** Remove one managed file (marker-checked); user-authored content is kept
 *  and reported. Returns how many files were removed (0 or 1). */
function removeMarkedFile(target: string, marker: string, opts: { dryRun?: boolean }, notes: string[]): number {
  if (!existsSync(target)) return 0;
  const content = readTextFile(target) ?? "";
  if (!content.includes(marker)) {
    notes.push(`${target} exists without our marker (user-authored) — kept`);
    return 0;
  }
  if (opts.dryRun) {
    notes.push(`[dry-run] would delete ${target}`);
  } else {
    rmSync(target, { force: true });
    notes.push(`deleted ${target}`);
  }
  return 1;
}

/** Copy the packaged hook bundle (dist/hook.cjs) into the given hooks dir
 *  (marker-checked). Returns the hook file path, or null when the packaged
 *  source is missing (callers skip the settings hook entry then). */
function writeHookBundle(
  hooksDir: string,
  opts: { update?: boolean; dryRun?: boolean },
  log: (msg: string) => void,
  warnings: string[],
): string | null {
  const source = readTextFile(packagedHookPath());
  if (source === null) {
    warnings.push(`missing ${packagedHookPath()} — run \`npm run build\` first (skipping hook write)`);
    return null;
  }
  const hookFile = join(hooksDir, HOOK_FILENAME);
  writeMarkedFile(hookFile, source, { update: opts.update, dryRun: opts.dryRun, marker: HOOK_MARKER }, log, warnings);
  return hookFile;
}

/** Hook command string with an absolute path (the JSONC settings files of
 *  Qwen/Reasonix are resolved by the agent from any working directory). */
function hookCommandFor(hookFile: string): string {
  return `node "${hookFile}"`;
}

/** Shared .agents/skills/deepseek-vision/ write for global scope: the
 *  skillagents helper skips global (it is the project-level convention), but
 *  the five CLI agents officially read the user-level ~/.agents/skills/
 *  (research: reasonix/kilo/devin). Delegates to writeSkillTree so the
 *  wizard's keep/overwrite answer and the per-file dry-run logs apply here
 *  exactly like every other skill tree. */
function writeGlobalSharedSkill(opts: CliAgentOptions, log: (msg: string) => void): void {
  writeSkillTree(join(opts.home, ".agents", "skills", SKILL_DIRNAME), opts, log, opts.warnings ?? []);
}

/** Default npx MCP entry (mcpServers shape). */
function npxMcpEntry(): Record<string, unknown> {
  return { command: "npx", args: ["-y", PKG_NAME, "mcp"] };
}

// ---------------------------------------------------------------- toml block

const TOML_START = `# ${PKG_NAME}:start`;
const TOML_END = `# ${PKG_NAME}:end`;

/** The managed [[plugins]] block written into the Reasonix config.toml. */
function reasonixTomlBlock(): string {
  return [
    TOML_START,
    "[[plugins]]",
    `name = ${JSON.stringify(MCP_SERVER_NAME)}`,
    'type = "stdio"',
    `command = ${JSON.stringify("npx")}`,
    `args = [${["-y", PKG_NAME, "mcp"].map((a) => JSON.stringify(a)).join(", ")}]`,
    TOML_END,
    "",
  ].join("\n");
}

/** Upsert the managed block into a TOML file: update it between the start/end
 *  markers when present, otherwise append at the end (the file is created if
 *  missing). Returns "added" / "present" / "manual" — manual when only one
 *  marker line exists (broken managed block; never clobbered). */
function tomlBlockUpsert(
  file: string,
  block: string,
  opts: { dryRun?: boolean },
  log: (msg: string) => void,
): "added" | "present" | "manual" {
  const raw = readTextFile(file);
  if (raw === null) {
    if (!opts.dryRun) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, block, "utf8");
    }
    return "added";
  }
  const startAt = raw.indexOf(TOML_START);
  const endAt = raw.indexOf(TOML_END);
  if (startAt !== -1 || endAt !== -1) {
    if (startAt === -1 || endAt === -1 || endAt < startAt) return "manual";
    if (raw.slice(startAt, endAt + TOML_END.length) === block.trimEnd()) return "present";
    if (opts.dryRun) return "added";
    const backup = backupFile(file);
    const updated = raw.slice(0, startAt) + block.trimEnd() + raw.slice(endAt + TOML_END.length);
    writeFileSync(file, updated, "utf8");
    log(`updated ${file}${backup ? ` (backup: ${backup})` : ""}`);
    return "added";
  }
  if (opts.dryRun) return "added";
  const backup = backupFile(file);
  const updated = raw.replace(/\s*$/, "\n") + block;
  writeFileSync(file, updated, "utf8");
  log(`appended to ${file}${backup ? ` (backup: ${backup})` : ""}`);
  return "added";
}

/** Remove the managed block from a TOML file; returns how many blocks were
 *  removed (0 or 1). */
function tomlBlockRemove(file: string, opts: { dryRun?: boolean }, notes: string[]): number {
  const raw = readTextFile(file);
  if (raw === null) return 0;
  const startAt = raw.indexOf(TOML_START);
  const endAt = raw.indexOf(TOML_END);
  if (startAt === -1 && endAt === -1) return 0;
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    notes.push(`${file} has a partial managed block (missing a marker line) — left untouched`);
    return 0;
  }
  if (opts.dryRun) {
    notes.push(`[dry-run] would remove the managed [[plugins]] block from ${file}`);
    return 1;
  }
  const backup = backupFile(file);
  const before = raw.slice(0, startAt).replace(/[ \t]*\r?\n[ \t]*$/, "");
  const after = raw.slice(endAt + TOML_END.length).replace(/^\r?\n/, "");
  writeFileSync(file, `${before}${after ? "\n" + after : ""}`, "utf8");
  notes.push(`removed the managed [[plugins]] block from ${file}${backup ? ` (backup: ${backup})` : ""}`);
  return 1;
}

// ---------------------------------------------------------------- shared notes

/** Uninstall ownership rule: the shared .agents/skills tree is kept (only
 *  `uninstall --target codex` removes it). */
const SHARED_KEEP_NOTE =
  `shared .agents/skills/deepseek-vision/ kept (may be used by other agents) — ` +
  `remove with \`uninstall --target codex\` or delete the directory.`;

/** Project .mcp.json is shared by reasonix/workbuddy (and Copilot reads the
 *  same file) — any of them uninstalling removes the entry. */
const MCP_JSON_SHARED_NOTE =
  `project .mcp.json is shared (Reasonix/Copilot/CodeBuddy read it) — the deepseek-vl ` +
  `entry was removed; other agents lose it until reinstalled.`;

// ---------------------------------------------------------------- qwen

/** Qwen settings.json lives in .qwen/ (project) or ~/.qwen/ (global). The
 *  file is JSONC (official support) — commented files are reported as manual
 *  and never rewritten. */
function qwenSettingsFile(cwd: string, home: string, global?: boolean): string {
  return join(global ? join(home, ".qwen") : join(cwd, ".qwen"), "settings.json");
}

function registerQwen(opts: CliAgentOptions, detection: CliAgentDetection): CliAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const root = opts.global ? join(opts.home, ".qwen") : join(opts.cwd, ".qwen");
  const settingsFile = qwenSettingsFile(opts.cwd, opts.home, opts.global);
  const hooksDir = join(root, "hooks");
  const notDetected = detection.detected ? "" : `Qwen Code not detected — install it first (${CLI_NOT_DETECTED_HINTS.qwen}). `;

  // 1) skill tree (.qwen/skills/ — Qwen does not read .agents/skills/)
  writeSkillTree(join(root, "skills", SKILL_DIRNAME), opts, log, warnings);

  // 2) hook.cjs bundle (.qwen/hooks/)
  const hookFile = writeHookBundle(hooksDir, opts, log, warnings);

  // 3) settings.json deep-merge: mcpServers + PreToolUse hook (JSONC → manual)
  const loaded = readJsonConfig(settingsFile);
  if ("manual" in loaded) {
    return {
      agent: "qwen",
      status: "manual",
      detail:
        notDetected +
        `cannot modify ${settingsFile}: ${loaded.manual}. ` +
        `Manual: add "mcpServers": { "${MCP_SERVER_NAME}": { "command": "npx", "args": ["-y", "${PKG_NAME}", "mcp"] } } ` +
        `and a PreToolUse hook with matcher "Read" running \`node "${join(hooksDir, HOOK_FILENAME)}"\` ` +
        `(or run \`qwen mcp add ${MCP_SERVER_NAME} -- npx -y ${PKG_NAME} mcp\`), then restart Qwen.`,
    };
  }
  let detail: string;
  const hookEntryCommand = hookFile === null ? null : hookCommandFor(hookFile);
  if ("missing" in loaded) {
    const data: Record<string, unknown> = { mcpServers: { [MCP_SERVER_NAME]: npxMcpEntry() } };
    if (hookEntryCommand !== null) {
      const sf: SettingsFile = { file: settingsFile, data };
      hookEntriesAdded(sf, "PreToolUse", hookEntryCommand, hookEntryCommand);
    }
    if (opts.dryRun) {
      detail = `[dry-run] would create ${settingsFile} with mcpServers + PreToolUse hook`;
    } else {
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
      detail = `wrote ${settingsFile} with mcpServers["${MCP_SERVER_NAME}"] and a PreToolUse Read hook`;
    }
  } else {
    const mcpState = jsonEntryAdded(loaded.data, "mcpServers", npxMcpEntry());
    if (mcpState === "invalid") {
      return {
        agent: "qwen",
        status: "manual",
        detail: `cannot modify ${settingsFile}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": … } to ${settingsFile}.`,
      };
    }
    let hookAdded = false;
    if (hookEntryCommand !== null) {
      const sf: SettingsFile = { file: settingsFile, data: loaded.data };
      hookAdded = hookEntriesAdded(sf, "PreToolUse", hookEntryCommand, hookEntryCommand);
    }
    if (mcpState === "present" && !hookAdded) {
      detail = `mcpServers + hooks already present in ${settingsFile} — idempotent, no change`;
    } else if (opts.dryRun) {
      detail = `[dry-run] would merge mcpServers + PreToolUse hook into ${settingsFile}`;
    } else {
      const backup = backupFile(settingsFile);
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      detail = `merged mcpServers + PreToolUse hook into ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`;
    }
  }
  return {
    agent: "qwen",
    status: "ok",
    detail:
      notDetected +
      detail +
      ` (${opts.global ? "global" : "project"} scope). Restart Qwen for changes to take effect. ` +
      `Hook tool-name matching (matcher "Read") is pending real-machine verification.`,
  };
}

function uninstallQwen(opts: CliAgentOptions): CliAgentResult {
  const notes: string[] = [];
  const root = opts.global ? join(opts.home, ".qwen") : join(opts.cwd, ".qwen");
  const settingsFile = qwenSettingsFile(opts.cwd, opts.home, opts.global);
  const loaded = readJsonConfig(settingsFile);
  if ("missing" in loaded) {
    notes.push(`no ${settingsFile} — nothing to clean`);
  } else if ("manual" in loaded) {
    notes.push(loaded.manual);
  } else {
    const removedMcp = jsonEntryRemoved(loaded.data, "mcpServers");
    const sf: SettingsFile = { file: settingsFile, data: loaded.data };
    const removedHooks = hookEntriesRemoved(sf);
    if (removedMcp === 0 && removedHooks === 0) {
      notes.push(`no mcpServers/hooks entries for us in ${settingsFile}`);
    } else if (opts.dryRun) {
      notes.push(`[dry-run] would remove our mcpServers/hooks entries from ${settingsFile}`);
    } else {
      const backup = backupFile(settingsFile);
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      notes.push(`removed our entries from ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`);
    }
  }
  removeMarkedFile(join(root, "hooks", HOOK_FILENAME), HOOK_MARKER, opts, notes);
  removeSkillTree(join(root, "skills", SKILL_DIRNAME), opts, notes);
  if (!notes.length) notes.push(`not present: ${root} — nothing to remove`);
  return { agent: "qwen", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- reasonix

/** Project-scope .mcp.json (Claude Code format, shared with workbuddy /
 *  Copilot / CodeBuddy) — deep-merged with a backup, JSONC → manual. */
function projectMcpJson(cwd: string): string {
  return join(cwd, ".mcp.json");
}

function reasonixSettingsFile(cwd: string, home: string, global?: boolean): string {
  return join(global ? reasonixHome(home) : join(cwd, ".reasonix"), "settings.json");
}

function registerReasonix(opts: CliAgentOptions, detection: CliAgentDetection): CliAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const notDetected = detection.detected ? "" : `Reasonix not detected — install it first (${CLI_NOT_DETECTED_HINTS.reasonix}). `;

  // 1) shared skill (project .agents/skills/ or global ~/.agents/skills/)
  if (opts.global) writeGlobalSharedSkill(opts, log);
  else writeSharedAgentsSkill(opts.cwd, opts, { warnings }, log);

  // 2) MCP: project .mcp.json entry or a global config.toml [[plugins]] block
  // 3) hook: settings.json (project .reasonix/ or the Reasonix home)
  const hookDir = opts.global ? reasonixHome(opts.home) : join(opts.cwd, ".reasonix");
  const hookFile = writeHookBundle(join(hookDir, "hooks"), opts, log, warnings);
  const hookEntryCommand = hookFile === null ? null : hookCommandFor(hookFile);

  const details: string[] = [];
  if (opts.global) {
    const toml = join(reasonixHome(opts.home), "config.toml");
    const state = tomlBlockUpsert(toml, reasonixTomlBlock(), opts, log);
    details.push(
      state === "present"
        ? `config.toml already has our [[plugins]] block — idempotent, no change`
        : state === "manual"
          ? `cannot modify ${toml}: partial managed block (missing a marker line) — left untouched`
          : `managed [[plugins]] block upserted in ${toml}`,
    );
  } else {
    const file = projectMcpJson(opts.cwd);
    const loaded = readJsonConfig(file);
    if ("manual" in loaded) {
      return {
        agent: "reasonix",
        status: "manual",
        detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": { "command": "npx", "args": ["-y", "${PKG_NAME}", "mcp"] } } to ${file}.`,
      };
    }
    if ("missing" in loaded) {
      if (opts.dryRun) {
        details.push(`[dry-run] would create ${file} with mcpServers["${MCP_SERVER_NAME}"]`);
      } else {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: npxMcpEntry() } }, null, 2) + "\n", "utf8");
        details.push(`wrote mcpServers["${MCP_SERVER_NAME}"] to ${file} (shared with Copilot/CodeBuddy)`);
      }
    } else {
      const state = jsonEntryAdded(loaded.data, "mcpServers", npxMcpEntry());
      if (state === "invalid") {
        return {
          agent: "reasonix",
          status: "manual",
          detail: `cannot modify ${file}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": … } to ${file}.`,
        };
      }
      if (state === "present") {
        details.push(`mcpServers["${MCP_SERVER_NAME}"] already present in ${file} — idempotent, no change`);
      } else if (opts.dryRun) {
        details.push(`[dry-run] would add mcpServers["${MCP_SERVER_NAME}"] to ${file}`);
      } else {
        const backup = backupFile(file);
        writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
        details.push(`added mcpServers["${MCP_SERVER_NAME}"] to ${file} (shared with Copilot/CodeBuddy)${backup ? ` (backup: ${backup})` : ""}`);
      }
    }
  }

  const settingsFile = reasonixSettingsFile(opts.cwd, opts.home, opts.global);
  const loadedSettings = readJsonConfig(settingsFile);
  if ("manual" in loadedSettings) {
    return {
      agent: "reasonix",
      status: "manual",
      detail: `cannot modify ${settingsFile}: ${loadedSettings.manual}. Manual: add a PreToolUse hook with matcher "Read" running \`node "${join(hookDir, "hooks", HOOK_FILENAME)}"\` to ${settingsFile}.`,
    };
  }
  if (hookEntryCommand !== null) {
    if ("missing" in loadedSettings) {
      if (!opts.dryRun) {
        const data: Record<string, unknown> = {};
        const sf: SettingsFile = { file: settingsFile, data };
        hookEntriesAdded(sf, "PreToolUse", hookEntryCommand, hookEntryCommand);
        mkdirSync(join(settingsFile, ".."), { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
        details.push(`wrote PreToolUse hook to ${settingsFile}`);
      } else {
        details.push(`[dry-run] would create ${settingsFile} with the PreToolUse hook`);
      }
    } else {
      const sf: SettingsFile = { file: settingsFile, data: loadedSettings.data };
      const added = hookEntriesAdded(sf, "PreToolUse", hookEntryCommand, hookEntryCommand);
      if (added) {
        if (!opts.dryRun) {
          const backup = backupFile(settingsFile);
          mkdirSync(join(settingsFile, ".."), { recursive: true });
          writeFileSync(settingsFile, JSON.stringify(loadedSettings.data, null, 2) + "\n", "utf8");
          details.push(`merged PreToolUse hook into ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`);
        } else {
          details.push(`[dry-run] would merge the PreToolUse hook into ${settingsFile}`);
        }
      } else {
        details.push(`PreToolUse hook already present in ${settingsFile} — idempotent, no change`);
      }
    }
  }
  return {
    agent: "reasonix",
    status: "ok",
    detail:
      notDetected +
      details.join("; ") +
      ` (${opts.global ? "global" : "project"} scope). Restart Reasonix for changes to take effect. ` +
      `Hook tool-name matching (matcher "Read") is pending real-machine verification. ` +
      `If your project also has a reasonix.toml with the same plugin, reasonix.toml wins.`,
  };
}

function uninstallReasonix(opts: CliAgentOptions): CliAgentResult {
  const notes: string[] = [];
  const settingsFile = reasonixSettingsFile(opts.cwd, opts.home, opts.global);
  const loaded = readJsonConfig(settingsFile);
  if ("missing" in loaded) {
    notes.push(`no ${settingsFile} — nothing to clean`);
  } else if ("manual" in loaded) {
    notes.push(loaded.manual);
  } else {
    const sf: SettingsFile = { file: settingsFile, data: loaded.data };
    const removedHooks = hookEntriesRemoved(sf);
    if (removedHooks === 0) {
      notes.push(`no hook entries for us in ${settingsFile}`);
    } else if (opts.dryRun) {
      notes.push(`[dry-run] would remove our hook entries from ${settingsFile}`);
    } else {
      const backup = backupFile(settingsFile);
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      notes.push(`removed our hook entries from ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`);
    }
  }
  removeMarkedFile(
    join(opts.global ? reasonixHome(opts.home) : join(opts.cwd, ".reasonix"), "hooks", HOOK_FILENAME),
    HOOK_MARKER,
    opts,
    notes,
  );
  if (opts.global) {
    tomlBlockRemove(join(reasonixHome(opts.home), "config.toml"), opts, notes);
    notes.push(SHARED_KEEP_NOTE);
  } else {
    const file = projectMcpJson(opts.cwd);
    const loadedMcp = readJsonConfig(file);
    if ("missing" in loadedMcp) {
      notes.push(`no ${file} — nothing to clean`);
    } else if ("manual" in loadedMcp) {
      notes.push(loadedMcp.manual);
    } else {
      const removed = jsonEntryRemoved(loadedMcp.data, "mcpServers");
      if (removed === 0) {
        notes.push(`no mcpServers["${MCP_SERVER_NAME}"] entry in ${file}`);
      } else if (opts.dryRun) {
        notes.push(`[dry-run] would remove mcpServers["${MCP_SERVER_NAME}"] from ${file}`);
      } else {
        const backup = backupFile(file);
        writeFileSync(file, JSON.stringify(loadedMcp.data, null, 2) + "\n", "utf8");
        notes.push(`removed mcpServers["${MCP_SERVER_NAME}"] from ${file}${backup ? ` (backup: ${backup})` : ""}`);
      }
      notes.push(MCP_JSON_SHARED_NOTE);
    }
    notes.push(SHARED_KEEP_NOTE);
  }
  if (!notes.length) notes.push("nothing to remove");
  return { agent: "reasonix", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- kilo

/** Kilo config location: <cwd>/.kilo/kilo.json (project) or the global
 *  ~/.config/kilo/kilo.json(kilo.jsonc) — the existing global file wins,
 *  kilo.json is created when neither exists (official first form). */
export function kiloConfigFile(cwd: string, home: string, global?: boolean): { file: string; existing: boolean } {
  if (!global) return { file: join(cwd, ".kilo", "kilo.json"), existing: false };
  const dir = join(home, ".config", "kilo");
  for (const name of ["kilo.json", "kilo.jsonc"]) {
    const f = join(dir, name);
    if (existsSync(f)) return { file: f, existing: true };
  }
  return { file: join(dir, "kilo.json"), existing: false };
}

/** Kilo MCP entry: `mcp` key (not mcpServers), command is an ARRAY
 *  (research: kilo-code.md). */
function kiloMcpEntry(): Record<string, unknown> {
  return { type: "local", command: ["npx", "-y", PKG_NAME, "mcp"], enabled: true };
}

function registerKilo(opts: CliAgentOptions, detection: CliAgentDetection): CliAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const notDetected = detection.detected ? "" : `Kilo Code not detected — install it first (${CLI_NOT_DETECTED_HINTS.kilo}). `;

  // 1) shared skill (Kilo loads .agents/skills/ alongside .kilo/skills/)
  if (opts.global) writeGlobalSharedSkill(opts, log);
  else writeSharedAgentsSkill(opts.cwd, opts, { warnings }, log);

  // 2) mcp entry in kilo.json(kilo.jsonc for the global scope)
  const { file, existing } = kiloConfigFile(opts.cwd, opts.home, opts.global);
  const fileLabel = opts.global ? (existing ? file : `kilo.json (created; no kilo.json(kilo.jsonc) existed)`) : file;
  const loaded = readJsonConfig(file);
  if ("manual" in loaded) {
    return {
      agent: "kilo",
      status: "manual",
      detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcp": { "${MCP_SERVER_NAME}": { "type": "local", "command": ["npx", "-y", "${PKG_NAME}", "mcp"], "enabled": true } } to ${file}.`,
    };
  }
  let detail: string;
  if ("missing" in loaded) {
    if (opts.dryRun) {
      detail = `[dry-run] would create ${fileLabel} with mcp["${MCP_SERVER_NAME}"]`;
    } else {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: kiloMcpEntry() } }, null, 2) + "\n", "utf8");
      detail = `wrote mcp["${MCP_SERVER_NAME}"] to ${fileLabel}`;
    }
  } else {
    const state = jsonEntryAdded(loaded.data, "mcp", kiloMcpEntry());
    if (state === "invalid") {
      return {
        agent: "kilo",
        status: "manual",
        detail: `cannot modify ${file}: "mcp" is not a JSON object — left untouched. Manual: add "mcp": { "${MCP_SERVER_NAME}": … } to ${file}.`,
      };
    }
    if (state === "present") {
      detail = `mcp["${MCP_SERVER_NAME}"] already present in ${file} — idempotent, no change`;
    } else if (opts.dryRun) {
      detail = `[dry-run] would add mcp["${MCP_SERVER_NAME}"] to ${file}`;
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      detail = `added mcp["${MCP_SERVER_NAME}"] to ${file}${backup ? ` (backup: ${backup})` : ""}`;
    }
  }
  return {
    agent: "kilo",
    status: "ok",
    detail:
      notDetected +
      detail +
      ` (${opts.global ? "global" : "project"} scope). Load with /reload (the 7.1.9 UI add-MCP bug does not affect file config). ` +
      `Tool name: ${MCP_SERVER_NAME}_describe_image.`,
  };
}

function uninstallKilo(opts: CliAgentOptions): CliAgentResult {
  const notes: string[] = [];
  const { file } = kiloConfigFile(opts.cwd, opts.home, opts.global);
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    notes.push(`no ${file} — nothing to clean`);
  } else if ("manual" in loaded) {
    notes.push(loaded.manual);
  } else {
    const removed = jsonEntryRemoved(loaded.data, "mcp");
    if (removed === 0) {
      notes.push(`no mcp["${MCP_SERVER_NAME}"] entry in ${file}`);
    } else if (opts.dryRun) {
      notes.push(`[dry-run] would remove mcp["${MCP_SERVER_NAME}"] from ${file}`);
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      notes.push(`removed mcp["${MCP_SERVER_NAME}"] from ${file}${backup ? ` (backup: ${backup})` : ""}`);
    }
  }
  notes.push(SHARED_KEEP_NOTE);
  return { agent: "kilo", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- workbuddy

function workbuddySettingsDir(cwd: string, home: string, global?: boolean): string {
  return global ? join(home, ".codebuddy") : join(cwd, ".codebuddy");
}

function registerWorkbuddy(opts: CliAgentOptions, detection: CliAgentDetection): CliAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const root = workbuddySettingsDir(opts.cwd, opts.home, opts.global);
  const notDetected = detection.detected
    ? ""
    : `WorkBuddy (CodeBuddy Code) not detected — install it first (${CLI_NOT_DETECTED_HINTS.workbuddy}). `;

  // 1) skill tree (.codebuddy/skills/ — CodeBuddy does not read .agents/skills/)
  writeSkillTree(join(root, "skills", SKILL_DIRNAME), opts, log, warnings);

  // 2) mcpServers entry: project .mcp.json (JSONC → manual) or
  //    ~/.codebuddy/.mcp.json (global)
  const file = opts.global ? join(root, ".mcp.json") : projectMcpJson(opts.cwd);
  const loaded = readJsonConfig(file);
  if ("manual" in loaded) {
    return {
      agent: "workbuddy",
      status: "manual",
      detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": { "type": "stdio", "command": "npx", "args": ["-y", "${PKG_NAME}", "mcp"] } } to ${file}.`,
    };
  }
  const entry = { type: "stdio", ...npxMcpEntry() };
  let detail: string;
  if ("missing" in loaded) {
    if (opts.dryRun) {
      detail = `[dry-run] would create ${file} with mcpServers["${MCP_SERVER_NAME}"]`;
    } else {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2) + "\n", "utf8");
      detail = `wrote mcpServers["${MCP_SERVER_NAME}"] to ${file}${opts.global ? "" : " (shared with Copilot/Reasonix)"}`;
    }
  } else {
    const state = jsonEntryAdded(loaded.data, "mcpServers", entry);
    if (state === "invalid") {
      return {
        agent: "workbuddy",
        status: "manual",
        detail: `cannot modify ${file}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": … } to ${file}.`,
      };
    }
    if (state === "present") {
      detail = `mcpServers["${MCP_SERVER_NAME}"] already present in ${file} — idempotent, no change`;
    } else if (opts.dryRun) {
      detail = `[dry-run] would add mcpServers["${MCP_SERVER_NAME}"] to ${file}`;
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      detail = `added mcpServers["${MCP_SERVER_NAME}"] to ${file}${opts.global ? "" : " (shared with Copilot/Reasonix)"}${backup ? ` (backup: ${backup})` : ""}`;
    }
  }
  const extra = opts.global
    ? ""
    : ` Project-level MCP needs a first-connection approval in CodeBuddy; headless runs can pre-authorize with "enabledMcpjsonServers": ["${MCP_SERVER_NAME}"].`;
  return { agent: "workbuddy", status: "ok", detail: notDetected + detail + extra };
}

function uninstallWorkbuddy(opts: CliAgentOptions): CliAgentResult {
  const notes: string[] = [];
  const root = workbuddySettingsDir(opts.cwd, opts.home, opts.global);
  const file = opts.global ? join(root, ".mcp.json") : projectMcpJson(opts.cwd);
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    notes.push(`no ${file} — nothing to clean`);
  } else if ("manual" in loaded) {
    notes.push(loaded.manual);
  } else {
    const removed = jsonEntryRemoved(loaded.data, "mcpServers");
    if (removed === 0) {
      notes.push(`no mcpServers["${MCP_SERVER_NAME}"] entry in ${file}`);
    } else if (opts.dryRun) {
      notes.push(`[dry-run] would remove mcpServers["${MCP_SERVER_NAME}"] from ${file}`);
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      notes.push(`removed mcpServers["${MCP_SERVER_NAME}"] from ${file}${backup ? ` (backup: ${backup})` : ""}`);
    }
    if (!opts.global) notes.push(MCP_JSON_SHARED_NOTE);
  }
  removeSkillTree(join(root, "skills", SKILL_DIRNAME), opts, notes);
  if (!notes.length) notes.push(`not present: ${root} — nothing to remove`);
  return { agent: "workbuddy", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- devin

function devinMcpFile(cwd: string, home: string, global?: boolean): string {
  return global ? join(devinHome(home), "mcp_config.json") : join(cwd, ".devin", "mcp_config.json");
}

function registerDevin(opts: CliAgentOptions, detection: CliAgentDetection): CliAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const notDetected = detection.detected ? "" : `Devin not detected — install it first (${CLI_NOT_DETECTED_HINTS.devin}). `;

  // 1) shared skill (project .agents/skills/ or global ~/.agents/skills/)
  if (opts.global) writeGlobalSharedSkill(opts, log);
  else writeSharedAgentsSkill(opts.cwd, opts, { warnings }, log);

  // 2) mcpServers entry in mcp_config.json (project .devin/ or the Devin
  //    config dir)
  const file = devinMcpFile(opts.cwd, opts.home, opts.global);
  const loaded = readJsonConfig(file);
  if ("manual" in loaded) {
    return {
      agent: "devin",
      status: "manual",
      detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": { "command": "npx", "args": ["-y", "${PKG_NAME}", "mcp"] } } to ${file}.`,
    };
  }
  let detail: string;
  if ("missing" in loaded) {
    if (opts.dryRun) {
      detail = `[dry-run] would create ${file} with mcpServers["${MCP_SERVER_NAME}"]`;
    } else {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: npxMcpEntry() } }, null, 2) + "\n", "utf8");
      detail = `wrote mcpServers["${MCP_SERVER_NAME}"] to ${file}`;
    }
  } else {
    const state = jsonEntryAdded(loaded.data, "mcpServers", npxMcpEntry());
    if (state === "invalid") {
      return {
        agent: "devin",
        status: "manual",
        detail: `cannot modify ${file}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": … } to ${file}.`,
      };
    }
    if (state === "present") {
      detail = `mcpServers["${MCP_SERVER_NAME}"] already present in ${file} — idempotent, no change`;
    } else if (opts.dryRun) {
      detail = `[dry-run] would add mcpServers["${MCP_SERVER_NAME}"] to ${file}`;
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      detail = `added mcpServers["${MCP_SERVER_NAME}"] to ${file}${backup ? ` (backup: ${backup})` : ""}`;
    }
  }
  return {
    agent: "devin",
    status: "ok",
    detail:
      notDetected +
      detail +
      ` (${opts.global ? "global" : "project"} scope). stdio MCP works in the local Devin CLI/Desktop; Devin Cloud sessions only support remote HTTP MCP (out of scope).`,
  };
}

function uninstallDevin(opts: CliAgentOptions): CliAgentResult {
  const notes: string[] = [];
  const file = devinMcpFile(opts.cwd, opts.home, opts.global);
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    notes.push(`no ${file} — nothing to clean`);
  } else if ("manual" in loaded) {
    notes.push(loaded.manual);
  } else {
    const removed = jsonEntryRemoved(loaded.data, "mcpServers");
    if (removed === 0) {
      notes.push(`no mcpServers["${MCP_SERVER_NAME}"] entry in ${file}`);
    } else if (opts.dryRun) {
      notes.push(`[dry-run] would remove mcpServers["${MCP_SERVER_NAME}"] from ${file}`);
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      notes.push(`removed mcpServers["${MCP_SERVER_NAME}"] from ${file}${backup ? ` (backup: ${backup})` : ""}`);
    }
  }
  notes.push(SHARED_KEEP_NOTE);
  return { agent: "devin", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- drivers

type CliRegisterDriver = (o: CliAgentOptions, d: CliAgentDetection) => CliAgentResult;
type CliUnregisterDriver = (o: CliAgentOptions, d: CliAgentDetection) => CliAgentResult;

const REGISTERS: Record<CliAgent, CliRegisterDriver> = {
  qwen: registerQwen,
  reasonix: registerReasonix,
  kilo: registerKilo,
  workbuddy: registerWorkbuddy,
  devin: registerDevin,
};

const UNREGISTERS: Record<CliAgent, CliUnregisterDriver> = {
  qwen: uninstallQwen,
  reasonix: uninstallReasonix,
  kilo: uninstallKilo,
  workbuddy: uninstallWorkbuddy,
  devin: uninstallDevin,
};

// Module-load completeness assertion (same pattern as plugin.ts /
// skillagents.ts): every CLI agent MUST have a register and an unregister
// driver, or the module fails loudly at startup.
for (const agent of CLI_AGENTS) {
  if (!(agent in REGISTERS)) {
    throw new Error(`installer bug: no register driver for cli agent "${agent}"`);
  }
  if (!(agent in UNREGISTERS)) {
    throw new Error(`installer bug: no unregister driver for cli agent "${agent}"`);
  }
}

async function runPerAgent(
  table: Record<CliAgent, CliRegisterDriver | CliUnregisterDriver>,
  opts: CliAgentOptions,
  detection: Record<CliAgent, CliAgentDetection>,
): Promise<CliAgentResult[]> {
  const agents = opts.agents ?? [...CLI_AGENTS];
  const results: CliAgentResult[] = [];
  for (const agent of agents) {
    const driver = table[agent];
    if (driver === undefined) {
      // unreachable after the module-load assertion; kept loud anyway
      results.push({
        agent,
        status: "failed",
        detail: `no driver registered for cli agent "${agent}" (installer bug)`,
      });
      continue;
    }
    try {
      results.push(driver(opts, detection[agent]));
    } catch (e) {
      results.push({
        agent,
        status: "failed",
        detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

export async function installCliAgents(
  opts: CliAgentOptions,
  detection: Record<CliAgent, CliAgentDetection>,
): Promise<CliAgentResult[]> {
  return runPerAgent(REGISTERS, opts, detection);
}

export async function uninstallCliAgents(
  opts: CliAgentOptions,
  detection: Record<CliAgent, CliAgentDetection>,
): Promise<CliAgentResult[]> {
  return runPerAgent(UNREGISTERS, opts, detection);
}
