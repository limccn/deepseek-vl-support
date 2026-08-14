// Installer: numbered-menu wizard (interactive) or flags/env (CI), file
// installation for Claude Code (hook + skill + slash command + settings.json
// deep-merge) and Codex (config.toml MCP section + AGENTS.md block +
// models.json fix), idempotent re-install, and marker-based uninstall.
//
// Safety rules:
//  - settings.json / config.toml / AGENTS.md are backed up to `<file>.bak`
//    before the first modification
//  - never overwrite or delete a user-authored file that lacks OUR marker
//  - every artifact carries a marker string (see src/identity.ts)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  backupFile,
  fixModelsJson,
  findModelsJson,
  readTextFile,
  removeAgentsBlock,
  removeMcpSection,
  upsertAgentsBlock,
  upsertMcpSection,
} from "./codex.ts";
import { runDoctor } from "./doctor.ts";
import type { DoctorReport } from "./doctor.ts";
import { DEFAULT_BASE_URL, globalConfigDir, parseFallbacks, writeConfigFile } from "./config.ts";
import type { FallbackConfig } from "./config.ts";
import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  COMMAND_FILENAME,
  COMMAND_MARKER,
  CONFIG_DIR,
  GITIGNORE_ENTRY,
  HOOK_COMMAND_IDENT,
  HOOK_FILENAME,
  HOOK_MARKER,
  MCP_SERVER_NAME,
  PKG_NAME,
  SKILL_DIRNAME,
  SKILL_MARKER,
} from "./identity.ts";
import { packageRoot, packagedHookPath, templatePath } from "./paths.ts";
import { askInput, askMenu, askSecret } from "./wizard.ts";

export type InstallTarget = "claude" | "codex" | "both";

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

// Preset order follows D2: remote APIs first, local endpoints last.
export const PRESETS: Preset[] = [
  { id: "openrouter", label: "OpenRouter (cloud)", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen2.5-vl-72b-instruct" },
  { id: "siliconflow", label: "SiliconFlow (cloud)", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-72B-Instruct" },
  { id: "dashscope", label: "Aliyun DashScope (cloud)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max" },
  { id: "custom", label: "Custom", baseUrl: "", model: "" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5vl:7b" },
  { id: "llamacpp", label: "llama.cpp (local)", baseUrl: "http://localhost:8080/v1", model: "llava" },
  { id: "vllm", label: "vLLM (local)", baseUrl: "http://localhost:8000/v1", model: "deepseek-ai/deepseek-vl2" },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "qwen2.5-vl-7b-instruct" },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export interface InstallAnswers {
  target: InstallTarget;
  baseUrl: string;
  model: string;
  apiKey: string;
  fallbacks: FallbackConfig[];
  global: boolean;
}

export interface InstallOptions {
  cwd: string;
  home?: string;
  global?: boolean;
  target?: InstallTarget;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fallbacks?: FallbackConfig[];
  update?: boolean;
  dryRun?: boolean;
  nonInteractive?: boolean;
  preset?: string;
  log?: (msg: string) => void;
}

export interface InstallReport {
  output: string[];
  warnings: string[];
  doctor: DoctorReport | null;
}

export interface UninstallOptions {
  cwd: string;
  home?: string;
  global?: boolean;
  target?: InstallTarget;
  purgeConfig?: boolean;
  dryRun?: boolean;
}

export interface UninstallReport {
  output: string[];
  removed: string[];
  skipped: string[];
  kept: string[];
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ---------------------------------------------------------------- wizard

async function collectInteractiveAnswers(seed: InstallOptions, env: NodeJS.ProcessEnv): Promise<InstallAnswers> {
  const presetSeed = seed.preset ? presetById(seed.preset) : undefined;

  const target = (await askMenu({
    prompt: "Which tool to enhance?",
    options: [
      { value: "claude", label: "Claude Code (hooks intercept Read automatically)" },
      { value: "codex", label: "Codex (MCP tool, invoked by the agent)" },
      { value: "both", label: "Both" },
    ],
    default: seed.target ?? env.DVLS_TARGET ?? "both",
  })) as InstallTarget;

  const presetId = await askMenu({
    prompt: "Vision endpoint preset",
    options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
    default: presetSeed?.id ?? env.DVLS_PRESET ?? "openrouter",
  });
  const preset = presetById(presetId);

  const baseUrl = await askInput({
    prompt: "Base URL (OpenAI-compatible, ends with /v1)",
    hint: "e.g. " + (preset?.baseUrl || "http://localhost:11434/v1"),
    default: seed.baseUrl ?? env.VISION_BASE_URL ?? preset?.baseUrl ?? DEFAULT_BASE_URL,
  });

  const apiKey = await askSecret({
    prompt: "API key (Enter to skip; stored in .deepseek-vl/config.json)",
    default: seed.apiKey ?? env.VISION_API_KEY ?? "",
  });

  const model = await askInput({
    prompt: "Vision model id",
    hint: "e.g. " + (preset?.model || "qwen2.5vl:7b"),
    default: seed.model ?? env.VISION_MODEL ?? preset?.model ?? "",
  });

  const fallbackRaw = await askInput({
    prompt: "Fallback models (Enter to skip; format: model@baseUrl, model2)",
    hint: "or JSON [{\"model\":\"...\",\"baseUrl\":\"...\"}]",
    default: "",
  });

  const global = (await askMenu({
    prompt: "Install scope",
    options: [
      { value: "project", label: "Project (.claude/ .codex/ in this directory)" },
      { value: "global", label: "Global (~/.claude ~/.codex)" },
    ],
    default: seed.global ? "global" : "project",
  })) === "global";

  return {
    target,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    model: model || "",
    apiKey,
    fallbacks: parseFallbacks(fallbackRaw),
    global,
  };
}

function collectNonInteractiveAnswers(opts: InstallOptions, env: NodeJS.ProcessEnv): InstallAnswers {
  const preset = opts.preset ? presetById(opts.preset) : undefined;
  const target = opts.target ?? (env.DVLS_TARGET as InstallTarget | undefined) ?? "both";
  const global = opts.global ?? env.DVLS_SCOPE === "global";
  const baseUrl = opts.baseUrl ?? env.VISION_BASE_URL ?? preset?.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.model ?? env.VISION_MODEL ?? preset?.model ?? "";
  const apiKey = opts.apiKey ?? env.VISION_API_KEY ?? "";
  const fallbacks = opts.fallbacks ?? parseFallbacks(env.VISION_FALLBACKS);
  return { target, baseUrl, model, apiKey, fallbacks, global };
}

// ---------------------------------------------------------------- file helpers

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

// ---------------------------------------------------------------- settings.json

interface SettingsFile {
  file: string;
  data: Record<string, unknown>;
}

function readSettings(file: string): SettingsFile | null {
  const raw = readTextFile(file);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) return null;
    return { file, data };
  } catch {
    throw new Error(`settings.json is not valid JSON; refusing to modify: ${file}`);
  }
}

/** True when the given hooks array already contains one of OUR entries. */
function hasOurHookEntry(entries: unknown[]): boolean {
  return entries.some((e) =>
    Array.isArray((e as { hooks?: unknown[] })?.hooks) &&
    (e as { hooks: unknown[] }).hooks.some(
      (h) => typeof (h as { command?: unknown })?.command === "string" &&
        ((h as { command: string }).command as string).includes(HOOK_COMMAND_IDENT),
    ),
  );
}

function hookEntriesAdded(settings: SettingsFile, event: string, command: string, startCommand: string): boolean {
  const hooks = (settings.data.hooks as Record<string, unknown[]> | undefined) ?? {};
  const arr = (hooks[event] as unknown[] | undefined) ?? [];
  if (hasOurHookEntry(arr)) return false;
  arr.push(
    event === "PreToolUse"
      ? { matcher: "Read", hooks: [{ type: "command", command, timeout: 60 }] }
      : { hooks: [{ type: "command", command: startCommand, timeout: 30 }] },
  );
  hooks[event] = arr;
  settings.data.hooks = hooks;
  return true;
}

function hookEntriesRemoved(settings: SettingsFile): number {
  const hooks = settings.data.hooks as Record<string, unknown[] | undefined> | undefined;
  if (!hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const arr = (hooks[event] as unknown[] | undefined) ?? [];
    const kept = arr.filter((e) => {
      const cmds = ((e as { hooks?: unknown[] })?.hooks ?? []) as unknown[];
      const isOurs = cmds.some(
        (h) => typeof (h as { command?: unknown })?.command === "string" &&
          ((h as { command: string }).command as string).includes(HOOK_COMMAND_IDENT),
      );
      if (isOurs) removed++;
      return !isOurs;
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed === 0) return 0;
  if (Object.keys(hooks).length === 0) delete settings.data.hooks;
  return removed;
}

// ---------------------------------------------------------------- .gitignore

function upsertGitignore(cwd: string, entry: string): boolean {
  const file = join(cwd, ".gitignore");
  const existing = readTextFile(file);
  if (existing !== null && existing.split(/\r?\n/).some((l) => l.trim() === entry)) return false;
  const content = `${existing?.trimEnd() ?? ""}${existing?.trimEnd() ? "\n" : ""}${entry}\n`;
  mkdirSync(cwd, { recursive: true });
  writeFileSync(file, content, "utf8");
  return true;
}

function removeGitignoreLine(cwd: string, entry: string): boolean {
  const file = join(cwd, ".gitignore");
  const existing = readTextFile(file);
  if (existing === null) return false;
  const lines = existing.split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== entry);
  if (kept.length === lines.length) return false;
  const hadTrailing = /(?:\r?\n)$/.test(existing);
  writeFileSync(file, kept.join("\n") + (kept.length && hadTrailing ? "\n" : ""), "utf8");
  return true;
}

// ---------------------------------------------------------------- install

async function installClaude(opts: InstallOptions, answers: InstallAnswers, report: InstallReport): Promise<void> {
  const log = opts.log ?? ((m: string) => report.output.push(m));
  const home = opts.home ?? homedir();
  const claudeDir = answers.global ? join(home, ".claude") : join(opts.cwd, ".claude");
  const settingsFile = join(claudeDir, "settings.json");
  const hooksDir = join(claudeDir, "hooks");
  const skillDir = join(claudeDir, "skills", SKILL_DIRNAME);
  const commandsDir = join(claudeDir, "commands");
  const commandFile = join(commandsDir, COMMAND_FILENAME);

  // hook command strings (global uses an expanded absolute path, JSON-escaped
  // at write time by JSON.stringify)
  const hookPath = join(hooksDir, HOOK_FILENAME);
  const hookCommand = answers.global
    ? `node "${hookPath}"`
    : `node .claude/hooks/${HOOK_FILENAME}`;
  const startCommand = `${hookCommand} start`;

  // 1) hook bundle
  const hookSource = readTextFile(packagedHookPath());
  if (hookSource === null) {
    report.warnings.push(
      `missing ${packagedHookPath()} — run \`npm run build\` first.`,
    );
  } else {
    writeManagedFile(hookPath, hookSource, { update: opts.update, dryRun: opts.dryRun, marker: HOOK_MARKER }, log, report.warnings);
  }

  // 2) skill
  const skillMd = readTextFile(templatePath("SKILL.md"));
  if (skillMd !== null) {
    writeManagedFile(join(skillDir, "SKILL.md"), skillMd, { update: opts.update, dryRun: opts.dryRun, marker: SKILL_MARKER }, log, report.warnings);
    const ref = readTextFile(templatePath("skill-references/vision-prompt.md"));
    if (ref !== null) {
      writeManagedFile(join(skillDir, "references", "vision-prompt.md"), ref, { update: opts.update, dryRun: opts.dryRun, marker: SKILL_MARKER }, log, report.warnings);
    }
  }

  // 3) slash command
  const cmdMd = readTextFile(templatePath("vision.md"));
  if (cmdMd !== null) {
    writeManagedFile(commandFile, cmdMd, { update: opts.update, dryRun: opts.dryRun, marker: COMMAND_MARKER }, log, report.warnings);
  }

  // 4) settings.json deep merge (append-only; backup before first write)
  const settings = readSettings(settingsFile);
  if (settings === null) {
    if (opts.dryRun) {
      log(`[dry-run] would create ${settingsFile} with hook entries`);
    } else {
      const data: Record<string, unknown> = { hooks: {} };
      const sf: SettingsFile = { file: settingsFile, data };
      hookEntriesAdded(sf, "PreToolUse", hookCommand, startCommand);
      hookEntriesAdded(sf, "SessionStart", hookCommand, startCommand);
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
      log(`wrote ${settingsFile}`);
    }
  } else {
    const addedPre = hookEntriesAdded(settings, "PreToolUse", hookCommand, startCommand);
    const addedStart = hookEntriesAdded(settings, "SessionStart", hookCommand, startCommand);
    if (addedPre || addedStart) {
      if (opts.dryRun) {
        log(`[dry-run] would merge hook entries into ${settingsFile}`);
      } else {
        const backup = backupFile(settingsFile);
        mkdirSync(join(settingsFile, ".."), { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings.data, null, 2) + "\n", "utf8");
        log(`merged hooks into ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`);
      }
    } else {
      log(`settings.json already contains our hook entries — idempotent, no change.`);
    }
  }

  log(`Claude Code: restart your session for hooks to take effect.`);
}

async function installCodex(opts: InstallOptions, answers: InstallAnswers, report: InstallReport): Promise<void> {
  const log = opts.log ?? ((m: string) => report.output.push(m));
  const home = opts.home ?? homedir();
  const codexDir = answers.global ? join(home, ".codex") : join(opts.cwd, ".codex");
  const configToml = join(codexDir, "config.toml");
  const agentsFile = join(codexDir, "AGENTS.md");
  const version = readVersion(packageRoot());

  if (opts.dryRun) {
    log(`[dry-run] would add [mcp_servers.${MCP_SERVER_NAME}] to ${configToml} (npx -y ${PKG_NAME}@${version} mcp)`);
    log(`[dry-run] would inject AGENTS.md block into ${agentsFile}`);
  } else {
    const r1 = upsertMcpSection(configToml, version);
    log(
      r1.changed
        ? `added [mcp_servers.${MCP_SERVER_NAME}] to ${configToml} (npx -y ${PKG_NAME}@${version} mcp, tool_timeout_sec=180)${r1.backup ? ` (backup: ${r1.backup})` : ""}`
        : `config.toml already has [mcp_servers.${MCP_SERVER_NAME}] — idempotent, no change.`,
    );
    const r2 = upsertAgentsBlock(agentsFile);
    log(
      r2.changed
        ? `${AGENTS_START_MARKER} block written to ${agentsFile}${r2.backup ? ` (backup: ${r2.backup})` : ""}`
        : `AGENTS.md already has our block — idempotent, no change.`,
    );
  }

  // models.json bug fix (#36382)
  const modelsPath = findModelsJson(opts.cwd, home);
  if (modelsPath === null) {
    log(
      `models.json not found — MCP tools may be hidden by the DeepSeek models.json bug. ` +
        `If "mcp__deepseek-vl__*" tools are invisible, fix ~/.codex/models.json: set "supports_search_tool": false. ` +
        `models.json not found; if MCP tools are not visible, set supports_search_tool to false for the DeepSeek entry in models.json.`,
    );
  } else if (opts.dryRun) {
    log(`[dry-run] would check/fix ${modelsPath} (supports_search_tool)`);
  } else {
    const fix = fixModelsJson(modelsPath);
    if (fix.changed) {
      log(
        `fixed models.json bug (#36382) in ${modelsPath}: ${fix.fixedEntries.join(", ")} supports_search_tool=true -> false${fix.backup ? ` (backup: ${fix.backup})` : ""}`,
      );
    } else {
      log(`models.json OK (no DeepSeek entries with supports_search_tool=true). ${modelsPath}`);
    }
  }

  const toml = readTextFile(configToml);
  if (toml !== null && !toml.includes("wire_api")) {
    report.warnings.push(
      `hint: if you use DeepSeek with Codex, ensure your [model_providers.deepseek] section has \`wire_api = "chat"\` and a non-reasoning model (v4-r1/reasoning models do not support function calling).`,
    );
  }
  log(`Codex: restart your Codex session; verify with \`codex mcp list\`.`);
}

export async function runInstall(opts: InstallOptions): Promise<InstallReport> {
  const report: InstallReport = { output: [], warnings: [], doctor: null };
  const log = opts.log ?? ((m: string) => report.output.push(m));
  const env = process.env;

  const interactive = !opts.nonInteractive && isInteractive();
  const answers = interactive ? await collectInteractiveAnswers(opts, env) : collectNonInteractiveAnswers(opts, env);

  const home = opts.home ?? homedir();
  const configDir = answers.global ? globalConfigDir(home) : join(opts.cwd, CONFIG_DIR);
  const configFile = join(configDir, "config.json");

  log(`deepseek-vl-support installer (target: ${answers.target}, scope: ${answers.global ? "global" : "project"})`);

  // 1) config.json (deep-merge write)
  if (opts.dryRun) {
    log(`[dry-run] would write config to ${configFile} (baseUrl=${answers.baseUrl}, model=${answers.model || "(unset)"}, fallbacks=${answers.fallbacks.length})`);
  } else {
    const merged = writeConfigFile(configFile, {
      baseUrl: answers.baseUrl,
      model: answers.model,
      apiKey: answers.apiKey,
      fallbacks: answers.fallbacks,
    });
    log(`config written: ${configFile}${merged.model ? "" : " (model not set!)"}`);
  }

  // 2) .gitignore (project scope only — protects the API key from git)
  if (!answers.global) {
    if (opts.dryRun) {
      log(`[dry-run] would append "${GITIGNORE_ENTRY}" to ${join(opts.cwd, ".gitignore")}`);
    } else if (upsertGitignore(opts.cwd, GITIGNORE_ENTRY)) {
      log(`appended "${GITIGNORE_ENTRY}" to .gitignore (config + cache stay out of git)`);
    } else {
      log(`.gitignore already contains "${GITIGNORE_ENTRY}"`);
    }
  }

  // 3) per-target artifacts
  if (answers.target === "claude" || answers.target === "both") await installClaude(opts, answers, report);
  if (answers.target === "codex" || answers.target === "both") await installCodex(opts, answers, report);

  // 4) doctor self-check
  log(`-- doctor self-check --`);
  if (opts.dryRun) {
    log(`[dry-run] (doctor skipped)`);
  } else {
    const doctor = await runDoctor({ cwd: opts.cwd, home });
    report.doctor = doctor;
    report.output.push(...doctor.lines);
    if (!doctor.ok) {
      report.warnings.push(
        `doctor found problems (see above). Run \`npx deepseek-vl-support doctor\` after fixing.`,
      );
    }
  }
  report.warnings.forEach((w) => report.output.push(`[WARN] ${w}`));
  return report;
}

// ---------------------------------------------------------------- uninstall

function removeFileIfManaged(
  target: string,
  marker: string,
  report: UninstallReport,
  opts: { dryRun?: boolean },
): void {
  if (!existsSync(target)) {
    report.output.push(`skip (not found): ${target}`);
    return;
  }
  const content = readTextFile(target) ?? "";
  if (!content.includes(marker)) {
    report.skipped.push(`${target} (exists without our marker, user-authored, kept)`);
    return;
  }
  if (opts.dryRun) {
    report.output.push(`[dry-run] would delete ${target}`);
    return;
  }
  rmSync(target, { recursive: true, force: true });
  report.removed.push(target);
}

async function uninstallClaude(opts: UninstallOptions, report: UninstallReport, log: (m: string) => void): Promise<void> {
  const home = opts.home ?? homedir();
  const claudeDir = opts.global ? join(home, ".claude") : join(opts.cwd, ".claude");
  const settingsFile = join(claudeDir, "settings.json");
  const hooksDir = join(claudeDir, "hooks");
  const skillDir = join(claudeDir, "skills", SKILL_DIRNAME);
  const commandFile = join(claudeDir, "commands", COMMAND_FILENAME);

  const settings = readSettings(settingsFile);
  if (settings) {
    const removed = hookEntriesRemoved(settings);
    if (removed > 0) {
      if (opts.dryRun) {
        log(`[dry-run] would remove ${removed} hook entry(ies) from ${settingsFile}`);
      } else {
        const backup = backupFile(settingsFile);
        mkdirSync(join(settingsFile, ".."), { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings.data, null, 2) + "\n", "utf8");
        report.removed.push(`${settingsFile} (${removed} hook entry)${backup ? `, backup ${backup}` : ""}`);
        log(`removed ${removed} hook entry(ies) from ${settingsFile}`);
      }
    } else {
      log(`no deepseek-vl-support hook entries in ${settingsFile}`);
    }
  } else if (existsSync(settingsFile)) {
    log(`settings.json invalid JSON — left untouched: ${settingsFile}`);
  }

  removeFileIfManaged(join(hooksDir, HOOK_FILENAME), HOOK_MARKER, report, opts);
  removeFileIfManaged(join(skillDir, "references", "vision-prompt.md"), SKILL_MARKER, report, opts);
  removeFileIfManaged(join(skillDir, "SKILL.md"), SKILL_MARKER, report, opts);
  // remove the skill directory tree once all managed files are gone
  // (only removes directories; any user-authored leftovers keep the tree)
  if (!opts.dryRun && existsSync(skillDir)) {
    report.removed.push(...removeEmptyDirTree(skillDir));
  }
  removeFileIfManaged(commandFile, COMMAND_MARKER, report, opts);
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
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

async function uninstallCodex(opts: UninstallOptions, report: UninstallReport, log: (m: string) => void): Promise<void> {
  const home = opts.home ?? homedir();
  const codexDir = opts.global ? join(home, ".codex") : join(opts.cwd, ".codex");
  const configToml = join(codexDir, "config.toml");
  const agentsFile = join(codexDir, "AGENTS.md");

  if (opts.dryRun) {
    log(`[dry-run] would remove [mcp_servers.${MCP_SERVER_NAME}] from ${configToml} and the AGENTS.md block from ${agentsFile}`);
  } else {
    const r1 = removeMcpSection(configToml);
    if (r1.changed) {
      report.removed.push(`${configToml} ([mcp_servers.${MCP_SERVER_NAME}] section)${r1.backup ? `, backup ${r1.backup}` : ""}`);
      log(`removed [mcp_servers.${MCP_SERVER_NAME}] section from ${configToml}`);
    } else {
      log(`no [mcp_servers.${MCP_SERVER_NAME}] section in ${configToml}`);
    }
    const r2 = removeAgentsBlock(agentsFile);
    if (r2.changed) {
      report.removed.push(`${agentsFile} (AGENTS.md block)${r2.backup ? `, backup ${r2.backup}` : ""}`);
      log(`removed AGENTS.md block from ${agentsFile}`);
    } else {
      log(`no deepseek-vl-support block in ${agentsFile}`);
    }
  }
  report.kept.push(
    `models.json fixes are NOT reverted automatically (they are safe/helpful).`,
  );
}

export async function runUninstall(opts: UninstallOptions): Promise<UninstallReport> {
  const report: UninstallReport = { output: [], removed: [], skipped: [], kept: [] };
  const log = (m: string) => report.output.push(m);
  const target = opts.target ?? "both";
  const home = opts.home ?? homedir();

  log(`deepseek-vl-support uninstaller (target: ${target}, scope: ${opts.global ? "global" : "project"})`);

  if (target === "claude" || target === "both") await uninstallClaude(opts, report, log);
  if (target === "codex" || target === "both") await uninstallCodex(opts, report, log);

  // .gitignore line: only with --purge-config
  const configDir = opts.global ? globalConfigDir(home) : join(opts.cwd, CONFIG_DIR);
  if (opts.purgeConfig) {
    if (!opts.global && !opts.dryRun && removeGitignoreLine(opts.cwd, GITIGNORE_ENTRY)) {
      report.removed.push(join(opts.cwd, ".gitignore") + ` ("${GITIGNORE_ENTRY}" line)`);
      log(`removed "${GITIGNORE_ENTRY}" from .gitignore`);
    }
    if (opts.dryRun) {
      log(`[dry-run] would delete ${configDir} (config + cache)`);
    } else if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
      report.removed.push(configDir);
      log(`deleted ${configDir} (--purge-config)`);
    } else {
      log(`no ${configDir}`);
    }
  } else {
    report.kept.push(`${configDir} (config.json + cache kept; --purge-config deletes it)`);
    log(`config + cache kept (use --purge-config to delete)`);
  }

  report.kept.push(`backups (.bak) kept for manual rollback.`);
  report.skipped.forEach((s) => report.output.push(`[SKIP] ${s}`));
  report.removed.forEach((r) => report.output.push(`[REMOVED] ${r}`));
  report.kept.forEach((k) => report.output.push(`[KEPT] ${k}`));
  return report;
}
