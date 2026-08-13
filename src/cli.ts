#!/usr/bin/env node
// deepseek-vl — CLI entry (bin alias). Zero-dependency hand-rolled arg
// parsing; subcommands: describe / doctor / config / install / uninstall /
// mcp / version.
import { join } from "node:path";
import { describe, VisionSizeError } from "./client.ts";
import { runDoctor } from "./doctor.ts";
import { runInstall, runUninstall } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
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

const VERSION = "0.1.0";

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
  process.stderr.write(`[deepseek-vl] error: ${msg}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(
    `deepseek-vl v${VERSION} — vision for DeepSeek in Claude Code / Codex

Usage:
  deepseek-vl describe <image-file> [question...]   Describe an image (text output)
  deepseek-vl doctor [--url <baseUrl>] [--all]      Diagnose the vision endpoint
  deepseek-vl config [get [key] | set <key> <value> | path] [--global]
  deepseek-vl install [options]                     One-shot installer (wizard)
  deepseek-vl uninstall [options]                   Remove installed artifacts
  deepseek-vl mcp                                  Run the MCP stdio server (for Codex)
  deepseek-vl version                              Print version

install options: --target claude|codex|both --global --update --dry-run
                 --non-interactive --preset <id> --base-url <url> --model <id>
                 --api-key <key> --fallbacks <json|"m@url,..."> --dir <project>
uninstall options: --target claude|codex|both --global --purge-config --dry-run

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
        `[deepseek-vl] ${e.message}\n` +
          `  hint: compress/crop the image, then retry. 请压缩或裁剪图片后重试。\n`,
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
      `model    : ${cfg.model || "(not set 未设置)"}\n` +
      `apiKey   : ${maskApiKey(cfg.apiKey)}\n` +
      `timeoutMs: ${cfg.timeoutMs}\n` +
      `maxBytes : ${cfg.maxBytes} (${humanBytes(cfg.maxBytes)})\n` +
      `enabled  : ${cfg.enabled}\n` +
      `fallbacks: ${cfg.fallbacks.length ? JSON.stringify(cfg.fallbacks) : "(none 无)"}\n`,
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
    if (!key || rest.length === 0) fail("usage: deepseek-vl config set <key> <value>");
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
      process.stdout.write(`deepseek-vl v${VERSION}\n`);
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

async function runInstallFromCli(args: ParsedArgs): Promise<void> {
  const { flags } = args;
  const target = flags.get("target");
  if (target !== undefined && !["claude", "codex", "both"].includes(target)) {
    fail(`--target must be claude|codex|both, got: ${target}`);
  }
  const cwd = flags.get("dir") ?? process.cwd();
  const report = await runInstall({
    cwd,
    global: flagBool(flags, "global"),
    target: (target as "claude" | "codex" | "both") ?? "both",
    nonInteractive: flagBool(flags, "non-interactive"),
    update: flagBool(flags, "update"),
    dryRun: flagBool(flags, "dry-run"),
    preset: flags.get("preset"),
    baseUrl: flags.get("base-url"),
    model: flags.get("model"),
    apiKey: flags.get("api-key"),
    fallbacks: flags.get("fallbacks") !== undefined ? parseFallbacks(flags.get("fallbacks") as string) : undefined,
  });
  process.stdout.write(report.output.join("\n") + "\n");
  if (report.doctor && !report.doctor.ok) process.exitCode = 1;
}

async function runUninstallFromCli(args: ParsedArgs): Promise<void> {
  const { flags } = args;
  const target = flags.get("target");
  if (target !== undefined && !["claude", "codex", "both"].includes(target)) {
    fail(`--target must be claude|codex|both, got: ${target}`);
  }
  const cwd = flags.get("dir") ?? process.cwd();
  const report = await runUninstall({
    cwd,
    global: flagBool(flags, "global"),
    target: (target as "claude" | "codex" | "both") ?? "both",
    purgeConfig: flagBool(flags, "purge-config"),
    dryRun: flagBool(flags, "dry-run"),
  });
  process.stdout.write(report.output.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(`[deepseek-vl] unexpected error: ${e instanceof Error ? e.stack ?? e.message : e}\n`);
  process.exit(1);
});
