#!/usr/bin/env node
// deepseek-vl-support — CLI entry (single bin named after the package, so
// npx resolves it by package name). Zero-dependency hand-rolled arg parsing;
// subcommands: describe / doctor / config / install / uninstall / mcp / version.
import { join } from "node:path";
import { describe, VisionSizeError } from "./client.ts";
import { runDoctor } from "./doctor.ts";
import { parseTargets, runInstall, runUninstall } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { PLUGIN_CLIENTS } from "./plugin.ts";
import type { Agent, PluginClient } from "./plugin.ts";
import {
  humanBytes,
  maskApiKey,
  resolveConfig,
  writeConfigFile,
  configPaths,
  parseFallbacks,
  CONFIG_KEYS,
} from "./config.ts";
import type { VisionConfig } from "./config.ts";

const VERSION = "0.2.4";

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

/** Flags that take a value; every other flag is boolean (`--json file.png`
 *  must not swallow the positional that follows it). */
const VALUE_FLAGS = new Set([
  "target",
  "preset",
  "base-url",
  "model",
  "api-key",
  "fallbacks",
  "clients",
  "dir",
  "url",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, "");
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags.set(a.slice(1), "");
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function fail(msg: string): never {
  process.stderr.write(`[deepseek-vl-support] error: ${msg}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(
    `deepseek-vl-support v${VERSION} — vision for DeepSeek in Claude Code / Codex / OpenCode

Usage:
  deepseek-vl-support describe <image-file> [question...]   Describe an image (text output)
  deepseek-vl-support doctor [--url <baseUrl>] [--all]      Diagnose the vision endpoint
  deepseek-vl-support config [get [key] | set <key> <value> | path] [--global]
  deepseek-vl-support install [options]                     One-shot installer (wizard)
  deepseek-vl-support uninstall [options]                   Remove installed artifacts
  deepseek-vl-support mcp                                  Run the MCP stdio server (for Codex)
  deepseek-vl-support version                              Print version

install options: --target <agent,...> --global --update --dry-run
                 --non-interactive --preset <id|later> --base-url <url> --model <id>
                 --api-key <key> --fallbacks <json|"m@url,..."> --dir <project>
uninstall options: --target <agent,...> --global --purge-config --dry-run

Agents (--target, comma-separated, default: claude,codex plus the agents
detected on this machine):
  claude        Claude Code hook + skill + /vision command (project or global)
  codex         Codex MCP server + AGENTS.md (project or global; project scope
                also writes .agents/skills/deepseek-vision/ — readable by
                Cursor, GitHub Copilot, Kimi Code, etc.)
  opencode      OpenCode: MCP server in opencode.json (project or global) +
                shared .agents/skills/ skill
  trae          Trae: skill copied to .trae/skills/ + manual import/MCP
                guidance (project scope)
  pi            Pi Coding Agent: shared .agents/skills/ skill; guidance prefers
                'pi install npm:deepseek-vl-support'; MCP written to
                ~/.pi/agent/mcp.json only when pi-mcp-adapter is detected
                (project scope)
  omp           Oh My Pi: shared .agents/skills/ skill + guidance
                'omp install npm:deepseek-vl-support' (skill + MCP automatic;
                project scope)
  dsh           DeepSeek Harness: shared .agents/skills/ skill + MCP guidance
                (project scope)
  qwen          Qwen Code: skill in .qwen/skills/ + settings.json MCP + Read
                hook (project or global)
  reasonix      Reasonix: shared .agents/skills/ skill + .mcp.json MCP + hook;
                global uses config.toml [[plugins]] (project or global)
  kilo          Kilo Code: shared .agents/skills/ skill + kilo.json MCP entry
                (project or global)
  workbuddy     WorkBuddy (CodeBuddy Code): skill in .codebuddy/skills/ +
                .mcp.json MCP (project or global)
  devin         Devin: shared .agents/skills/ skill + mcp_config.json MCP
                (project or global)
  copilot       GitHub Copilot via Agent Plugins (always global)
  cursor        Cursor via Agent Plugins (always global)
  kiro          Kiro via Agent Plugins (always global)
  openclaw      OpenClaw via Agent Plugins (always global)
  hermes        Hermes Agent via Agent Plugins (always global)
  vscode        VS Code via Agent Plugins (always global)
  chatgpt-codex ChatGPT & Codex via Agent Plugins (always global)
  grok          Grok Bot via Agent Plugins (always global)
  nanoclaw      NanoClaw via Agent Plugins (always global)
  other         Other Agent Plugins-compatible agents (always global, guidance)

--clients <list> (legacy): filter for plugin agents in non-interactive runs;
  effective plugin agents = --target ∩ --clients. The old --target plugin
  value is gone: use e.g. --target copilot,cursor instead.

--preset later: skip the endpoint questions — config is written without a
  model; images cannot be described until one is set (config set model / env
  VISION_MODEL). The wizard also offers "Decide later" as its last preset.

Config resolution: env VISION_* > project .deepseek-vl/config.json >
global ~/.deepseek-vl/config.json > defaults.
`,
  );
}

async function cmdDescribe(args: ParsedArgs): Promise<void> {
  // positionals[0] is the subcommand name ("describe") itself
  const file = args.positionals[1];
  if (!file) fail("describe requires an image file path");
  const question = args.positionals.slice(2).join(" ");
  try {
    const res = await describe(file, { question });
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else {
      process.stdout.write(`${res.text}\n`);
    }
  } catch (e) {
    if (e instanceof VisionSizeError) {
      process.stderr.write(
        `[deepseek-vl-support] ${e.message}\n` +
          `  hint: compress/crop the image, then retry.\n`,
      );
      process.exit(1);
    }
    fail(e instanceof Error ? e.message : String(e));
  }
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const report = await runDoctor({
    url: args.flags.get("url"),
    all: args.flags.has("all"),
  });
  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(report.lines.join("\n") + "\n");
  }
  process.exitCode = report.ok ? 0 : 1;
}

function printConfig(cfg: VisionConfig): void {
  process.stdout.write(
    `baseUrl  : ${cfg.baseUrl}\n` +
      `model    : ${cfg.model || "(not set)"}\n` +
      `apiKey   : ${maskApiKey(cfg.apiKey)}\n` +
      `timeoutMs: ${cfg.timeoutMs}\n` +
      `maxBytes : ${cfg.maxBytes} (${humanBytes(cfg.maxBytes)})\n` +
      `enabled  : ${cfg.enabled}\n` +
      `fallbacks: ${cfg.fallbacks.length ? JSON.stringify(cfg.fallbacks) : "(none)"}\n`,
  );
}

function cmdConfig(args: ParsedArgs): void {
  const [sub, key, ...rest] = args.positionals.slice(1);
  const global = args.flags.has("global");
  const cwd = process.cwd();

  if (sub === "path") {
    const p = configPaths(cwd);
    process.stdout.write(
      `project: ${p.projectFile}\n` +
        `global : ${p.globalFile}\n` +
        `cache  : ${global ? p.globalCacheDir : p.projectCacheDir} (auto)\n`,
    );
    return;
  }

  if (sub === "get") {
    const cfg = resolveConfig(cwd);
    if (!key) {
      printConfig(cfg);
      return;
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) fail(`unknown config key: ${key}`);
    const v = (cfg as unknown as Record<string, unknown>)[key];
    process.stdout.write(typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? `${String(v)}\n`
      : `${JSON.stringify(v)}\n`);
    return;
  }

  if (sub === "set") {
    if (!key || rest.length === 0) fail("usage: deepseek-vl-support config set <key> <value>");
    const value = rest.join(" ");
    const paths = configPaths(cwd);
    const file = global ? paths.globalFile : paths.projectFile;
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) fail(`unknown config key: ${key}`);

    const patch: Partial<VisionConfig> = {};
    if (key === "baseUrl" || key === "model" || key === "apiKey") {
      (patch as Record<string, string>)[key] = value;
    } else if (key === "timeoutMs" || key === "maxBytes") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) fail(`${key} must be a positive number`);
      (patch as Record<string, number>)[key] = n;
    } else if (key === "enabled") {
      const t = value.toLowerCase();
      if (["1", "true", "yes", "on"].includes(t)) patch.enabled = true;
      else if (["0", "false", "no", "off"].includes(t)) patch.enabled = false;
      else fail("enabled must be true/false");
    } else if (key === "fallbacks") {
      patch.fallbacks = parseFallbacks(value);
    }
    const merged = writeConfigFile(file, patch);
    process.stdout.write(`wrote ${file}\n`);
    printConfig(merged);
    return;
  }

  if (sub === undefined) {
    printConfig(resolveConfig(cwd));
    return;
  }
  fail(`unknown config subcommand: ${sub}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd] = args.positionals;

  switch (cmd) {
    case "describe":
      await cmdDescribe(args);
      return;
    case "doctor":
      await cmdDoctor(args);
      return;
    case "config":
      cmdConfig(args);
      return;
    case "install":
      await runInstallFromCli(args);
      return;
    case "uninstall":
      await runUninstallFromCli(args);
      return;
    case "mcp":
      await runMcpServer();
      return;
    case "version":
    case "--version":
      process.stdout.write(`deepseek-vl-support v${VERSION}\n`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      fail(`unknown command: ${cmd}`);
  }
}

function flagBool(flags: Map<string, string>, name: string): boolean {
  const v = flags.get(name);
  if (v === undefined) return false;
  return v === "" || !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/** Parse --clients copilot,cursor,... (comma-separated). */
function parseClients(raw: string | undefined): PluginClient[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const out: PluginClient[] = [];
  for (const part of raw.split(",")) {
    const c = part.trim().toLowerCase();
    if (!(PLUGIN_CLIENTS as readonly string[]).includes(c)) {
      fail(`unknown client: ${c} (expected one of: ${PLUGIN_CLIENTS.join(",")})`);
    }
    out.push(c as PluginClient);
  }
  return out;
}

async function runInstallFromCli(args: ParsedArgs): Promise<void> {
  const { flags } = args;
  const targetRaw = flags.get("target");
  let targets: Agent[] | undefined;
  try {
    targets = parseTargets(targetRaw);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const cwd = flags.get("dir") ?? process.cwd();
  const report = await runInstall({
    cwd,
    global: flagBool(flags, "global"),
    targets,
    nonInteractive: flagBool(flags, "non-interactive"),
    update: flagBool(flags, "update"),
    dryRun: flagBool(flags, "dry-run"),
    preset: flags.get("preset"),
    baseUrl: flags.get("base-url"),
    model: flags.get("model"),
    apiKey: flags.get("api-key"),
    fallbacks: flags.get("fallbacks") !== undefined ? parseFallbacks(flags.get("fallbacks") as string) : undefined,
    clients: parseClients(flags.get("clients")),
  });
  process.stdout.write(report.output.join("\n") + "\n");
  if (report.doctor && !report.doctor.ok) process.exitCode = 1;
}

async function runUninstallFromCli(args: ParsedArgs): Promise<void> {
  const { flags } = args;
  const targetRaw = flags.get("target");
  let targets: Agent[] | undefined;
  try {
    targets = parseTargets(targetRaw);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const cwd = flags.get("dir") ?? process.cwd();
  const report = await runUninstall({
    cwd,
    global: flagBool(flags, "global"),
    targets,
    clients: parseClients(flags.get("clients")),
    purgeConfig: flagBool(flags, "purge-config"),
    dryRun: flagBool(flags, "dry-run"),
  });
  process.stdout.write(report.output.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(`[deepseek-vl-support] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}\n`);
  process.exit(1);
});
