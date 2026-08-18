// Installer: numbered-menu wizard (interactive) or flags/env (CI). A single
// flat agent list of 22 targets — claude, codex, opencode (native installs:
// Claude Code
// hook + skill + slash command + settings.json deep-merge; Codex config.toml
// MCP section + AGENTS.md block + models.json fix + project-scope
// .agents/skills/ write), qwen, reasonix, kilo, workbuddy, devin (native
// CLI-agent installs, see src/cliagents.ts), trae, pi, omp, dsh (skill
// installs, see src/skillagents.ts) and copilot, cursor, kiro, openclaw,
// hermes, vscode, chatgpt-codex, grok, nanoclaw, other (Agent Plugins mode:
// materialize the plugin dir + per-client registration). Idempotent
// re-install and marker-based uninstall; --target takes a comma-separated
// agent list.
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
  HOOK_FILENAME,
  HOOK_MARKER,
  MCP_SERVER_NAME,
  PKG_NAME,
  SKILL_DIRNAME,
  SKILL_MARKER,
} from "./identity.ts";
import { packageRoot, packagedHookPath, templatePath } from "./paths.ts";
import { hasOurHookEntry, hookEntriesAdded, hookEntriesRemoved } from "./hooksettings.ts";
import type { SettingsFile } from "./hooksettings.ts";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENTS,
  clientHasDetector,
  detectPluginClients,
  installPluginClients,
  isPluginAgent,
  materializePluginDir,
  pluginDir,
  uninstallPluginClients,
  PLUGIN_CLIENTS,
} from "./plugin.ts";
import type { Agent, PluginClient } from "./plugin.ts";
import {
  detectSkillModuleAgents,
  installSkillAgents,
  NOT_DETECTED_HINTS,
  SKILL_MODULE_AGENTS,
  uninstallSkillAgents,
  writeSharedAgentsSkill,
} from "./skillagents.ts";
import type { SkillModuleAgent } from "./skillagents.ts";
import {
  CLI_AGENTS,
  CLI_NOT_DETECTED_HINTS,
  detectCliAgents,
  installCliAgents,
  uninstallCliAgents,
} from "./cliagents.ts";
import type { CliAgent } from "./cliagents.ts";
import { askInput, askMenu, askMultiMenu, askSecret } from "./wizard.ts";
import type { MenuSpec, MultiMenuSpec } from "./wizard.ts";

export type AgentStatus = "ok" | "skipped" | "failed" | "manual";

/** Per-agent result: the unified report shape for every selected agent —
 *  native claude/codex entries and plugin clients alike. */
export interface AgentResult {
  agent: Agent;
  status: AgentStatus;
  detail: string;
}

/** Outcome of one agent's install/uninstall step (the agent field is filled
 *  in by the driver). */
interface AgentOutcome {
  status: "ok" | "failed";
  detail: string;
}

/** Parse a comma-separated --target / DVLS_TARGET value into a validated
 *  agent list. Absent/empty → the default (claude + codex, the former
 *  "both"). Unknown names — including the removed "both" and "plugin"
 *  values — are rejected with an error listing the valid agents. */
export function parseTargets(raw: string | undefined): Agent[] {
  if (raw === undefined || raw.trim() === "") return ["claude", "codex"];
  const out: Agent[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (!(AGENTS as readonly string[]).includes(t)) {
      throw new Error(`invalid target: "${part.trim()}" (expected one of: ${AGENTS.join(",")})`);
    }
    out.push(t as Agent);
  }
  return [...new Set(out)];
}

/** Build the wizard's first step: ONE multi-select of all 22 agents with
 *  pure-name labels (R5: no detection annotations, no explanatory
 *  parentheses). The default is claude + codex plus every agent detected on
 *  this machine (plugin clients and the skill-module agents
 *  opencode/trae/pi/omp/dsh). Selected-but-undetected agents are warned about
 *  later, at install time (runInstall). Exported for tests. */
export function agentMenuSpec(home: string, env: NodeJS.ProcessEnv = process.env): MultiMenuSpec {
  const detected = detectPluginClients(home, env);
  const skillDetected = detectSkillModuleAgents(home, env);
  const cliDetected = detectCliAgents(home, env);
  return {
    prompt: "Which agents should get vision?",
    options: AGENTS.map((a) => ({ value: a, label: AGENT_LABELS[a] })),
    default: [
      "claude",
      "codex",
      ...PLUGIN_CLIENTS.filter((c) => detected[c].detected),
      ...SKILL_MODULE_AGENTS.filter((a) => skillDetected[a].detected),
      ...CLI_AGENTS.filter((a) => cliDetected[a].detected),
    ],
  };
}

/** True when the wizard asks the install-scope question: any native agent
 *  (claude/codex/opencode plus the CLI agents qwen/reasonix/kilo/workbuddy/
 *  devin) is selected. Skill agents (trae/pi/omp/dsh) are project-level only
 *  and plugin clients are always global. Exported for tests. */
export function needsScopeQuestion(targets: Agent[]): boolean {
  return targets.some((a) => AGENT_KINDS[a] === "native");
}

/** Step 2 menu spec: the endpoint presets plus the "Decide later" escape
 *  hatch (R4), which is NOT a real preset — presetById("later") stays
 *  undefined; non-interactive --preset later is handled separately.
 *  Exported for tests. */
export function presetMenuSpec(seed: InstallOptions, env: NodeJS.ProcessEnv): MenuSpec {
  return {
    prompt: "Vision endpoint preset",
    options: [...PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "later", label: "Decide later" }],
    default: seed.preset ?? env.DVLS_PRESET ?? "openrouter",
  };
}

/** Step 7 menu spec: the install-scope question. Project is first and the
 *  default (R3); the "(recommended)" marker is the one R5 exception to the
 *  pure-label rule. Exported for tests. */
export function scopeMenuSpec(seed: InstallOptions): MenuSpec {
  return {
    prompt: "Install scope",
    options: [
      { value: "project", label: "Project (recommended, this directory)" },
      { value: "global", label: "Global (all projects)" },
    ],
    default: seed.global ? "global" : "project",
  };
}

/** Warning block shown when the user picks "Decide later" (R4): vision stays
 *  off until a model is configured. */
export const DECIDE_LATER_WARNING =
  `⚠ Vision not configured: images cannot be described until a model is set.\n` +
  `  Later: npx ${PKG_NAME} config set baseUrl <url> [--global]\n` +
  `         npx ${PKG_NAME} config set model <id> [--global]\n` +
  `         (or VISION_BASE_URL / VISION_MODEL environment variables)`;

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

// Preset order follows D2: remote APIs first, local endpoints last.
export const PRESETS: Preset[] = [
  { id: "openrouter", label: "OpenRouter (cloud)", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen2.5-vl-72b-instruct" },
  { id: "moonshot", label: "Moonshot (cloud)", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k-vision-preview" },
  { id: "minimax", label: "MiniMax (cloud)", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-VL-01" },
  { id: "zhipu", label: "Zhipu GLM (cloud)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-flash" },
  { id: "stepfun", label: "StepFun (cloud)", baseUrl: "https://api.stepfun.com/v1", model: "step-1o-turbo-vision" },
  { id: "opencodezen", label: "OpenCode Zen (cloud)", baseUrl: "https://opencode.ai/zen/v1", model: "mimo-v2.5-free" },
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
  targets: Agent[];
  baseUrl: string;
  model: string;
  apiKey: string;
  fallbacks: FallbackConfig[];
  /** Chosen scope for the native claude/codex/opencode artifacts. Plugin
   *  agents are always global; runInstall derives the effective config scope
   *  from `targets` (any plugin agent ⇒ global config). */
  global: boolean;
  /** Advisory lines produced during answer collection (e.g. the "Decide
   *  later" warning); printed verbatim by runInstall before the install
   *  steps. */
  notes: string[];
}

export interface InstallOptions {
  cwd: string;
  home?: string;
  global?: boolean;
  targets?: Agent[];
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fallbacks?: FallbackConfig[];
  /** Backward-compatible filter for plugin agents: effective plugin clients
   *  = targets ∩ clients (non-interactive runs only; the wizard selects
   *  agents directly). */
  clients?: PluginClient[];
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
  /** Per-agent results for every selected agent, plugin clients included. */
  agents?: AgentResult[];
}

export interface UninstallOptions {
  cwd: string;
  home?: string;
  global?: boolean;
  targets?: Agent[];
  clients?: PluginClient[];
  purgeConfig?: boolean;
  dryRun?: boolean;
}

export interface UninstallReport {
  output: string[];
  removed: string[];
  skipped: string[];
  kept: string[];
  warnings: string[];
  /** Per-agent results for every selected agent, plugin clients included. */
  agents?: AgentResult[];
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
  const home = seed.home ?? homedir();
  const notes: string[] = [];

  // Step 1: ONE multi-select of all 22 agents (replaces the old
  // claude/codex/both/plugin single-choice menu AND the plugin-client step).
  const targets = (await askMultiMenu(agentMenuSpec(home, env))) as Agent[];

  const presetId = await askMenu(presetMenuSpec(seed, env));
  const preset = presetById(presetId);

  // Step 2b: "Decide later" (R4) — skip the four endpoint questions and warn
  // that vision stays off until a model is configured. Explicit --flags / env
  // values still win; with nothing set the config ends up without a model.
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let fallbacks: FallbackConfig[];
  if (presetId === "later") {
    baseUrl = seed.baseUrl ?? env.VISION_BASE_URL ?? DEFAULT_BASE_URL;
    apiKey = seed.apiKey ?? env.VISION_API_KEY ?? "";
    model = seed.model ?? env.VISION_MODEL ?? "";
    fallbacks = seed.fallbacks ?? parseFallbacks(env.VISION_FALLBACKS);
    if (!model) notes.push(DECIDE_LATER_WARNING);
  } else {
    baseUrl = await askInput({
      prompt: "Base URL (OpenAI-compatible, ends with /v1)",
      hint: "e.g. " + (preset?.baseUrl || "http://localhost:11434/v1"),
      default: seed.baseUrl ?? env.VISION_BASE_URL ?? preset?.baseUrl ?? DEFAULT_BASE_URL,
    });

    apiKey = await askSecret({
      prompt: "API key (Enter to skip; stored in .deepseek-vl/config.json)",
      default: seed.apiKey ?? env.VISION_API_KEY ?? "",
    });

    model = await askInput({
      prompt: "Vision model id",
      hint: "e.g. " + (preset?.model || "qwen2.5vl:7b"),
      default: seed.model ?? env.VISION_MODEL ?? preset?.model ?? "",
    });

    const fallbackRaw = await askInput({
      prompt: "Fallback models (Enter to skip; format: model@baseUrl, model2)",
      hint: "or JSON [{\"model\":\"...\",\"baseUrl\":\"...\"}]",
      default: "",
    });
    fallbacks = parseFallbacks(fallbackRaw);
  }

  // The scope question is asked only when a native install
  // (claude/codex/opencode) is selected; plugin agents are always global and
  // skill agents (trae/pi/omp/dsh) are project-level only. When none is
  // native the step is skipped entirely (endpoint config is written to the
  // global ~/.deepseek-vl/config.json for plugin runs, project-local
  // otherwise).
  const global =
    needsScopeQuestion(targets) &&
    (await askMenu(scopeMenuSpec(seed))) === "global";

  return {
    targets,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    model: model || "",
    apiKey,
    fallbacks,
    global,
    notes,
  };
}

function collectNonInteractiveAnswers(opts: InstallOptions, env: NodeJS.ProcessEnv): InstallAnswers {
  const preset = opts.preset ? presetById(opts.preset) : undefined;
  const targets = parseTargets(opts.targets ? opts.targets.join(",") : env.DVLS_TARGET);
  const global = opts.global ?? env.DVLS_SCOPE === "global";
  const baseUrl = opts.baseUrl ?? env.VISION_BASE_URL ?? preset?.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.model ?? env.VISION_MODEL ?? preset?.model ?? "";
  const apiKey = opts.apiKey ?? env.VISION_API_KEY ?? "";
  const fallbacks = opts.fallbacks ?? parseFallbacks(env.VISION_FALLBACKS);
  const notes: string[] = [];
  // --preset later (R4): same meaning as the interactive "Decide later" —
  // no preset values, model stays empty unless explicitly given.
  if (opts.preset === "later" && !model) notes.push(DECIDE_LATER_WARNING);
  return { targets, baseUrl, model, apiKey, fallbacks, global, notes };
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

async function installClaude(opts: InstallOptions, answers: InstallAnswers, report: InstallReport): Promise<AgentOutcome> {
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
    const msg = `missing ${packagedHookPath()} — run \`npm run build\` first`;
    report.warnings.push(msg);
    // the remaining artifacts still install (existing behavior), but the
    // agent entry reports the incomplete install
    return { status: "failed", detail: msg };
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
  return {
    status: "ok",
    detail: `hook + skill + /vision command + settings.json hooks (scope: ${answers.global ? "global" : "project"})${opts.dryRun ? " [dry-run, nothing written]" : ""}`,
  };
}

async function installCodex(opts: InstallOptions, answers: InstallAnswers, report: InstallReport): Promise<AgentOutcome> {
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

  // 5) .agents/skills (project scope only): many tools follow the Codex
  //    skill contract and read skills from <project>/.agents/skills/
  //    (<name>/SKILL.md) — Cursor, GitHub Copilot, Kimi Code, and the
  //    skill-copy agents (opencode/trae/pi/dsh). Global installs skip it (it
  //    is a project-level convention) and mention the skip. Shared helper in
  //    skillagents.ts; the content is the packaged skill (assets/SKILL.md,
  //    committed as skills/deepseek-vision/SKILL.md), which carries
  //    SKILL_MARKER so uninstall can tell our file from a user-authored one.
  writeSharedAgentsSkill(opts.cwd, { global: answers.global, update: opts.update, dryRun: opts.dryRun }, report, log);

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
  const agentsSkills = answers.global
    ? " (global scope; .agents/skills/ skipped — project-level convention)"
    : " + .agents/skills/deepseek-vision/ (project scope)";
  return {
    status: "ok",
    detail: `MCP server section + AGENTS.md block + models.json fix${agentsSkills}${opts.dryRun ? " [dry-run, nothing written]" : ""}`,
  };
}

export async function runInstall(opts: InstallOptions): Promise<InstallReport> {
  const report: InstallReport = { output: [], warnings: [], doctor: null };
  const log = opts.log ?? ((m: string) => report.output.push(m));
  const env = process.env;

  const interactive = !opts.nonInteractive && isInteractive();
  const answers = interactive ? await collectInteractiveAnswers(opts, env) : collectNonInteractiveAnswers(opts, env);

  const home = opts.home ?? homedir();
  const pluginDetection = detectPluginClients(home, env);
  const skillDetection = detectSkillModuleAgents(home, env);
  const cliDetection = detectCliAgents(home, env);
  const hasPlugin = answers.targets.some(isPluginAgent);
  // Plugin agents are always global: their MCP subprocesses resolve config as
  // env > global > defaults and cannot see project configs. Mixed runs
  // (e.g. claude + copilot) therefore write the endpoint config globally; a
  // project-scope claude install still resolves it via the project → global
  // fallback in resolveConfig(). Skill agents (trae/pi/dsh) never globalize.
  const configGlobal = hasPlugin || answers.global;
  const configDir = configGlobal ? globalConfigDir(home) : join(opts.cwd, CONFIG_DIR);
  const configFile = join(configDir, "config.json");

  log(`deepseek-vl-support installer (targets: ${answers.targets.join(",")}, scope: ${configGlobal ? "global" : "project"})`);

  // R5: warn about selected-but-undetected agents that HAVE a detector —
  // claude/codex (no detector) and `other` (no detection surface) are never
  // annotated, exactly like before the wizard labels were cleaned up.
  // Non-blocking: the per-agent drivers still print their manual guidance
  // below, and other agents install normally.
  const detectedById = new Map<Agent, boolean>();
  for (const c of PLUGIN_CLIENTS) {
    if (clientHasDetector(c)) detectedById.set(c, pluginDetection[c].detected);
  }
  for (const a of SKILL_MODULE_AGENTS) detectedById.set(a, skillDetection[a].detected);
  for (const a of CLI_AGENTS) detectedById.set(a, cliDetection[a].detected);
  for (const a of answers.targets) {
    if (detectedById.get(a) === false) {
      const hint = (NOT_DETECTED_HINTS as Record<string, string | undefined>)[a]
        ?? (CLI_NOT_DETECTED_HINTS as Record<string, string | undefined>)[a];
      log(`⚠ ${AGENT_LABELS[a]} was not detected on this machine — install it first${hint ? ` (${hint})` : ""}.`);
    }
  }
  // advisory notes collected during answer collection ("Decide later")
  for (const n of answers.notes) log(n);

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
  if (!configGlobal) {
    if (opts.dryRun) {
      log(`[dry-run] would append "${GITIGNORE_ENTRY}" to ${join(opts.cwd, ".gitignore")}`);
    } else if (upsertGitignore(opts.cwd, GITIGNORE_ENTRY)) {
      log(`appended "${GITIGNORE_ENTRY}" to .gitignore (config + cache stay out of git)`);
    } else {
      log(`.gitignore already contains "${GITIGNORE_ENTRY}"`);
    }
  }

  // 3) per-agent artifacts (aggregate results across all selected agents)
  const agents: AgentResult[] = [];
  for (const agent of answers.targets) {
    if (agent === "claude" || agent === "codex") {
      try {
        const out = agent === "claude"
          ? await installClaude(opts, answers, report)
          : await installCodex(opts, answers, report);
        agents.push({ agent, status: out.status, detail: out.detail });
      } catch (e) {
        agents.push({
          agent,
          status: "failed",
          detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  const skillTargets = answers.targets.filter(
    (a): a is SkillModuleAgent => a === "opencode" || AGENT_KINDS[a] === "skill",
  );
  if (skillTargets.length > 0) {
    agents.push(
      ...(await installSkillAgents(
        {
          cwd: opts.cwd,
          home,
          global: answers.global,
          update: opts.update,
          dryRun: opts.dryRun,
          agents: skillTargets,
          log,
          warnings: report.warnings,
        },
        skillDetection,
      )),
    );
  }
  const cliTargets = answers.targets.filter((a): a is CliAgent => (CLI_AGENTS as readonly string[]).includes(a));
  if (cliTargets.length > 0) {
    agents.push(
      ...(await installCliAgents(
        {
          cwd: opts.cwd,
          home,
          global: answers.global,
          update: opts.update,
          dryRun: opts.dryRun,
          agents: cliTargets,
          log,
          warnings: report.warnings,
        },
        cliDetection,
      )),
    );
  }
  if (hasPlugin) {
    agents.push(...(await installPluginAgents(opts, answers, report)));
  }
  report.agents = agents;
  for (const r of agents) log(`[${r.agent}] ${r.status}: ${r.detail}`);
  const failed = agents.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    report.warnings.push(`${failed.length} agent(s) failed — see the per-agent lines above for guidance.`);
  }

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

// ---------------------------------------------------------------- Agent Plugins agents

/** Agent Plugins install for the selected plugin agents: materialize
 *  ~/.deepseek-vl/plugin/ once from the package root, then register with each
 *  selected client (failure-isolated inside installPluginClients). Returns
 *  per-agent results in the unified report shape. */
async function installPluginAgents(opts: InstallOptions, answers: InstallAnswers, report: InstallReport): Promise<AgentResult[]> {
  const log = opts.log ?? ((m: string) => report.output.push(m));
  const home = opts.home ?? homedir();
  const destRoot = pluginDir(home);
  const selected = answers.targets.filter(isPluginAgent);

  // 1) materialize the plugin dir (idempotent overwrite; refreshed each install)
  const materialized = materializePluginDir(packageRoot(), destRoot, opts.dryRun ?? false);
  if (materialized.missing.length > 0) {
    report.warnings.push(
      `missing package files: ${materialized.missing.join(", ")} — run \`npm run build\` first.`,
    );
    return selected.map((client) => ({
      agent: client,
      status: "failed" as const,
      detail: "missing packaged plugin files — run `npm run build` first",
    }));
  }
  for (const dest of materialized.written) {
    log(opts.dryRun ? `[dry-run] would write ${dest}` : `materialized ${dest}`);
  }

  // 2) per-client registration: effective clients = targets ∩ --clients
  //    (--clients is a backward-compatible filter for non-interactive runs)
  const clients = (opts.clients ?? selected).filter((c) =>
    (selected as readonly PluginClient[]).includes(c),
  );
  if (opts.clients !== undefined && clients.length === 0) {
    report.warnings.push(
      `--clients ${opts.clients.join(",")} does not intersect the selected plugin agents (${selected.join(",")}) — nothing registered.`,
    );
  }

  const detection = detectPluginClients(home);
  const results = await installPluginClients(
    { home, pluginDir: destRoot, clients, dryRun: opts.dryRun, env: process.env },
    detection,
  );
  return results.map((r) => ({ agent: r.client, status: r.status, detail: r.detail }));
}

/** Agent Plugins uninstall: unregister each selected client (reverse of
 *  install); the materialized plugin dir is removed only via --purge-config
 *  (it lives inside the config dir and is deleted with it). */
async function uninstallPluginAgents(opts: UninstallOptions, report: UninstallReport): Promise<AgentResult[]> {
  const home = opts.home ?? homedir();
  const destRoot = pluginDir(home);
  const selected = (opts.targets ?? ["claude", "codex"]).filter(isPluginAgent);
  const clients = (opts.clients ?? selected).filter((c) =>
    (selected as readonly PluginClient[]).includes(c),
  );

  const detection = detectPluginClients(home);
  const results = await uninstallPluginClients(
    { home, pluginDir: destRoot, clients, dryRun: opts.dryRun, env: process.env },
    detection,
  );
  return results.map((r) => ({ agent: r.client, status: r.status, detail: r.detail }));
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

  // .agents/skills (project scope only): remove ONLY our deepseek-vision
  // skill dir. Sibling skills in .agents/skills/ are never touched, and
  // removeEmptyDirTree deletes only directories that became empty (any
  // user-authored leftover keeps the tree).
  if (!opts.global) {
    const agentsSkillsDir = join(opts.cwd, ".agents", "skills", SKILL_DIRNAME);
    removeFileIfManaged(join(agentsSkillsDir, "references", "vision-prompt.md"), SKILL_MARKER, report, opts);
    removeFileIfManaged(join(agentsSkillsDir, "SKILL.md"), SKILL_MARKER, report, opts);
    if (!opts.dryRun && existsSync(agentsSkillsDir)) {
      report.removed.push(...removeEmptyDirTree(agentsSkillsDir));
    }
  }

  report.kept.push(
    `models.json fixes are NOT reverted automatically (they are safe/helpful).`,
  );
}

export async function runUninstall(opts: UninstallOptions): Promise<UninstallReport> {
  const report: UninstallReport = { output: [], removed: [], skipped: [], kept: [], warnings: [] };
  const log = (m: string) => report.output.push(m);
  const targets = opts.targets ?? ["claude", "codex"];
  const home = opts.home ?? homedir();
  const hasPlugin = targets.some(isPluginAgent);
  // Mirror of the install side: plugin agents are always global, so a run
  // that includes any plugin agent considers the config global.
  const configGlobal = hasPlugin || opts.global;

  log(`deepseek-vl-support uninstaller (targets: ${targets.join(",")}, scope: ${configGlobal ? "global" : "project"})`);

  // per-agent artifact removal (aggregate results across all selected agents)
  const agents: AgentResult[] = [];
  for (const agent of targets) {
    if (agent === "claude") {
      try {
        await uninstallClaude(opts, report, log);
        agents.push({ agent, status: "ok", detail: "artifacts removed (see [REMOVED] lines above)" });
      } catch (e) {
        agents.push({ agent, status: "failed", detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else if (agent === "codex") {
      try {
        await uninstallCodex(opts, report, log);
        agents.push({
          agent,
          status: "ok",
          detail: `MCP section + AGENTS.md block removed${opts.global ? "" : " + .agents/skills/deepseek-vision/"}`,
        });
      } catch (e) {
        agents.push({ agent, status: "failed", detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  const skillTargets = targets.filter(
    (a): a is SkillModuleAgent => a === "opencode" || AGENT_KINDS[a] === "skill",
  );
  if (skillTargets.length > 0) {
    agents.push(
      ...(await uninstallSkillAgents(
        { cwd: opts.cwd, home, global: opts.global, dryRun: opts.dryRun, agents: skillTargets },
        detectSkillModuleAgents(home),
      )),
    );
  }
  const cliTargets = targets.filter((a): a is CliAgent => (CLI_AGENTS as readonly string[]).includes(a));
  if (cliTargets.length > 0) {
    agents.push(
      ...(await uninstallCliAgents(
        { cwd: opts.cwd, home, global: opts.global, dryRun: opts.dryRun, agents: cliTargets },
        detectCliAgents(home),
      )),
    );
  }
  if (hasPlugin) {
    agents.push(...(await uninstallPluginAgents(opts, report)));
  }
  report.agents = agents;
  for (const r of agents) log(`[${r.agent}] ${r.status}: ${r.detail}`);
  const failed = agents.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    report.warnings.push(`${failed.length} agent(s) failed — see the per-agent lines above for guidance.`);
  }

  // config: with --purge-config the config dir (incl. the materialized
  // plugin dir, which lives inside it) is deleted; project-scope runs also
  // drop the .gitignore line
  const configDir = configGlobal ? globalConfigDir(home) : join(opts.cwd, CONFIG_DIR);
  if (opts.purgeConfig) {
    if (!configGlobal && !opts.dryRun && removeGitignoreLine(opts.cwd, GITIGNORE_ENTRY)) {
      report.removed.push(join(opts.cwd, ".gitignore") + ` ("${GITIGNORE_ENTRY}" line)`);
      log(`removed "${GITIGNORE_ENTRY}" from .gitignore`);
    }
    if (opts.dryRun) {
      log(`[dry-run] would delete ${configDir} (config + cache${hasPlugin ? " + materialized plugin dir" : ""})`);
    } else if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
      report.removed.push(configDir);
      log(`deleted ${configDir} (--purge-config)`);
    } else {
      log(`no ${configDir}`);
    }
  } else {
    report.kept.push(`${configDir} (config.json + cache${hasPlugin ? " + materialized plugin dir" : ""} kept; --purge-config deletes it)`);
    log(`config + cache kept (use --purge-config to delete)`);
  }

  report.kept.push(`backups (.bak) kept for manual rollback.`);
  report.skipped.forEach((s) => report.output.push(`[SKIP] ${s}`));
  report.removed.forEach((r) => report.output.push(`[REMOVED] ${r}`));
  report.kept.forEach((k) => report.output.push(`[KEPT] ${k}`));
  return report;
}
