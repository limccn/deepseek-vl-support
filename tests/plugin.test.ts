// Agent Plugins mode tests: static spec compliance of the portable package
// (plugin.json / mcp.json / marketplace.json / skills/SKILL.md), materialized
// plugin dir, and per-client registration/unregistration for GitHub Copilot,
// Cursor, Kiro, OpenClaw, and Hermes against mocked CLIs on PATH. Also covers
// the copilot settings.json fallback, dry-run (no writes, no commands),
// failure isolation, and uninstall marker rules.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { runInstall, runUninstall } from "../src/install.ts";
import {
  detectPluginClients,
  materializePluginDir,
  pluginDir,
} from "../src/plugin.ts";
import {
  CURSOR_PLUGIN_DIRNAME,
  CURSOR_PLUGIN_MARKER_FILE,
  PLUGIN_REPO,
} from "../src/identity.ts";
import { startMockVisionServer } from "./mock-vision-server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_TOP_LEVEL_KEYS = [
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions",
];

let tmp: { base: string; project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-plugin-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { base, project, home };
  return { base, project, home };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_") || k.startsWith("DVLS_")) delete process.env[k];
  }
});

afterEach(async () => {
  process.env = { ...savedEnv };
  if (tmp) {
    await rm(tmp.base, { recursive: true, force: true });
    tmp = null;
  }
});

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------- static compliance

function assertValidPluginName(name: string): void {
  assert.ok(name.length >= 1 && name.length <= 64, `name length: ${name.length}`);
  assert.match(name, /^[a-z0-9]$|^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, `name charset: ${name}`);
  assert.ok(!name.includes("--"), "no consecutive hyphens");
  assert.ok(!name.includes(".."), "no consecutive dots");
}

test("static compliance: plugin.json follows the Agent Plugins v1.0.0 closed schema", () => {
  const p = readJson(join(ROOT, "plugin.json"));
  assert.equal(p.$schema, PLUGIN_SCHEMA, "$schema must be the canonical 1.0.0 URL");
  assert.equal(typeof p.name, "string");
  assertValidPluginName(p.name as string);
  assert.equal(p.name, "deepseek-vl-support");
  assert.equal(p.version, PKG_VERSION, "plugin.json version must match package.json");
  for (const key of Object.keys(p)) {
    assert.ok(PLUGIN_TOP_LEVEL_KEYS.includes(key), `unknown top-level field: ${key}`);
  }
  const author = p.author as Record<string, unknown>;
  assert.equal(typeof author.name, "string");
  for (const key of Object.keys(author)) {
    assert.ok(["name", "email", "url"].includes(key), `author has unknown field: ${key}`);
  }
});

test("static compliance: mcp.json is transport-valid, credential-free, and closed", () => {
  const m = readJson(join(ROOT, "mcp.json"));
  assert.deepEqual(Object.keys(m).sort(), ["$schema", "mcpServers"]);
  assert.equal(m.$schema, MCP_SCHEMA, "$schema must be the canonical 1.0.0 URL");
  const servers = m.mcpServers as Record<string, Record<string, unknown>>;
  const server = servers["deepseek-vl"];
  assert.ok(server, "mcpServers must contain the deepseek-vl server");
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "npx");
  assert.ok(!/[\s]/.test(server.command as string), "command must be a single executable token");
  const args = server.args as unknown[];
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"));
  assert.ok(!("env" in server), "no env entries (credentials stay in user config)");
  assert.ok(!("headers" in server), "no headers");
  const secretish = /(api[_-]?key|secret|token|authorization|password|credential)/i;
  const serialized = JSON.stringify(server);
  assert.ok(!secretish.test(serialized), "no credential-like fields in mcp.json");
});

test("static compliance: marketplace.json entry points at the repo root and matches plugin.json", () => {
  const m = readJson(join(ROOT, "marketplace.json"));
  assert.equal(typeof m.name, "string");
  assert.ok(m.name && (m.name as string).length <= 64);
  assert.ok((m.owner as Record<string, unknown>).name);
  const plugins = m.plugins as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(plugins) && plugins.length >= 1);
  const entry = plugins[0];
  assert.equal(entry.name, readJson(join(ROOT, "plugin.json")).name);
  assert.equal(entry.source, ".", "source must point at the repository root");
  assert.equal(entry.version, PKG_VERSION);
  const meta = m.metadata as Record<string, unknown> | undefined;
  if (meta) assert.equal(meta.version, PKG_VERSION);
  assert.equal(typeof entry.repository, "string");
  assert.equal(typeof entry.license, "string");
});

test("static compliance: skills/deepseek-vision/SKILL.md matches assets/SKILL.md with valid frontmatter", () => {
  const repoCopy = readFileSync(join(ROOT, "skills", "deepseek-vision", "SKILL.md"), "utf8");
  const asset = readFileSync(join(ROOT, "assets", "SKILL.md"), "utf8");
  assert.equal(repoCopy, asset, "skills/deepseek-vision/SKILL.md must stay in sync with assets/SKILL.md");
  assert.match(repoCopy, /^---\r?\n/);
  assert.match(repoCopy, /^name: deepseek-vision$/m);
  assert.match(repoCopy, /^description: .+$/m);
});

// ---------------------------------------------------------------- materialize

test("materialize: copies plugin files into ~/.deepseek-vl/plugin/, idempotent, dry-run writes nothing", async () => {
  const { base, home } = await makeEnv();
  try {
    const dest = pluginDir(home);
    const first = materializePluginDir(ROOT, dest, false);
    assert.deepEqual(first.missing, []);
    assert.ok(first.written.length >= 3);
    assert.equal(readFileSync(join(dest, "plugin.json"), "utf8"), readFileSync(join(ROOT, "plugin.json"), "utf8"));
    assert.equal(readFileSync(join(dest, "mcp.json"), "utf8"), readFileSync(join(ROOT, "mcp.json"), "utf8"));
    assert.ok(existsSync(join(dest, "skills", "deepseek-vision", "SKILL.md")));
    // idempotent: re-running succeeds and yields the same destination list
    const second = materializePluginDir(ROOT, dest, false);
    assert.deepEqual(second.written, first.written);
    assert.deepEqual(second.missing, []);

    // dry-run: reports the destinations but writes nothing
    const dry = materializePluginDir(ROOT, pluginDir(home), true);
    assert.deepEqual(dry.written, first.written);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("detection: PATH probe for CLI clients, directory probe for cursor/kiro", async () => {
  const { base, home } = await makeEnv();
  try {
    const binDir = join(base, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const ext = process.platform === "win32" ? ".cmd" : "";
    await writeFile(join(binDir, `copilot${ext}`), "@echo off\n", "utf8");
    await writeFile(join(binDir, `hermes${ext}`), "@echo off\n", "utf8");
    const env = { PATH: binDir };
    const det = detectPluginClients(home, env);
    assert.equal(det.copilot.detected, true);
    assert.ok(det.copilot.bin, "resolved bin path");
    assert.equal(det.hermes.detected, true);
    assert.equal(det.openclaw.detected, false, "openclaw not on PATH");
    assert.equal(det.cursor.detected, true, "cursor via ~/.cursor");
    assert.equal(det.kiro.detected, false, "kiro via ~/.kiro");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- mocked client CLIs

const MOCK_CLI_JS = `// Mock Agent client CLI for tests: logs every invocation to
// <DVLS_MOCK_STATE_DIR>/calls.log and fails commands listed in DVLS_MOCK_FAIL
// (entries of the form "<client>:<substring of the joined args>").
const fs = require("fs");
const path = require("path");
const client = process.argv[2];
const args = process.argv.slice(3);
const stateDir = process.env.DVLS_MOCK_STATE_DIR || ".";
fs.appendFileSync(path.join(stateDir, "calls.log"), JSON.stringify([client, ...args]) + "\\n");
const cmdKey = args.join(" ");
const fail = (process.env.DVLS_MOCK_FAIL || "").split(",").filter(Boolean);
const matched = fail.find((f) => f.startsWith(client + ":") && cmdKey.includes(f.slice(client.length + 1)));
if (matched) {
  process.stderr.write("mock failure: " + matched + "\\n");
  process.exit(1);
}
if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(process.env.DVLS_MOCK_INSTALLED === "1" ? "deepseek-vl-support\\n" : "(no plugins installed)\\n");
} else if (args[0] === "plugins" && args[1] === "list") {
  process.stdout.write(process.env.DVLS_MOCK_INSTALLED === "1" ? "deepseek-vl-support\\n" : "(none)\\n");
}
process.exit(0);
`;

interface MockClients {
  binDir: string;
  stateDir: string;
  callsLog(): Array<[string, ...string[]]>;
}

async function makeMockClients(base: string): Promise<MockClients> {
  const binDir = join(base, "bin");
  const stateDir = join(base, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  await writeFile(join(binDir, "mock-cli.js"), MOCK_CLI_JS, "utf8");
  for (const name of ["copilot", "openclaw", "hermes"]) {
    if (process.platform === "win32") {
      await writeFile(join(binDir, `${name}.cmd`), `@node "%~dp0mock-cli.js" ${name} %*\r\n`, "utf8");
    } else {
      const sh = join(binDir, name);
      await writeFile(sh, `#!/bin/sh\nnode "$(dirname "$0")/mock-cli.js" ${name} "$@"\n`, "utf8");
      await chmod(sh, 0o755);
    }
  }
  const logFile = join(stateDir, "calls.log");
  const callsLog = (): Array<[string, ...string[]]> =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as [string, ...string[]])
      : [];
  return { binDir, stateDir, callsLog };
}

function putClientsOnPath(mock: MockClients, installed = false, fail = ""): void {
  process.env.PATH = `${mock.binDir}${delimiter}${savedEnv.PATH ?? ""}`;
  process.env.DVLS_MOCK_STATE_DIR = mock.stateDir;
  if (installed) process.env.DVLS_MOCK_INSTALLED = "1";
  if (fail) process.env.DVLS_MOCK_FAIL = fail;
}

async function pluginInstall(opts: Record<string, unknown> = {}) {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { project, home } = (await makeEnv()) as { project: string; home: string };
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const report = await runInstall({
      cwd: project,
      home,
      nonInteractive: true,
      target: "plugin",
      baseUrl: mock.url,
      model: "qwen2.5vl:7b",
      ...opts,
    });
    return { report, project, home };
  } finally {
    await mock.close();
  }
}

test("install plugin: materializes, writes global config, and registers all clients via mocked CLIs", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, project, home } = await pluginInstall();

    // global config written, project scope untouched
    assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")));
    assert.ok(!existsSync(join(project, ".deepseek-vl")), "no project .deepseek-vl in plugin mode");
    assert.ok(!existsSync(join(project, ".gitignore")), "no .gitignore in plugin mode");

    // materialized plugin dir
    const dest = pluginDir(home);
    assert.ok(existsSync(join(dest, "plugin.json")));
    assert.ok(existsSync(join(dest, "mcp.json")));
    assert.ok(existsSync(join(dest, "skills", "deepseek-vision", "SKILL.md")));
    assert.ok(report.output.some((l) => l.includes("materialized")), "materialization logged");

    // cursor copy with marker
    const cursorDir = join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME);
    assert.ok(existsSync(join(cursorDir, "plugin.json")));
    assert.ok(existsSync(join(cursorDir, CURSOR_PLUGIN_MARKER_FILE)));

    // command sequences per client
    const calls = mock.callsLog();
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "list"));
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "install" && c[3] === PLUGIN_REPO));
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "marketplace" && c[3] === "add"));
    assert.ok(calls.some((c) => c[0] === "openclaw" && c[1] === "plugins" && c[2] === "install" && c[3] === dest));
    assert.ok(calls.some((c) => c[0] === "openclaw" && c[1] === "gateway" && c[2] === "restart"));
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "install" && c[3] === "limccn/deepseek-vl-support" && c[4] === "--no-enable"));
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "enable" && c[3] === "deepseek-vl-support"));

    // per-client report
    const byClient = new Map(report.pluginClients?.map((r) => [r.client, r.status]));
    assert.equal(byClient.get("copilot"), "ok");
    assert.equal(byClient.get("cursor"), "ok");
    assert.equal(byClient.get("openclaw"), "ok");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("kiro"), "manual", "kiro always prints manual instructions");
    assert.equal(report.doctor?.ok, true, "doctor self-check still runs and passes");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("install plugin: copilot settings.json fallback when the CLI is missing (marked, user entries preserved)", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    // PATH without copilot (openclaw/hermes still present)
    await rm(join(mock.binDir, process.platform === "win32" ? "copilot.cmd" : "copilot"), { force: true });
    process.env.PATH = mock.binDir;
    process.env.DVLS_MOCK_STATE_DIR = mock.stateDir;
    const { report, home } = await pluginInstall({ clients: ["copilot"] });

    const settingsFile = join(home, ".copilot", "settings.json");
    assert.ok(existsSync(settingsFile), "settings.json fallback written");
    const settings = readJson(settingsFile);
    const enabled = settings.enabledPlugins as string[];
    assert.deepEqual(enabled, [PLUGIN_REPO]);
    assert.equal(report.pluginClients?.find((r) => r.client === "copilot")?.status, "ok");

    // user adds another plugin; re-install is idempotent and preserves it
    (settings.enabledPlugins as string[]).push("some/other-plugin");
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
    const again = await runInstall({
      cwd: join(base, "project2"),
      home,
      nonInteractive: true,
      target: "plugin",
      clients: ["copilot"],
      baseUrl: "http://127.0.0.1:1/v1",
      model: "qwen2.5vl:7b",
    });
    const after = readJson(settingsFile).enabledPlugins as string[];
    assert.deepEqual(after, [PLUGIN_REPO, "some/other-plugin"], "user entries preserved, no duplicates");
    assert.ok(again.output.some((l) => l.includes("idempotent")));

    // uninstall removes only our entry
    const un = await runUninstall({ cwd: join(base, "project2"), home, target: "plugin", clients: ["copilot"] });
    assert.deepEqual(readJson(settingsFile).enabledPlugins, ["some/other-plugin"]);
    assert.ok(un.pluginClients?.find((r) => r.client === "copilot")?.status === "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("install plugin: failure isolation — one failing client does not block the others", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock, false, "copilot:plugin install");
    const { report, home } = await pluginInstall();

    const byClient = new Map(report.pluginClients?.map((r) => [r.client, r.status]));
    assert.equal(byClient.get("copilot"), "failed");
    assert.equal(byClient.get("openclaw"), "ok", "openclaw unaffected by copilot failure");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("cursor"), "ok");
    assert.ok(report.warnings.some((w) => w.includes("1 client(s) failed")), "summary warning present");
    assert.ok(existsSync(join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME, "plugin.json")));
    assert.ok(existsSync(pluginDir(home)), "materialized dir exists regardless of client failures");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("install plugin: --clients filters, dry-run executes nothing and writes nothing", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, project, home } = await pluginInstall({ clients: ["cursor", "hermes"], dryRun: true });

    // nothing on disk
    assert.ok(!existsSync(join(home, ".deepseek-vl")), "no config/materialized dir in dry-run");
    assert.ok(!existsSync(join(project, ".deepseek-vl")));
    assert.ok(!existsSync(join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME)));
    assert.equal(mock.callsLog().length, 0, "no external commands executed in dry-run");

    // report still lists every client, filtered to the requested ones
    const byClient = new Map(report.pluginClients?.map((r) => [r.client, r.status]));
    assert.equal(byClient.get("cursor"), "ok");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("copilot"), "skipped", "not requested (--clients)");
    assert.equal(byClient.get("openclaw"), "skipped");
    assert.equal(byClient.get("kiro"), "skipped");
    assert.ok(report.output.some((l) => l.includes("[dry-run]")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("install plugin: second run is idempotent — already-installed clients only re-list/enable", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock, true); // mock CLIs report the plugin as already installed
    const { report, home } = await pluginInstall();

    const calls = mock.callsLog();
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "list"));
    assert.ok(!calls.some((c) => c[0] === "copilot" && c[2] === "install"), "no re-install when already present");
    assert.ok(!calls.some((c) => c[0] === "openclaw" && c[2] === "install"), "no openclaw re-install");
    assert.ok(!calls.some((c) => c[0] === "openclaw" && c[2] === "restart"), "no openclaw restart when already present");
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "list"));
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "enable"), "hermes re-enable (idempotent)");
    assert.ok(report.output.some((l) => l.includes("idempotent")), `expected idempotent log, got: ${report.output.join("|")}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("uninstall plugin: unregisters clients, removes the marked cursor dir, keeps materialized dir", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, project, home } = await pluginInstall();
    assert.ok(report.pluginClients, "install report has per-client results");

    const un = await runUninstall({ cwd: project, home, target: "plugin" });
    const calls = mock.callsLog();
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "openclaw" && c[1] === "plugins" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(!existsSync(join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME)), "cursor dir removed");
    assert.ok(existsSync(pluginDir(home)), "materialized dir kept without --purge-config");
    assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")), "config kept");
    assert.ok(un.kept.some((k) => k.includes("materialized plugin dir kept")));

    // second uninstall is a no-op
    const again = await runUninstall({ cwd: project, home, target: "plugin" });
    assert.equal(again.removed.length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("uninstall plugin: --purge-config removes the materialized dir; user-authored cursor dir is kept", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, project, home } = await pluginInstall();
    assert.ok(report.pluginClients);

    // user-authored cursor dir without our marker must survive uninstall
    const userDir = join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME);
    await rm(userDir, { recursive: true, force: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "plugin.json"), "{\"name\":\"user-plugin\"}\n", "utf8");

    const un = await runUninstall({ cwd: project, home, target: "plugin", purgeConfig: true });
    assert.ok(existsSync(join(userDir, "plugin.json")), "user-authored cursor dir kept");
    const cursorResult = un.pluginClients?.find((r) => r.client === "cursor");
    assert.equal(cursorResult?.status, "skipped");
    assert.ok(un.output.some((l) => l.includes("user-authored")), `expected skip log, got: ${un.output.join("|")}`);
    assert.ok(!existsSync(join(home, ".deepseek-vl")), "--purge-config removes config + materialized dir");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("uninstall plugin: copilot settings fallback entry removed only when marked", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    // PATH without copilot (openclaw/hermes still present)
    await rm(join(mock.binDir, process.platform === "win32" ? "copilot.cmd" : "copilot"), { force: true });
    process.env.PATH = mock.binDir; // no copilot CLI
    process.env.DVLS_MOCK_STATE_DIR = mock.stateDir;
    const { report, project, home } = await pluginInstall({ clients: ["copilot"] });
    assert.ok(report.pluginClients);

    const un = await runUninstall({ cwd: project, home, target: "plugin", clients: ["copilot"] });
    const settingsFile = join(home, ".copilot", "settings.json");
    const settings = readJson(settingsFile) as { enabledPlugins?: string[] };
    assert.ok(!settings.enabledPlugins || settings.enabledPlugins.length === 0, "our entry removed");
    assert.equal(un.pluginClients?.find((r) => r.client === "copilot")?.status, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
