// Agent Plugins mode tests: static spec compliance of the portable package
// (plugin.json / mcp.json / .mcp.json / marketplace.json / skills/SKILL.md),
// materialized plugin dir, and per-client registration/unregistration for
// all 10 clients — GitHub Copilot, Cursor, Kiro, OpenClaw, Hermes Agent,
// VS Code, ChatGPT & Codex, Grok Bot, NanoClaw, and generic "other" —
// against mocked CLIs on PATH. Also covers the copilot/VS Code settings.json
// fallbacks, the codex marketplace shim, dry-run (no writes, no commands),
// failure isolation, and uninstall marker rules.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, join } from "node:path";
import { runInstall, runUninstall } from "../src/install.ts";
import {
  detectPluginClients,
  materializePluginDir,
  pluginDir,
  PLUGIN_CLIENTS,
  vscodeUserSettingsPath,
} from "../src/plugin.ts";
import {
  CURSOR_PLUGIN_DIRNAME,
  CURSOR_PLUGIN_MARKER_FILE,
  HOOK_FILENAME,
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
// The live env lookup is case-insensitive on Windows; the spread copy is a
// plain object, so its PATH key keeps the OS casing (`Path`) and
// `savedEnv.PATH` would be undefined under a PowerShell-spawned node.
// Capture PATH via the live object instead.
const savedPath = process.env.PATH ?? "";

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
    if (k.startsWith("VISION_") || k.startsWith("DVLS_") || k === "NANOCLAW_TEMPLATES_DIR") delete process.env[k];
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
  // Bare npx + package name: the client resolves npx via the platform's
  // executable search; the npm package is fetched on first tool call. The
  // user environment is assumed to include npm/npx (deliberate decision
  // 2026-08-14 — see docs/e2e-real-endpoint.md §9.6 for the known risk).
  assert.deepEqual(args, ["-y", "deepseek-vl-support", "mcp"]);
  assert.ok(!("env" in server), "no env entries (credentials stay in user config)");
  assert.ok(!("headers" in server), "no headers");
  assert.ok(!("cwd" in server), "no cwd — clients use the plugin root by default");
  const secretish = /(api[_-]?key|secret|token|authorization|password|credential)/i;
  const serialized = JSON.stringify(server);
  assert.ok(!secretish.test(serialized), "no credential-like fields in mcp.json");
});

test("static compliance: .mcp.json is byte-identical to mcp.json (Copilot native file, build-synced)", () => {
  const spec = readFileSync(join(ROOT, "mcp.json"), "utf8");
  const copilot = readFileSync(join(ROOT, ".mcp.json"), "utf8");
  assert.equal(
    copilot,
    spec,
    ".mcp.json must stay in sync with mcp.json (build.mjs copies mcp.json → .mcp.json; edit mcp.json and re-run npm run build)",
  );
  const m = JSON.parse(copilot) as Record<string, unknown>;
  assert.deepEqual(Object.keys(m).sort(), ["$schema", "mcpServers"], ".mcp.json must also satisfy the closed schema");
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

test("AgentSkills conformance: every deepseek-vision SKILL.md copy follows agentskills.io (name/description/allowed-tools/references)", () => {
  // Product copies of the skill: template sources (src/assets, assets build
  // product), the packaged skill dir (skills/, the .agents install source),
  // and the repo's own installed .agents copy. All must stay byte-identical
  // (build.mjs syncs assets/ → skills/; the .agents copy is installer output).
  const copies = [
    join(ROOT, "src", "assets", "SKILL.md"),
    join(ROOT, "assets", "SKILL.md"),
    join(ROOT, "skills", "deepseek-vision", "SKILL.md"),
    join(ROOT, ".agents", "skills", "deepseek-vision", "SKILL.md"),
  ];
  const bodies = copies.map((p) => readFileSync(p, "utf8"));
  for (const [i, b] of bodies.entries()) {
    assert.match(b, /^---\r?\n/, `${copies[i]} starts with frontmatter delimiter`);
  }
  for (const b of bodies.slice(1)) {
    assert.equal(b, bodies[0], "all SKILL.md copies must be byte-identical");
  }
  const md = bodies[0];

  // frontmatter (--- delimited, per agentskills.io)
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1];
  assert.ok(fm, "frontmatter is --- delimited");
  const name = fm.match(/^name:\s*(\S+)$/m)?.[1];
  assert.ok(name, "name is present (required by the spec)");
  assert.ok(name.length >= 1 && name.length <= 64, `name length 1-64: ${name.length}`);
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `name is kebab-case: ${name}`);
  assert.equal(name, "deepseek-vision", "name is the skill directory name");
  const description = fm.match(/^description:\s*(.+)$/m)?.[1];
  assert.ok(description && description.length >= 1 && description.length <= 1024, `description 1-1024 chars: ${description?.length}`);
  const allowed = fm.match(/^allowed-tools:\s*(.+)$/m)?.[1];
  assert.ok(allowed, "allowed-tools present");
  assert.ok(!allowed.includes(","), `allowed-tools must be space-separated (spec), got: "${allowed}"`);
  assert.ok(
    allowed.split(/\s+/).every((t) => /^[A-Za-z][A-Za-z0-9():*.-]*$/.test(t)),
    `space-delimited tool ids parse cleanly: "${allowed}"`,
  );

  // spec: name must equal the parent directory name — check on the deployed
  // skill directories (the template copies live in assets/ and are validated
  // transitively via the byte-identity assertion above)
  for (const p of [join(ROOT, "skills", "deepseek-vision", "SKILL.md"), join(ROOT, ".agents", "skills", "deepseek-vision", "SKILL.md")]) {
    assert.equal(basename(dirname(p)), name, `${p} sits in a directory named after the skill`);
  }

  // progressive disclosure: the packaged skill dir is self-contained — the
  // body's references/vision-prompt.md must be packaged next to SKILL.md
  const packagedRef = join(ROOT, "skills", "deepseek-vision", "references", "vision-prompt.md");
  assert.ok(existsSync(packagedRef), "packaged references/vision-prompt.md exists");
  assert.equal(
    readFileSync(packagedRef, "utf8"),
    readFileSync(join(ROOT, "src", "assets", "skill-references", "vision-prompt.md"), "utf8"),
    "packaged references copy stays in sync with the template source",
  );

  // cross-shell note (R5): commands are identical in bash/zsh/pwsh — no
  // platform-divergent copies are allowed
  assert.match(md, /bash, zsh \(macOS default\), and PowerShell/, "cross-shell equivalence note present");
  assert.ok(!/Windows|macOS|Linux/i.test(md.replace(/bash, zsh \(macOS default\), and PowerShell[\s\S]*/, "")), "no platform-divergent command examples");
});

// ---------------------------------------------------------------- materialize

test("materialize: copies plugin files into ~/.deepseek-vl/plugin/, idempotent, dry-run writes nothing", async () => {
  const { base, home } = await makeEnv();
  try {
    const dest = pluginDir(home);
    const first = materializePluginDir(ROOT, dest, false);
    assert.deepEqual(first.missing, []);
    assert.equal(first.written.length, 4, "plugin.json + mcp.json + .mcp.json + skills/");
    assert.equal(readFileSync(join(dest, "plugin.json"), "utf8"), readFileSync(join(ROOT, "plugin.json"), "utf8"));
    assert.equal(readFileSync(join(dest, "mcp.json"), "utf8"), readFileSync(join(ROOT, "mcp.json"), "utf8"));
    assert.equal(readFileSync(join(dest, ".mcp.json"), "utf8"), readFileSync(join(ROOT, ".mcp.json"), "utf8"));
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

    // R5 regression: npm ships an extensionless POSIX sh shim next to the
    // .cmd shim; the probe must prefer the executable extension (raw-spawning
    // the sh script fails CreateProcess with ENOENT on a real machine).
    if (process.platform === "win32") {
      await writeFile(join(binDir, "grok"), "#!/bin/sh\necho sh\n", "utf8");
      await writeFile(join(binDir, "grok.cmd"), "@echo off\n", "utf8");
      const det2 = detectPluginClients(home, env);
      assert.equal(det2.grok.detected, true);
      assert.equal(det2.grok.bin, join(binDir, "grok.cmd"), "prefer the .cmd sibling over the extensionless sh shim");
    }
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
  for (const name of ["copilot", "openclaw", "hermes", "codex", "grok", "ncl", "code"]) {
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
  process.env.PATH = `${mock.binDir}${delimiter}${savedPath}`;
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
      targets: [...PLUGIN_CLIENTS],
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
    assert.ok(existsSync(join(dest, ".mcp.json")), "copilot-native .mcp.json materialized");
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
    // new clients
    assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "marketplace" && c[3] === "add"), `codex marketplace add: ${JSON.stringify(calls)}`);
    assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "add" && c[3] === "deepseek-vl-support@deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "grok" && c[1] === "plugin" && c[2] === "install" && c[3] === dest && c[4] === "--trust"), `grok install: ${JSON.stringify(calls)}`);
    assert.ok(calls.some((c) => c[0] === "ncl" && c[1] === "groups" && c[2] === "create" && c[3] === "--template" && c[4] === "deepseek-vl-support"));
    assert.ok(existsSync(vscodeUserSettingsPath(home)), "vscode user settings written (code CLI detected)");
    assert.ok(existsSync(join(home, ".deepseek-vl", "marketplace", ".agents", "plugins", "marketplace.json")), "codex marketplace shim written");

    // per-client report
    const byClient = new Map(report.agents?.map((r) => [r.agent, r.status]));
    assert.equal(byClient.get("copilot"), "ok");
    assert.equal(byClient.get("cursor"), "ok");
    assert.equal(byClient.get("openclaw"), "ok");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("kiro"), "manual", "kiro always prints manual instructions");
    assert.equal(byClient.get("vscode"), "ok");
    assert.equal(byClient.get("chatgpt-codex"), "ok");
    assert.equal(byClient.get("grok"), "ok");
    assert.equal(byClient.get("nanoclaw"), "ok");
    assert.equal(byClient.get("other"), "manual", "other always prints generic guidance");
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
    assert.equal(report.agents?.find((r) => r.agent === "copilot")?.status, "ok");

    // user adds another plugin; re-install is idempotent and preserves it
    (settings.enabledPlugins as string[]).push("some/other-plugin");
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
    const again = await runInstall({
      cwd: join(base, "project2"),
      home,
      nonInteractive: true,
      targets: ["copilot"],
      clients: ["copilot"],
      baseUrl: "http://127.0.0.1:1/v1",
      model: "qwen2.5vl:7b",
    });
    const after = readJson(settingsFile).enabledPlugins as string[];
    assert.deepEqual(after, [PLUGIN_REPO, "some/other-plugin"], "user entries preserved, no duplicates");
    assert.ok(again.output.some((l) => l.includes("idempotent")));

    // uninstall removes only our entry
    const un = await runUninstall({ cwd: join(base, "project2"), home, targets: ["copilot"], clients: ["copilot"] });
    assert.deepEqual(readJson(settingsFile).enabledPlugins, ["some/other-plugin"]);
    assert.ok(un.agents?.find((r) => r.agent === "copilot")?.status === "ok");
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

    const byClient = new Map(report.agents?.map((r) => [r.agent, r.status]));
    assert.equal(byClient.get("copilot"), "failed");
    assert.equal(byClient.get("openclaw"), "ok", "openclaw unaffected by copilot failure");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("cursor"), "ok");
    assert.ok(report.warnings.some((w) => w.includes("1 agent(s) failed")), "summary warning present");
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

    // report lists ONLY the effective plugin agents (targets ∩ --clients);
    // the old "skipped: not requested" entries are gone
    assert.equal(report.agents?.length, 2, `expected only cursor+hermes, got: ${JSON.stringify(report.agents)}`);
    const byClient = new Map(report.agents?.map((r) => [r.agent, r.status]));
    assert.equal(byClient.get("cursor"), "ok");
    assert.equal(byClient.get("hermes"), "ok");
    assert.equal(byClient.get("copilot"), undefined, "copilot not in targets ∩ --clients");
    assert.equal(byClient.get("openclaw"), undefined);
    assert.equal(byClient.get("kiro"), undefined);
    assert.ok(report.output.some((l) => l.includes("[dry-run]")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("--clients with an empty intersection warns and registers nothing (still materializes)", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, home } = await pluginInstall({ targets: ["copilot"], clients: ["cursor", "hermes"] });

    assert.ok(
      report.warnings.some((w) => w.includes("does not intersect")),
      `expected intersection warning, got: ${report.warnings.join("|")}`,
    );
    assert.equal(report.agents?.length, 0, "no per-agent results when targets ∩ clients is empty");
    assert.equal(mock.callsLog().length, 0, "no external commands executed");
    assert.ok(existsSync(pluginDir(home)), "materialized dir still refreshed (shared state for manual use)");
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

test("detection: codex/grok/ncl/code CLI probes, vscode settings-dir probe, other has no detector", async () => {
  const { base, home } = await makeEnv();
  try {
    const env = { PATH: "" };
    let det = detectPluginClients(home, env);
    assert.equal(det["chatgpt-codex"].detected, false, "codex not on PATH");
    assert.equal(det.grok.detected, false);
    assert.equal(det.nanoclaw.detected, false);
    assert.equal(det.vscode.detected, false, "no code CLI and no settings dir");
    assert.equal(det.other.detected, false);
    assert.equal(det.other.reason, "no detection surface — guidance only");

    // vscode detected via a user settings dir even without the code CLI
    const userDir = join(vscodeUserSettingsPath(home), "..");
    mkdirSync(userDir, { recursive: true });
    det = detectPluginClients(home, env);
    assert.equal(det.vscode.detected, true, "vscode via user settings dir");

    // CLI probes for codex/grok/ncl
    const binDir = join(base, "bin");
    mkdirSync(binDir, { recursive: true });
    const ext = process.platform === "win32" ? ".cmd" : "";
    await writeFile(join(binDir, `codex${ext}`), "@echo off\n", "utf8");
    await writeFile(join(binDir, `grok${ext}`), "@echo off\n", "utf8");
    await writeFile(join(binDir, `ncl${ext}`), "@echo off\n", "utf8");
    det = detectPluginClients(home, { PATH: binDir });
    assert.equal(det["chatgpt-codex"].detected, true);
    assert.equal(det["chatgpt-codex"].bin, join(binDir, `codex${ext}`));
    assert.equal(det.grok.detected, true);
    assert.equal(det.nanoclaw.detected, true);
    assert.equal(det.other.detected, false, "other never has a detector");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("vscode: settings.json chat.pluginLocations write (.bak backup), idempotent re-install, uninstall removes only our entry", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      putClientsOnPath(mockClients);
      // pre-seed a user settings.json with a foreign plugin location so the
      // first install takes the modify-existing path (backup + merge)
      const settingsFile = vscodeUserSettingsPath(home);
      mkdirSync(join(settingsFile, ".."), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({ chat: { pluginLocations: { "/user/plugin": true } } }, null, 2) + "\n", "utf8");

      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["vscode"], clients: ["vscode"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      assert.ok(existsSync(`${settingsFile}.bak`), "backup created on the first modification");
      let locs = ((readJson(settingsFile).chat as Record<string, unknown>).pluginLocations as Record<string, boolean>);
      assert.equal(locs[pluginDir(home)], true, "our plugin dir registered");
      assert.equal(locs["/user/plugin"], true, "user entry preserved");
      assert.equal(report.agents?.find((r) => r.agent === "vscode")?.status, "ok");

      // re-install is idempotent and keeps the user entry
      const again = await runInstall({ cwd: join(base, "project2"), home, nonInteractive: true, targets: ["vscode"], clients: ["vscode"], baseUrl: "http://127.0.0.1:1/v1", model: "qwen2.5vl:7b" });
      assert.ok(again.output.some((l) => l.includes("idempotent")), `expected idempotent log: ${again.output.join("|")}`);
      const after = ((readJson(settingsFile).chat as Record<string, unknown>).pluginLocations as Record<string, boolean>);
      assert.equal(after[pluginDir(home)], true);
      assert.equal(after["/user/plugin"], true);

      // uninstall removes only our entry; .bak holds the pre-uninstall state
      const un = await runUninstall({ cwd: join(base, "project2"), home, targets: ["vscode"], clients: ["vscode"] });
      assert.equal(un.agents?.find((r) => r.agent === "vscode")?.status, "ok");
      const afterUn = ((readJson(settingsFile).chat as Record<string, unknown>).pluginLocations as Record<string, boolean>);
      assert.equal(afterUn[pluginDir(home)], undefined, "our entry removed");
      assert.equal(afterUn["/user/plugin"], true, "user entry kept");
      assert.ok(existsSync(`${settingsFile}.bak`), "uninstall also backs up before writing");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("chatgpt-codex: local marketplace shim OUTSIDE the materialized dir; codex CLI sequence; uninstall removes the plugin", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      putClientsOnPath(mockClients);
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["chatgpt-codex"], clients: ["chatgpt-codex"], baseUrl: mock.url, model: "qwen2.5vl:7b" });

      // the materialized dir keeps exactly its 4 spec entries — no codex
      // marketplace manifest may leak into it (PRD REQ-4 invariant)
      const dest = pluginDir(home);
      assert.deepEqual(readdirSync(dest).sort(), [".mcp.json", "mcp.json", "plugin.json", "skills"]);
      assert.ok(!existsSync(join(dest, ".agents")), "no codex manifest inside the materialized dir");

      // the shim lives OUTSIDE the materialized dir
      const shimManifest = join(home, ".deepseek-vl", "marketplace", ".agents", "plugins", "marketplace.json");
      assert.ok(existsSync(shimManifest), "codex marketplace shim written");
      const mkt = readJson(shimManifest);
      assert.equal(mkt.name, "deepseek-vl-support");
      assert.equal((mkt.owner as Record<string, unknown>).name, "limccn");
      const entry = (mkt.plugins as Array<Record<string, unknown>>)[0];
      assert.equal(entry.name, "deepseek-vl-support");
      assert.deepEqual(entry.source, { source: "local", path: "./plugin" });
      assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
      assert.equal(entry.category, "development");
      assert.ok(existsSync(join(home, ".deepseek-vl", "marketplace", "plugin", "plugin.json")), "shim carries a plugin copy");
      assert.ok(existsSync(join(home, ".deepseek-vl", "marketplace", "plugin", "skills", "deepseek-vision", "SKILL.md")));

      const calls = mockClients.callsLog();
      assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "list"));
      assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "marketplace" && c[3] === "add" && c[4] === join(home, ".deepseek-vl", "marketplace")), `expected marketplace add: ${JSON.stringify(calls)}`);
      assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "add" && c[3] === "deepseek-vl-support@deepseek-vl-support"));
      assert.equal(report.agents?.find((r) => r.agent === "chatgpt-codex")?.status, "ok");

      // uninstall: codex plugin remove; the marketplace registration stays
      const un = await runUninstall({ cwd: project, home, targets: ["chatgpt-codex"], clients: ["chatgpt-codex"] });
      assert.ok(mockClients.callsLog().some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "remove" && c[3] === "deepseek-vl-support@deepseek-vl-support"));
      assert.ok(existsSync(shimManifest), "marketplace shim kept on uninstall");
      assert.equal(un.agents?.find((r) => r.agent === "chatgpt-codex")?.status, "ok");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("chatgpt-codex: manual guidance when the codex CLI is missing (no commands run)", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      await rm(join(mockClients.binDir, process.platform === "win32" ? "codex.cmd" : "codex"), { force: true });
      process.env.PATH = mockClients.binDir;
      process.env.DVLS_MOCK_STATE_DIR = mockClients.stateDir;
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["chatgpt-codex"], clients: ["chatgpt-codex"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      const r = report.agents?.find((a) => a.agent === "chatgpt-codex");
      assert.equal(r?.status, "manual");
      assert.match(r?.detail ?? "", /codex CLI not found/);
      assert.equal(mockClients.callsLog().length, 0, "no commands run without the CLI");
      assert.ok(existsSync(join(pluginDir(home), "plugin.json")), "materialized dir still written for manual installs");
      // the marketplace shim is written even without the CLI so the manual
      // ChatGPT-desktop instructions (which point at shimRoot) are actionable
      assert.ok(
        existsSync(join(home, ".deepseek-vl", "marketplace", ".agents", "plugins", "marketplace.json")),
        "marketplace shim written for the manual install path",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("grok: plugin install --trust via CLI; uninstall --confirm", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      putClientsOnPath(mockClients);
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["grok"], clients: ["grok"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      const dest = pluginDir(home);
      const calls = mockClients.callsLog();
      assert.ok(calls.some((c) => c[0] === "grok" && c[1] === "plugin" && c[2] === "list"));
      assert.ok(calls.some((c) => c[0] === "grok" && c[1] === "plugin" && c[2] === "install" && c[3] === dest && c[4] === "--trust"), `expected grok install: ${JSON.stringify(calls)}`);
      assert.equal(report.agents?.find((r) => r.agent === "grok")?.status, "ok");

      const un = await runUninstall({ cwd: project, home, targets: ["grok"], clients: ["grok"] });
      assert.ok(mockClients.callsLog().some((c) => c[0] === "grok" && c[1] === "plugin" && c[2] === "uninstall" && c[3] === "deepseek-vl-support" && c[4] === "--confirm"), `expected grok uninstall: ${JSON.stringify(mockClients.callsLog())}`);
      assert.equal(un.agents?.find((r) => r.agent === "grok")?.status, "ok");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("grok: manual guidance with the .mcp.json convention note when the CLI is missing", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      await rm(join(mockClients.binDir, process.platform === "win32" ? "grok.cmd" : "grok"), { force: true });
      process.env.PATH = mockClients.binDir;
      process.env.DVLS_MOCK_STATE_DIR = mockClients.stateDir;
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["grok"], clients: ["grok"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      const r = report.agents?.find((a) => a.agent === "grok");
      assert.equal(r?.status, "manual");
      assert.match(r?.detail ?? "", /\.mcp\.json/, "guidance mentions the dot-prefixed MCP convention");
      assert.match(r?.detail ?? "", /grok plugin install/);
      assert.equal(mockClients.callsLog().length, 0, "no commands run without the CLI");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("nanoclaw: template copy (never a symlink) + ncl groups create; uninstall = manual guidance", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      putClientsOnPath(mockClients);
      delete process.env.NANOCLAW_TEMPLATES_DIR;
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["nanoclaw"], clients: ["nanoclaw"], baseUrl: mock.url, model: "qwen2.5vl:7b" });

      const templateDest = join(home, ".deepseek-vl", "nanoclaw-templates", "deepseek-vl-support");
      assert.ok(existsSync(join(templateDest, "plugin.json")), "template copy written");
      assert.ok(existsSync(join(templateDest, "skills", "deepseek-vision", "SKILL.md")));
      const calls = mockClients.callsLog();
      assert.ok(calls.some((c) => c[0] === "ncl" && c[1] === "groups" && c[2] === "create" && c[3] === "--template" && c[4] === "deepseek-vl-support" && c[5] === "--name" && c[6] === "DeepSeek Vision"), `expected ncl groups create: ${JSON.stringify(calls)}`);
      const nanoclawResult = report.agents?.find((r) => r.agent === "nanoclaw");
      assert.equal(nanoclawResult?.status, "ok");
      assert.match(nanoclawResult?.detail ?? "", /NANOCLAW_TEMPLATES_DIR/, "detail points at the templates dir env");

      // uninstall = manual guidance (NanoClaw has no plugin uninstall)
      const un = await runUninstall({ cwd: project, home, targets: ["nanoclaw"], clients: ["nanoclaw"] });
      assert.equal(un.agents?.find((r) => r.agent === "nanoclaw")?.status, "manual");
      assert.ok(existsSync(templateDest), "template copy kept");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("nanoclaw: manual guidance when the ncl CLI is missing", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const mockClients = await makeMockClients(base);
      await rm(join(mockClients.binDir, process.platform === "win32" ? "ncl.cmd" : "ncl"), { force: true });
      process.env.PATH = mockClients.binDir;
      process.env.DVLS_MOCK_STATE_DIR = mockClients.stateDir;
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["nanoclaw"], clients: ["nanoclaw"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      const r = report.agents?.find((a) => a.agent === "nanoclaw");
      assert.equal(r?.status, "manual");
      assert.match(r?.detail ?? "", /ncl CLI not found/);
      assert.equal(mockClients.callsLog().length, 0, "no commands run without the CLI");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("other: materialize only + guidance; uninstall reports guidance only and keeps the dir", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const report = await runInstall({ cwd: project, home, nonInteractive: true, targets: ["other"], clients: ["other"], baseUrl: mock.url, model: "qwen2.5vl:7b" });
      assert.ok(existsSync(join(pluginDir(home), "plugin.json")), "materialized for manual installs");
      const r = report.agents?.find((a) => a.agent === "other");
      assert.equal(r?.status, "manual");
      assert.match(r?.detail ?? "", /agent-plugins\.org\/specification/, "guidance points at the open standard");
      assert.match(r?.detail ?? "", /deepseek-vision/, "guidance mentions the skill name");

      const un = await runUninstall({ cwd: project, home, targets: ["other"], clients: ["other"] });
      const ur = un.agents?.find((a) => a.agent === "other");
      assert.equal(ur?.status, "manual");
      assert.ok(existsSync(pluginDir(home)), "materialized dir kept without --purge-config");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("install plugin: failure isolation — a failing new client (grok) does not block the others", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock, false, "grok:plugin install");
    const { report, home } = await pluginInstall();
    const byClient = new Map(report.agents?.map((r) => [r.agent, r.status]));
    assert.equal(byClient.get("grok"), "failed");
    assert.equal(byClient.get("vscode"), "ok", "vscode unaffected by grok failure");
    assert.equal(byClient.get("chatgpt-codex"), "ok");
    assert.equal(byClient.get("nanoclaw"), "ok");
    assert.equal(byClient.get("copilot"), "ok");
    assert.ok(report.warnings.some((w) => w.includes("agent(s) failed")), "summary warning present");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("install plugin: dry-run for the new clients runs no commands and writes nothing", async () => {
  const { base } = await makeEnv();
  try {
    const mock = await makeMockClients(base);
    putClientsOnPath(mock);
    const { report, home } = await pluginInstall({
      clients: ["vscode", "grok", "chatgpt-codex", "nanoclaw", "other"],
      dryRun: true,
    });
    assert.ok(!existsSync(vscodeUserSettingsPath(home)), "no vscode settings write in dry-run");
    assert.ok(!existsSync(join(home, ".deepseek-vl")), "no marketplace shim / materialize in dry-run");
    assert.equal(mock.callsLog().length, 0, "no external commands executed");
    const byClient = new Map(report.agents?.map((r) => [r.agent, r.status]));
    assert.equal(byClient.get("vscode"), "ok", "dry-run reports vscode ok");
    assert.equal(byClient.get("grok"), "ok");
    assert.equal(byClient.get("chatgpt-codex"), "ok");
    assert.equal(byClient.get("nanoclaw"), "ok");
    assert.equal(byClient.get("other"), "manual", "other is guidance-only even in dry-run");
    assert.ok(report.output.some((l) => l.includes("[dry-run]")));
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
    assert.ok(report.agents, "install report has per-agent results");

    const un = await runUninstall({ cwd: project, home, targets: [...PLUGIN_CLIENTS] });
    const calls = mock.callsLog();
    assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "openclaw" && c[1] === "plugins" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "hermes" && c[1] === "plugins" && c[2] === "uninstall" && c[3] === "deepseek-vl-support"));
    assert.ok(calls.some((c) => c[0] === "grok" && c[1] === "plugin" && c[2] === "uninstall" && c[3] === "deepseek-vl-support" && c[4] === "--confirm"), `grok uninstall: ${JSON.stringify(calls)}`);
    assert.ok(calls.some((c) => c[0] === "codex" && c[1] === "plugin" && c[2] === "remove" && c[3] === "deepseek-vl-support@deepseek-vl-support"), `codex remove: ${JSON.stringify(calls)}`);
    assert.ok(!existsSync(join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME)), "cursor dir removed");
    // vscode: our settings entry removed, file rewritten without it
    const settings = readJson(vscodeUserSettingsPath(home));
    const locs = ((settings.chat as Record<string, unknown> | undefined)?.pluginLocations ?? {}) as Record<string, unknown>;
    assert.ok(!Object.keys(locs).some((k) => k.includes(".deepseek-vl")), "vscode entry removed on uninstall");
    assert.ok(existsSync(pluginDir(home)), "materialized dir kept without --purge-config");
    assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")), "config kept");
    assert.ok(un.kept.some((k) => k.includes("materialized plugin dir kept")));

    // second uninstall is a no-op
    const again = await runUninstall({ cwd: project, home, targets: [...PLUGIN_CLIENTS] });
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
    assert.ok(report.agents);

    // user-authored cursor dir without our marker must survive uninstall
    const userDir = join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_DIRNAME);
    await rm(userDir, { recursive: true, force: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "plugin.json"), "{\"name\":\"user-plugin\"}\n", "utf8");

    const un = await runUninstall({ cwd: project, home, targets: [...PLUGIN_CLIENTS], purgeConfig: true });
    assert.ok(existsSync(join(userDir, "plugin.json")), "user-authored cursor dir kept");
    const cursorResult = un.agents?.find((r) => r.agent === "cursor");
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
    assert.ok(report.agents);

    const un = await runUninstall({ cwd: project, home, targets: ["copilot"], clients: ["copilot"] });
    const settingsFile = join(home, ".copilot", "settings.json");
    const settings = readJson(settingsFile) as { enabledPlugins?: string[] };
    assert.ok(!settings.enabledPlugins || settings.enabledPlugins.length === 0, "our entry removed");
    assert.equal(un.agents?.find((r) => r.agent === "copilot")?.status, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("mixed run: claude + copilot in ONE install (native artifacts + plugin registration); uninstall reverses", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    const mockClients = await makeMockClients(base);
    putClientsOnPath(mockClients);
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      const report = await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        targets: ["claude", "copilot"],
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });

      // claude native artifacts (project scope — no --global passed)
      assert.ok(existsSync(join(project, ".claude", "hooks", HOOK_FILENAME)));

      // copilot registered through the mocked CLI (plugin install command)
      const calls = mockClients.callsLog();
      assert.ok(calls.some((c) => c[0] === "copilot" && c[1] === "plugin" && c[2] === "install"), `expected copilot install call: ${JSON.stringify(calls)}`);

      // endpoint config is global whenever any plugin agent is selected
      assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")));
      assert.ok(!existsSync(join(project, ".deepseek-vl")), "no project config in a mixed run");

      // unified per-agent report shape: claude and copilot side by side
      assert.equal(report.agents?.length, 2);
      assert.equal(report.agents!.find((a) => a.agent === "claude")?.status, "ok");
      assert.equal(report.agents!.find((a) => a.agent === "copilot")?.status, "ok");
      assert.ok(report.output.some((l) => l.startsWith("[claude] ok")), `per-agent line missing: ${report.output.join("|")}`);
      assert.ok(report.output.some((l) => l.startsWith("[copilot] ok")), `per-agent line missing: ${report.output.join("|")}`);

      // uninstall reverses both in one run
      const un = await runUninstall({ cwd: project, home, targets: ["claude", "copilot"] });
      assert.ok(!existsSync(join(project, ".claude", "hooks", HOOK_FILENAME)));
      assert.ok(un.agents!.some((a) => a.agent === "claude" && a.status === "ok"));
      assert.ok(un.agents!.some((a) => a.agent === "copilot" && a.status === "ok"));
      assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")), "config kept without --purge-config");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});
