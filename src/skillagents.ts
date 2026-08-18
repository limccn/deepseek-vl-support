// Skill-copy agent support (install --target <agent list>): the agents that
// read Agent Skills but do NOT implement the Agent Plugins open standard
// (research: opencode-trae.md, pi-deepseek-harness.md):
//   - opencode (native kind): reads <project>/.agents/skills/ natively; MCP
//     is a deep-merged entry in opencode.json (project or global by scope)
//   - trae (IDE only): skill copied to <project>/.trae/skills/ + manual
//     import guidance; no CLI, no MCP automation (unverified paths)
//   - pi coding agent: shared <project>/.agents/skills/ skill; MCP exists
//     only via the community pi-mcp-adapter extension, so
//     ~/.pi/agent/mcp.json is written ONLY when the adapter is detected
//   - deepseek-harness (dsh): shared <project>/.agents/skills/ skill + MCP
//     guidance (cordis.patch.yml is a dev-preview surface — not auto-written)
//
// Safety rules (same as plugin.ts / install.ts):
//  - JSON config files (opencode.json, ~/.pi/agent/mcp.json) are deep-merged:
//    foreign keys/servers are never touched, the file is backed up to
//    `<file>.bak` before the first modification, and unparseable files are
//    left untouched and reported as manual
//  - skill copies carry SKILL_MARKER so uninstall can tell ours from a
//    user-authored one; a failing agent never blocks the others
//  - uninstall of opencode/pi/omp/dsh NEVER deletes the shared
//    .agents/skills/deepseek-vision/ tree (codex owns it) — the keep rule is
//    stated in the result detail instead
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFile, readTextFile } from "./codex.ts";
import { MCP_SERVER_NAME, PKG_NAME, SKILL_DIRNAME, SKILL_MARKER } from "./identity.ts";
import { findOnPath } from "./plugin.ts";
import { packagedSkillPath, templatePath } from "./paths.ts";

/** The skill-copy consumers (opencode is native and handled here too
 *  because it shares the skill write and the JSON-config discipline; omp is
 *  not a skill-copy consumer either — it reads the shared tree like opencode,
 *  but has no config file to write, so it lives in this module with the same
 *  shared-skill helpers). */
export type SkillAgent = "trae" | "pi" | "omp" | "dsh";

/** Every agent whose install/uninstall drivers live in this module. */
export type SkillModuleAgent = "opencode" | SkillAgent;

export const SKILL_AGENTS: readonly SkillAgent[] = ["trae", "pi", "omp", "dsh"];

export const SKILL_MODULE_AGENTS: readonly SkillModuleAgent[] = ["opencode", "trae", "pi", "omp", "dsh"];

// ---------------------------------------------------------------- detection

export interface SkillAgentDetection {
  detected: boolean;
  bin: string | null; // resolved executable path (CLI agents only)
  reason: string;
}

type Detector = (home: string, env: NodeJS.ProcessEnv) => SkillAgentDetection;

/** OpenCode config dir: %APPDATA%\opencode on Windows, ~/.config/opencode
 *  elsewhere (per opencode docs/source; APPDATA = home\AppData\Roaming). */
export function opencodeConfigDir(home: string): string {
  return process.platform === "win32"
    ? join(home, "AppData", "Roaming", "opencode")
    : join(home, ".config", "opencode");
}

/** opencode.json location: <cwd>/opencode.json (project) or the global
 *  config dir (Windows %APPDATA%\opencode\opencode.json, elsewhere
 *  ~/.config/opencode/opencode.json). */
export function opencodeConfigFile(cwd: string, home: string, global?: boolean): string {
  return global ? join(opencodeConfigDir(home), "opencode.json") : join(cwd, "opencode.json");
}

const opencodeDetector: Detector = (home, env) => {
  const bin = findOnPath("opencode", env);
  if (bin !== null) return { detected: true, bin, reason: `found ${bin}` };
  const dir = opencodeConfigDir(home);
  const found = existsSync(dir);
  return {
    detected: found,
    bin: null,
    reason: found ? `found ${dir}` : `opencode not on PATH and no config dir (${dir})`,
  };
};

/** Trae IDE data dir: %APPDATA%\Trae (win), ~/Library/Application Support/Trae
 *  (mac), ~/.config/Trae (linux). Trae is GUI-only — a pure directory probe
 *  (home-derived so detection stays hermetic and testable). */
export function traeConfigDir(home: string): string {
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Trae");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Trae");
  return join(home, ".config", "Trae");
}

const traeDetector: Detector = (home) => {
  const dir = traeConfigDir(home);
  const found = existsSync(dir);
  return { detected: found, bin: null, reason: found ? `found ${dir}` : `${dir} not found` };
};

/** CLI-first detector with a config-dir fallback (pi, dsh). */
function cliOrDirDetector(binName: string, label: string, dirOf: (home: string) => string): Detector {
  return (home, env) => {
    const bin = findOnPath(binName, env);
    if (bin !== null) return { detected: true, bin, reason: `found ${bin}` };
    const dir = dirOf(home);
    const found = existsSync(dir);
    return {
      detected: found,
      bin: null,
      reason: found ? `found ${dir}` : `${label} not on PATH and no ${dir}`,
    };
  };
}

const piDetector = cliOrDirDetector("pi", "pi", (h) => join(h, ".pi", "agent"));
const ompDetector = cliOrDirDetector("omp", "Oh My Pi", (h) => join(h, ".omp"));
const dshDetector = cliOrDirDetector("dsh", "dsh", (h) => join(h, ".dsh"));

const DETECTORS: Record<SkillModuleAgent, Detector> = {
  opencode: opencodeDetector,
  trae: traeDetector,
  pi: piDetector,
  omp: ompDetector,
  dsh: dshDetector,
};

/** Detect which of the five skill-module agents is available on this
 *  machine. CLI agents (opencode/pi/omp/dsh) are probed via PATH with a
 *  config dir fallback; Trae is a GUI-only directory probe. */
export function detectSkillModuleAgents(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<SkillModuleAgent, SkillAgentDetection> {
  const out = {} as Record<SkillModuleAgent, SkillAgentDetection>;
  for (const agent of SKILL_MODULE_AGENTS) out[agent] = DETECTORS[agent](home, env);
  return out;
}

/** Install hints for the "was not detected — install it first" warning
 *  (R5). Covers exactly the agents with detectors — claude/codex (no
 *  detector) and `other` (no detection surface) are never warned about. */
export const NOT_DETECTED_HINTS: Record<SkillModuleAgent, string> = {
  opencode: "npm i -g opencode-ai",
  trae: "the Trae IDE — trae.ai",
  pi: "npm i -g @earendil-works/pi-coding-agent",
  omp: "npm i -g @oh-my-pi/pi-coding-agent",
  dsh: "npx @deepseek-ai/dsh web",
};

// ---------------------------------------------------------------- results

export type SkillAgentStatus = "ok" | "skipped" | "failed" | "manual";

export interface SkillAgentResult {
  agent: SkillModuleAgent;
  status: SkillAgentStatus;
  detail: string;
}

export interface SkillAgentOptions {
  cwd: string;
  home: string;
  /** Scope for the native opencode artifacts (opencode.json location); the
   *  skill agents trae/pi/dsh are project-level only and ignore it. */
  global?: boolean;
  update?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  agents?: SkillModuleAgent[];
  log?: (msg: string) => void;
  warnings?: string[];
}

// ---------------------------------------------------------------- file helpers

/** Mirror of install.ts's writeManagedFile: never overwrite a user-authored
 *  file that lacks our marker, keep managed files without --update, dry-run
 *  prints instead of writing. Kept local (module graph stays acyclic). */
function writeManagedFile(
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

/** Write the packaged deepseek-vision skill tree (SKILL.md +
 *  references/vision-prompt.md, both SKILL_MARKER-marked) into `destDir`.
 *  Returns false when the packaged SKILL.md source is missing. */
export function writeSkillTree(
  destDir: string,
  opts: { update?: boolean; dryRun?: boolean },
  log: (msg: string) => void,
  warnings: string[],
): boolean {
  const packaged = readTextFile(packagedSkillPath());
  if (packaged === null) return false;
  writeManagedFile(
    join(destDir, "SKILL.md"),
    packaged,
    { update: opts.update, dryRun: opts.dryRun, marker: SKILL_MARKER },
    log,
    warnings,
  );
  // progressive disclosure: the SKILL.md body references
  // references/vision-prompt.md, so the skill dir must be self-contained
  const ref = readTextFile(templatePath("skill-references/vision-prompt.md"));
  if (ref !== null) {
    writeManagedFile(
      join(destDir, "references", "vision-prompt.md"),
      ref,
      { update: opts.update, dryRun: opts.dryRun, marker: SKILL_MARKER },
      log,
      warnings,
    );
  }
  return true;
}

/** Shared <project>/.agents/skills/deepseek-vision/ write — the same
 *  location and contract as the Codex project-scope install, used by
 *  opencode/pi/omp/dsh too (global scope skips it: it is a project-level
 *  convention). Extracted from install.ts's installCodex (behavior
 *  unchanged). */
export function writeSharedAgentsSkill(
  cwd: string,
  opts: { global?: boolean; update?: boolean; dryRun?: boolean },
  report: { warnings: string[] },
  log: (msg: string) => void,
): void {
  if (opts.global) {
    log(`skipped .agents/skills/deepseek-vision/ write — project-level convention (global scope)`);
    return;
  }
  if (!writeSkillTree(join(cwd, ".agents", "skills", SKILL_DIRNAME), opts, log, report.warnings)) {
    report.warnings.push(`missing ${packagedSkillPath()} — run \`npm run build\` first (skipping .agents/skills write)`);
  }
}

/** Uninstall ownership rule for the shared .agents/skills tree: only codex
 *  removes it (`uninstall --target codex`); opencode/pi/omp/dsh keep it. */
export const SHARED_SKILL_KEEP_NOTE =
  `shared .agents/skills/deepseek-vision/ kept (may be used by other agents) — ` +
  `remove with \`uninstall --target codex\` or delete the directory.`;

/** Remove one managed skill file; user-authored content (no marker) is kept
 *  and reported. Returns how many files were removed (0 or 1). */
function removeManagedSkillFile(target: string, opts: { dryRun?: boolean }, notes: string[]): number {
  if (!existsSync(target)) return 0;
  const content = readTextFile(target) ?? "";
  if (!content.includes(SKILL_MARKER)) {
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

/** Remove the managed files of a skill tree and then the empty dirs that
 *  remain (deepest first; any user-authored leftover keeps the tree).
 *  Mirrors install.ts's removeEmptyDirTree. */
export function removeSkillTree(dir: string, opts: { dryRun?: boolean }, notes: string[]): void {
  let removed = 0;
  removed += removeManagedSkillFile(join(dir, "references", "vision-prompt.md"), opts, notes);
  removed += removeManagedSkillFile(join(dir, "SKILL.md"), opts, notes);
  if (removed > 0 && !opts.dryRun && existsSync(dir)) {
    notes.push(...removeEmptyDirTree(dir));
  }
}

/** Remove `dir` and every subdirectory, but only when they contain no files
 *  (deepest first). Returns the list of removed paths; a single user-authored
 *  leftover file anywhere in the tree keeps the whole tree. */
function removeEmptyDirTree(dir: string): string[] {
  const removed: string[] = [];
  const visit = (d: string): boolean => {
    let allEmpty = true;
    for (const name of readdirSyncSafe(d)) {
      const p = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        return false;
      }
      if (isDir) {
        if (!visit(p)) allEmpty = false;
      } else {
        allEmpty = false;
      }
    }
    if (allEmpty) {
      try {
        rmSync(d, { recursive: true, force: true });
        removed.push(d);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  visit(dir);
  return removed;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- json deep-merge

/** Read a JSON config file as an object. Returns { data } on success, null
 *  when the file is missing, or a { manual } reason string when it exists but
 *  cannot be modified safely (not valid JSON / not an object). */
export function readJsonConfig(
  file: string,
): { data: Record<string, unknown> } | { missing: true } | { manual: string } {
  const raw = readTextFile(file);
  if (raw === null) return { missing: true };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { manual: `${file} is not a JSON object — left untouched` };
    }
    return { data };
  } catch {
    return {
      manual: `${file} is not valid JSON (JSONC comments are allowed by some tools) — left untouched`,
    };
  }
}

/** Merge an entry into data[key][MCP_SERVER_NAME]. Returns "added" /
 *  "present" / "invalid" — invalid when data[key] exists with a non-object
 *  type (a user-authored schema violation we never clobber). */
export function jsonEntryAdded(
  data: Record<string, unknown>,
  key: string,
  entry: Record<string, unknown>,
): "added" | "present" | "invalid" {
  const existing = data[key];
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    return "invalid";
  }
  const map = (existing as Record<string, unknown> | undefined) ?? {};
  if (map[MCP_SERVER_NAME] !== undefined) return "present";
  map[MCP_SERVER_NAME] = entry;
  data[key] = map;
  return "added";
}

/** Remove our entry from data[key][MCP_SERVER_NAME] (and the empty `key`
 *  container once nothing is left). Returns how many entries were removed. */
export function jsonEntryRemoved(data: Record<string, unknown>, key: string): number {
  const existing = data[key];
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return 0;
  const map = existing as Record<string, unknown>;
  if (!(MCP_SERVER_NAME in map)) return 0;
  delete map[MCP_SERVER_NAME];
  if (Object.keys(map).length === 0) delete data[key];
  return 1;
}

// ---------------------------------------------------------------- opencode

/** opencode.json MCP entry (schema per research/opencode-trae.md §1.3). */
function opencodeMcpEntry(): Record<string, unknown> {
  return { type: "local", command: ["npx", "-y", PKG_NAME, "mcp"], enabled: true };
}

function registerOpencode(opts: SkillAgentOptions, detection: SkillAgentDetection): SkillAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const file = opencodeConfigFile(opts.cwd, opts.home, opts.global);

  // 1) shared skill (project scope only — opencode reads .agents/skills/
  //    natively, no AGENTS.md block needed)
  writeSharedAgentsSkill(opts.cwd, { global: opts.global, update: opts.update, dryRun: opts.dryRun }, { warnings }, log);

  // 2) MCP entry in opencode.json (deep-merge; user content never touched)
  let detail: string;
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    if (opts.dryRun) {
      detail = `[dry-run] would create ${file} with mcp["${MCP_SERVER_NAME}"]`;
    } else {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: opencodeMcpEntry() } }, null, 2) + "\n", "utf8");
      detail = `wrote ${file} with mcp["${MCP_SERVER_NAME}"] (npx -y ${PKG_NAME} mcp)`;
    }
  } else if ("manual" in loaded) {
    return {
      agent: "opencode",
      status: "manual",
      detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcp": { "${MCP_SERVER_NAME}": { "type": "local", "command": ["npx", "-y", "${PKG_NAME}", "mcp"], "enabled": true } } to ${file}.`,
    };
  } else {
    const state = jsonEntryAdded(loaded.data, "mcp", opencodeMcpEntry());
    if (state === "invalid") {
      return {
        agent: "opencode",
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
  const extra = detection.detected
    ? ""
    : ` (opencode not detected — install it first: ${NOT_DETECTED_HINTS.opencode})`;
  return { agent: "opencode", status: "ok", detail: detail + extra };
}

function uninstallOpencode(opts: SkillAgentOptions): SkillAgentResult {
  const notes: string[] = [];
  const file = opencodeConfigFile(opts.cwd, opts.home, opts.global);
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
  if (!opts.global) notes.push(SHARED_SKILL_KEEP_NOTE);
  return { agent: "opencode", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- trae

function registerTrae(opts: SkillAgentOptions, detection: SkillAgentDetection): SkillAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const dest = join(opts.cwd, ".trae", "skills", SKILL_DIRNAME);
  const ok = writeSkillTree(dest, opts, log, warnings);
  if (!ok) {
    warnings.push(`missing ${packagedSkillPath()} — run \`npm run build\` first (skipping .trae/skills write)`);
  }
  const notDetected = detection.detected
    ? ""
    : `Trae not detected — install it first (${NOT_DETECTED_HINTS.trae}). `;
  const guidance =
    ok
      ? `skill copied to ${dest}. Manual: Trae is an IDE — import the skill in Settings → Rules & Skills (Create/Import, pick ${dest}), then restart Trae. `
      : `skill write skipped (packaged skill missing — run \`npm run build\` first). ` +
        `Manual: copy skills/deepseek-vision/ to ${dest} and import it in Settings → Rules & Skills. `;
  const extra =
    `Trae community reports also suggest it may scan .agents/skills/ (unverified) — if you also installed codex/opencode/pi/omp/dsh, the shared skill is already there. ` +
    `MCP (manual, optional): add a server in Trae's MCP settings (Settings → MCP → Manually Add) with command \`npx -y ${PKG_NAME} mcp\`.`;
  return { agent: "trae", status: "manual", detail: notDetected + guidance + extra };
}

function uninstallTrae(opts: SkillAgentOptions): SkillAgentResult {
  const notes: string[] = [];
  const dest = join(opts.cwd, ".trae", "skills", SKILL_DIRNAME);
  removeSkillTree(dest, opts, notes);
  if (!notes.length) notes.push(`not present: ${dest} — nothing to remove`);
  return { agent: "trae", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- pi

/** Pi MCP config: ~/.pi/agent/mcp.json, Claude Code format (read by the
 *  community pi-mcp-adapter extension — pi core has no MCP). */
function piMcpFile(home: string): string {
  return join(home, ".pi", "agent", "mcp.json");
}

function piMcpEntry(): Record<string, unknown> {
  return { command: "npx", args: ["-y", PKG_NAME, "mcp"] };
}

function registerPi(opts: SkillAgentOptions, detection: SkillAgentDetection): SkillAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  const home = opts.home;
  const file = piMcpFile(home);

  writeSharedAgentsSkill(opts.cwd, { global: opts.global, update: opts.update, dryRun: opts.dryRun }, { warnings }, log);

  // Adapter detection (conservative, per design §2.5): only write mcp.json
  // when the target file or the pi extensions dir (~/.pi/agent/npm/) already
  // exists — a plain pi install (no adapter) must not be modified.
  const adapterPresent = existsSync(file) || existsSync(join(home, ".pi", "agent", "npm"));
  if (!adapterPresent) {
    const notDetected = detection.detected
      ? ""
      : `Pi not detected — install it first (${NOT_DETECTED_HINTS.pi}). `;
    return {
      agent: "pi",
      status: "manual",
      detail:
        notDetected +
        `Prefer the native package: \`pi install npm:${PKG_NAME}\` (or \`pi install git:github.com/limccn/${PKG_NAME}@<tag>\`) — one command gives pi the deepseek-vision skill (user-level, reload-free after restart) and a native extension: pasting an image or reading an image file is described automatically (restart pi after install). ` +
        `The project-level skill was also written to .agents/skills/deepseek-vision/ (pi loads project skills only after you trust the project on first run; use it for team repos). ` +
        `To get MCP tools on top, install the community extension pi-mcp-adapter (\`pi install npm:pi-mcp-adapter\`, restart pi) and re-run this installer.`,
    };
  }

  let detail: string;
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    if (opts.dryRun) {
      detail = `[dry-run] would create ${file} with mcpServers["${MCP_SERVER_NAME}"]`;
    } else {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: piMcpEntry() } }, null, 2) + "\n", "utf8");
      detail = `wrote mcpServers["${MCP_SERVER_NAME}"] to ${file} (pi-mcp-adapter detected)`;
    }
  } else if ("manual" in loaded) {
    return {
      agent: "pi",
      status: "manual",
      detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": { "command": "npx", "args": ["-y", "${PKG_NAME}", "mcp"] } } to ${file}. Prefer the native package instead: \`pi install npm:${PKG_NAME}\` gives the skill with no config edits.`,
    };
  } else {
    const state = jsonEntryAdded(loaded.data, "mcpServers", piMcpEntry());
    if (state === "invalid") {
      return {
        agent: "pi",
        status: "manual",
        detail: `cannot modify ${file}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${MCP_SERVER_NAME}": … } to ${file}. Or prefer the native package: \`pi install npm:${PKG_NAME}\`.`,
      };
    }
    if (state === "present") {
      detail = `mcpServers["${MCP_SERVER_NAME}"] already present in ${file} — idempotent, no change; also recommended: \`pi install npm:${PKG_NAME}\` for the packaged skill`;
    } else if (opts.dryRun) {
      detail = `[dry-run] would add mcpServers["${MCP_SERVER_NAME}"] to ${file}`;
    } else {
      const backup = backupFile(file);
      writeFileSync(file, JSON.stringify(loaded.data, null, 2) + "\n", "utf8");
      detail = `added mcpServers["${MCP_SERVER_NAME}"] to ${file}${backup ? ` (backup: ${backup})` : ""}`;
    }
  }
  const extra =
    (detection.detected ? "" : ` (pi not detected — install it first: ${NOT_DETECTED_HINTS.pi})`) +
    ` The package also ships a native pi extension: pasting an image or reading an image file is described automatically (restart pi after install).`;
  return { agent: "pi", status: "ok", detail: detail + extra };
}

// ---------------------------------------------------------------- omp

/** oh-my-pi (omp) — a pi fork with built-in MCP. Unlike pi, omp reads the
 *  project `.agents/skills/` shared tree (priority 70) and auto-registers a
 *  package's `.mcp.json`/`mcp.json` servers once the package is installed
 *  and enabled. So the installer only writes the shared skill and prints
 *  the native install command — there is no config file to touch (omp's
 *  user-level mcp config path is unverified; trae/dsh precedent: don't
 *  write what is not verified). */
function registerOmp(opts: SkillAgentOptions, detection: SkillAgentDetection): SkillAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];

  writeSharedAgentsSkill(opts.cwd, { global: opts.global, update: opts.update, dryRun: opts.dryRun }, { warnings }, log);

  const notDetected = detection.detected
    ? ""
    : `Oh My Pi not detected — install it first (${NOT_DETECTED_HINTS.omp}). `;
  const guidance =
    `Prefer the native package: \`omp install npm:${PKG_NAME}\` (or \`omp install github:limccn/${PKG_NAME}@<tag>\`) — one command gives omp the deepseek-vision skill AND automatic MCP tools (the package's .mcp.json is auto-registered; activate with /reload-plugins). ` +
    `The project-level skill was also written to .agents/skills/deepseek-vision/ (omp reads it at priority 70 — use it for team repos). ` +
    `No config file is written by this installer (omp user-level MCP config paths are unverified).`;
  return { agent: "omp", status: "ok", detail: notDetected + guidance };
}

function uninstallOmp(opts: SkillAgentOptions): SkillAgentResult {
  const notes = ["omp has no own artifacts to remove (its skill lives in the shared .agents/skills/ tree; the native package is removed with `omp plugin uninstall deepseek-vl-support`)"];
  if (!opts.global) notes.push(SHARED_SKILL_KEEP_NOTE);
  return { agent: "omp", status: "ok", detail: notes.join("; ") };
}

function uninstallPi(opts: SkillAgentOptions): SkillAgentResult {
  const notes: string[] = [];
  const file = piMcpFile(opts.home);
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
  if (!opts.global) notes.push(SHARED_SKILL_KEEP_NOTE);
  return { agent: "pi", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- dsh

function registerDsh(opts: SkillAgentOptions, detection: SkillAgentDetection): SkillAgentResult {
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];

  writeSharedAgentsSkill(opts.cwd, { global: opts.global, update: opts.update, dryRun: opts.dryRun }, { warnings }, log);

  const notDetected = detection.detected
    ? ""
    : `dsh not detected — install it first (${NOT_DETECTED_HINTS.dsh}). `;
  const guidance =
    `Prefer the native package: \`dsh plugin --profile web add ${PKG_NAME}@latest\` (or \`dsh plugin --profile web add github:limccn/${PKG_NAME}@<tag>\`) — one command gives dsh the describe_image + vision_status native tools, reading the same VISION_* env / config.json chain (restart the dsh web session after install). ` +
    `The project-level skill was also written to .agents/skills/deepseek-vision/ (dsh reads it at rank 200 — use it for team repos). ` +
    `Uninstall: \`dsh plugin --profile web remove ${PKG_NAME}\`. ` +
    `Note: dsh skill frontmatter is fail-closed on camelCase keys; our skill uses \`allowed-tools\` (kebab-case) — whether dsh ignores the key needs real-machine verification.`;
  return { agent: "dsh", status: "manual", detail: notDetected + guidance };
}

function uninstallDsh(opts: SkillAgentOptions): SkillAgentResult {
  const notes = ["dsh has no own artifacts to remove (its skill lives in the shared .agents/skills/ tree)"];
  if (!opts.global) notes.push(SHARED_SKILL_KEEP_NOTE);
  return { agent: "dsh", status: "ok", detail: notes.join("; ") };
}

// ---------------------------------------------------------------- drivers

type RegisterDriver = (o: SkillAgentOptions, d: SkillAgentDetection) => SkillAgentResult;
type UnregisterDriver = (o: SkillAgentOptions, d: SkillAgentDetection) => SkillAgentResult;

const REGISTERS: Record<SkillModuleAgent, RegisterDriver> = {
  opencode: registerOpencode,
  trae: registerTrae,
  pi: registerPi,
  omp: registerOmp,
  dsh: registerDsh,
};

const UNREGISTERS: Record<SkillModuleAgent, UnregisterDriver> = {
  opencode: uninstallOpencode,
  trae: uninstallTrae,
  pi: uninstallPi,
  omp: uninstallOmp,
  dsh: uninstallDsh,
};

// Module-load completeness assertion (same pattern as plugin.ts): every
// agent handled by this module MUST have a register and an unregister
// driver. Runs once at import time so a new agent without drivers fails
// loudly at startup, never as a silent "undefined is not a function".
for (const agent of SKILL_MODULE_AGENTS) {
  if (!(agent in REGISTERS)) {
    throw new Error(`installer bug: no register driver for skill agent "${agent}"`);
  }
  if (!(agent in UNREGISTERS)) {
    throw new Error(`installer bug: no unregister driver for skill agent "${agent}"`);
  }
}

async function runPerAgent(
  table: Record<SkillModuleAgent, RegisterDriver | UnregisterDriver>,
  opts: SkillAgentOptions,
  detection: Record<SkillModuleAgent, SkillAgentDetection>,
): Promise<SkillAgentResult[]> {
  const agents = opts.agents ?? [...SKILL_MODULE_AGENTS];
  const results: SkillAgentResult[] = [];
  for (const agent of agents) {
    const driver = table[agent];
    if (driver === undefined) {
      // unreachable after the module-load assertion; kept loud anyway
      results.push({
        agent,
        status: "failed",
        detail: `no driver registered for skill agent "${agent}" (installer bug)`,
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

export async function installSkillAgents(
  opts: SkillAgentOptions,
  detection: Record<SkillModuleAgent, SkillAgentDetection>,
): Promise<SkillAgentResult[]> {
  return runPerAgent(REGISTERS, opts, detection);
}

export async function uninstallSkillAgents(
  opts: SkillAgentOptions,
  detection: Record<SkillModuleAgent, SkillAgentDetection>,
): Promise<SkillAgentResult[]> {
  return runPerAgent(UNREGISTERS, opts, detection);
}
