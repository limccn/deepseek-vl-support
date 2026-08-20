// CLI-agent integration tests (src/cliagents.ts): detection (PATH probes +
// config-dir fallbacks for qwen/reasonix/kilo/workbuddy/devin), project and
// global dual-scope writes, JSON deep-merge discipline (backup, foreign keys
// preserved, idempotent re-install), JSONC files reported manual with the
// bytes untouched, Reasonix TOML block append/update/remove tri-state, Kilo
// json/jsonc probe, the shared project .mcp.json ownership rule, and
// per-agent failure isolation.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_AGENTS,
  CLI_NOT_DETECTED_HINTS,
  detectCliAgents,
  devinHome,
  installCliAgents,
  kiloConfigFile,
  reasonixHome,
  uninstallCliAgents,
  type CliAgentOptions,
} from "../src/cliagents.ts";
import { HOOK_COMMAND_IDENT, HOOK_FILENAME, MANAGED_MARKER, MCP_SERVER_NAME, PKG_NAME, SKILL_DIRNAME, SKILL_MARKER } from "../src/identity.ts";

let tmp: { base: string; project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-cli-"));
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

function text(p: string): string {
  return readFileSync(p, "utf8");
}

function json(p: string): Record<string, unknown> {
  return JSON.parse(text(p)) as Record<string, unknown>;
}

/** CliAgentOptions with a captured warnings array; agents default to the full
 *  module list. */
function copts(cwd: string, home: string, warnings: string[], overrides: Partial<CliAgentOptions> = {}): CliAgentOptions {
  return { cwd, home, agents: [...CLI_AGENTS], warnings, ...overrides };
}

/** Env with an empty PATH so no real CLI from the host machine is ever
 *  detected (detection then relies on config dirs the test creates). */
function emptyPathEnv(): NodeJS.ProcessEnv {
  return { PATH: "" };
}

function skillFileOf(dir: string): string {
  return join(dir, "skills", SKILL_DIRNAME, "SKILL.md");
}

// ---------------------------------------------------------------- detection

test("detection: PATH probe first (multi-bin), then config-dir fallbacks", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const bins = join(base, "bins");
    mkdirSync(bins, { recursive: true });
    const exts = process.platform === "win32" ? [".cmd"] : [""];
    for (const name of ["qwen", "codebuddy", "kilo", "reasonix", "devin"]) {
      for (const ext of exts) writeFileSync(join(bins, name + ext), "", "utf8");
    }
    const env = { PATH: bins };
    const detected = detectCliAgents(home, env);
    for (const a of CLI_AGENTS) {
      assert.equal(detected[a].detected, true, `${a} detected via PATH`);
      assert.ok(detected[a].bin !== null, `${a} resolves a bin`);
    }
    // config-dir fallback (empty PATH): .qwen / .codebuddy / .kilo /
    // reasonix home / devin home
    mkdirSync(join(home, ".qwen"), { recursive: true });
    mkdirSync(join(home, ".codebuddy"), { recursive: true });
    mkdirSync(join(home, ".kilo"), { recursive: true });
    const byDir = detectCliAgents(home, emptyPathEnv());
    assert.equal(byDir.qwen.detected, true);
    assert.equal(byDir.qwen.bin, null);
    assert.equal(byDir.workbuddy.detected, true);
    assert.equal(byDir.kilo.detected, true, "kilo dir fallback: .kilo");
    assert.equal(byDir.reasonix.detected, false, "no reasonix home yet");
    assert.equal(byDir.devin.detected, false, "no devin home yet");
    mkdirSync(reasonixHome(home), { recursive: true });
    mkdirSync(devinHome(home), { recursive: true });
    const all = detectCliAgents(home, emptyPathEnv());
    assert.equal(all.reasonix.detected, true);
    assert.equal(all.devin.detected, true);
    assert.ok(all.qwen.reason.includes("found"), "reason mentions the found dir");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("NOT_DETECTED_HINTS covers exactly the five CLI agents", async () => {
  assert.deepEqual(Object.keys(CLI_NOT_DETECTED_HINTS).sort(), [...CLI_AGENTS].sort());
  for (const a of CLI_AGENTS) {
    assert.ok(CLI_NOT_DETECTED_HINTS[a].length > 5, `${a} hint is non-empty`);
  }
});

// ---------------------------------------------------------------- qwen

test("qwen project scope: skill tree + settings.json (mcpServers + PreToolUse hook) + hook.cjs", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    assert.ok(text(skillFileOf(join(project, ".qwen"))).includes(SKILL_MARKER), "skill copied to .qwen/skills/");
    const settings = json(join(project, ".qwen", "settings.json"));
    const mcp = (settings.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME] as Record<string, unknown>;
    assert.deepEqual(mcp, { command: "npx", args: ["-y", PKG_NAME, "mcp"] });
    const hookEntry = ((settings.hooks as Record<string, unknown[]>).PreToolUse as Array<Record<string, unknown>>)[0];
    assert.equal(hookEntry.matcher, "Read");
    const hookCmd = (hookEntry.hooks as Array<Record<string, unknown>>)[0].command as string;
    assert.ok(hookCmd.includes(HOOK_COMMAND_IDENT), "hook command embeds the ident");
    assert.ok(hookCmd.includes(join(project, ".qwen", "hooks")), "hook command uses the absolute path");
    const hookFile = join(project, ".qwen", "hooks", HOOK_FILENAME);
    assert.ok(existsSync(hookFile), "hook.cjs copied");
    assert.ok(text(hookFile).includes(HOOK_COMMAND_IDENT) || text(hookFile).includes("deepseek-vl-support"), "hook.cjs is ours");
    // idempotent: second install reports no change
    const again = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(again[0].status, "ok");
    assert.ok(again[0].detail.includes("already present"), `idempotent: ${again[0].detail}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("qwen global scope: all artifacts under home/.qwen", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    assert.ok(existsSync(skillFileOf(join(home, ".qwen"))), "global skill tree");
    assert.ok(existsSync(join(home, ".qwen", "settings.json")), "global settings.json");
    assert.ok(existsSync(join(home, ".qwen", "hooks", HOOK_FILENAME)), "global hook.cjs");
    assert.ok(res[0].detail.includes("global scope"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("qwen JSONC settings.json -> manual, file bytes untouched", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const file = join(project, ".qwen", "settings.json");
    mkdirSync(join(file, ".."), { recursive: true });
    const original = `{
  // user comment
  "mcpServers": { "other": { "command": "echo", "args": ["hi"] } }, // trailing comment
  "enableSomething": true,
}`;
    writeFileSync(file, original, "utf8");
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "manual");
    assert.ok(res[0].detail.includes("Manual"), "manual guidance present");
    assert.equal(text(file), original, "JSONC file bytes never rewritten");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("qwen uninstall: removes entries + hook.cjs + skill; foreign keys and unmarked files kept", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    await installCliAgents(copts(project, home, warnings, { agents: ["qwen"] }), detectCliAgents(home, emptyPathEnv()));
    const settingsFile = join(project, ".qwen", "settings.json");
    // add a foreign server + foreign hook entry, and an unmarked user skill file
    const data = json(settingsFile);
    (data.mcpServers as Record<string, unknown>)["user-server"] = { command: "echo" };
    const hooks = data.hooks as Record<string, unknown[]>;
    (hooks.PreToolUse as unknown[]).push({ matcher: "Edit", hooks: [{ type: "command", command: "node user-hook.js" }] });
    writeFileSync(settingsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
    const userSkill = join(project, ".qwen", "skills", SKILL_DIRNAME, "SKILL.md");
    writeFileSync(userSkill, "# user skill\nno marker here\n", "utf8");
    const res = await uninstallCliAgents(
      copts(project, home, warnings, { agents: ["qwen"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    const after = json(settingsFile);
    assert.equal((after.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME], undefined, "our mcp entry removed");
    assert.equal((after.mcpServers as Record<string, { command: string }>)["user-server"].command, "echo", "foreign server kept");
    const remainingHooks = after.hooks as Record<string, unknown[]>;
    assert.ok(!(remainingHooks.PreToolUse ?? []).some((e) => JSON.stringify(e).includes(HOOK_COMMAND_IDENT)), "our hook entries removed");
    assert.ok((remainingHooks.PreToolUse ?? []).some((e) => JSON.stringify(e).includes("user-hook")), "foreign hook entry kept");
    assert.ok(!existsSync(join(project, ".qwen", "hooks", HOOK_FILENAME)), "hook.cjs removed");
    assert.ok(existsSync(userSkill), "unmarked user skill file kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- reasonix

test("reasonix project scope: shared skill + .mcp.json + .reasonix settings.json hook", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared project skill");
    const mcp = json(join(project, ".mcp.json"));
    assert.deepEqual((mcp.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME], {
      command: "npx",
      args: ["-y", PKG_NAME, "mcp"],
    });
    const settings = json(join(project, ".reasonix", "settings.json"));
    const hookEntry = ((settings.hooks as Record<string, unknown[]>).PreToolUse as Array<Record<string, unknown>>)[0];
    assert.equal(hookEntry.matcher, "Read");
    assert.ok(existsSync(join(project, ".reasonix", "hooks", HOOK_FILENAME)), "hook.cjs copied");
    // uninstall keeps the shared tree but removes the .mcp.json entry
    const un = await uninstallCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(un[0].status, "ok");
    const after = existsSync(join(project, ".mcp.json")) ? json(join(project, ".mcp.json")) : {};
    assert.equal((after.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_NAME], undefined, ".mcp.json entry removed");
    // .reasonix/settings.json may remain but must no longer carry our hook
    if (existsSync(join(project, ".reasonix", "settings.json"))) {
      const s = json(join(project, ".reasonix", "settings.json"));
      const hooks = (s.hooks as Record<string, unknown[]> | undefined)?.PreToolUse ?? [];
      assert.ok(!hooks.some((e) => JSON.stringify(e).includes(HOOK_COMMAND_IDENT)), "our hook entries removed from settings.json");
    }
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared tree kept");
    assert.ok(un[0].detail.includes("shared"), "shared-file note present");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reasonix global: config.toml [[plugins]] block + ~/.agents/skills + home settings.json", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    const toml = text(join(reasonixHome(home), "config.toml"));
    assert.ok(toml.includes(`name = "${MCP_SERVER_NAME}"`), "toml block name");
    assert.ok(toml.includes(`command = "npx"`), "toml block command");
    assert.ok(toml.includes(`${MANAGED_MARKER}:start`) && toml.includes(`${MANAGED_MARKER}:end`), "managed markers");
    assert.ok(existsSync(join(home, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "global shared skill");
    assert.ok(existsSync(join(reasonixHome(home), "settings.json")), "home settings.json hook");
    assert.ok(existsSync(join(reasonixHome(home), "hooks", HOOK_FILENAME)), "home hook.cjs");
    // tri-state: reinstall is idempotent; uninstall removes the block, keeps
    // the shared tree and unrelated toml content
    const again = await installCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.ok(again[0].detail.includes("already has our [[plugins]] block"), `idempotent toml: ${again[0].detail}`);
    const un = await uninstallCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(un[0].status, "ok");
    assert.ok(!text(join(reasonixHome(home), "config.toml")).includes(MCP_SERVER_NAME), "toml block removed");
    assert.ok(existsSync(join(home, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "global shared tree kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reasonix TOML update: reinstall refreshes an edited managed block", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const opts = copts(project, home, warnings, { agents: ["reasonix"], global: true });
    await installCliAgents(opts, detectCliAgents(home, emptyPathEnv()));
    const tomlFile = join(reasonixHome(home), "config.toml");
    // simulate an outdated managed block (old args line)
    const stale = text(tomlFile).replace('args = ["-y"', 'args = ["-y", "deepseek-vl-support@0.0.0"');
    writeFileSync(tomlFile, stale, "utf8");
    await installCliAgents(opts, detectCliAgents(home, emptyPathEnv()));
    const updated = text(tomlFile);
    assert.ok(!updated.includes("@0.0.0"), "stale args replaced");
    assert.equal(updated.split(`${MANAGED_MARKER}:start`).length - 1, 1, "exactly one managed block");
    // managed-block markers are decoupled from PKG_NAME: the scoped rename
    // must not orphan old installs' `# deepseek-vl-support:start` blocks
    assert.ok(!updated.includes(`# ${PKG_NAME}:start`), "marker does not track PKG_NAME (stable across the scoped rename)");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reasonix uninstall: partial managed block (missing marker) is left untouched", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const tomlFile = join(reasonixHome(home), "config.toml");
    mkdirSync(join(tomlFile, ".."), { recursive: true });
    const broken = `# ${MANAGED_MARKER}:start\n[[plugins]]\nname = "x"\n`;
    writeFileSync(tomlFile, broken, "utf8");
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.ok(res[0].detail.includes("partial managed block"), `manual-ish handling: ${res[0].detail}`);
    assert.equal(text(tomlFile), broken, "broken file untouched");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- kilo

test("kilo project scope: mcp entry with ARRAY command in .kilo/kilo.json", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["kilo"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    const kilo = json(join(project, ".kilo", "kilo.json"));
    assert.deepEqual((kilo.mcp as Record<string, unknown>)[MCP_SERVER_NAME], {
      type: "local",
      command: ["npx", "-y", PKG_NAME, "mcp"],
      enabled: true,
    });
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared skill");
    // uninstall removes only our mcp entry, foreign key kept
    const data = json(join(project, ".kilo", "kilo.json"));
    (data.mcp as Record<string, unknown>)["user-server"] = { type: "local", command: ["echo", "hi"] };
    writeFileSync(join(project, ".kilo", "kilo.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
    const un = await uninstallCliAgents(
      copts(project, home, warnings, { agents: ["kilo"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(un[0].status, "ok");
    const after = json(join(project, ".kilo", "kilo.json"));
    assert.equal((after.mcp as Record<string, unknown>)[MCP_SERVER_NAME], undefined);
    assert.deepEqual((after.mcp as Record<string, unknown>)["user-server"], { type: "local", command: ["echo", "hi"] });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("kilo global scope: prefers existing kilo.jsonc, creates kilo.json when none exists", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const configDir = join(home, ".config", "kilo");
    mkdirSync(configDir, { recursive: true });
    const jsonc = join(configDir, "kilo.jsonc");
    writeFileSync(jsonc, '{"theme": "dark"}', "utf8");
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["kilo"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    const after = json(jsonc);
    assert.ok((after.mcp as Record<string, unknown>)[MCP_SERVER_NAME], "entry written into existing kilo.jsonc");
    assert.ok(!existsSync(join(configDir, "kilo.json")), "no kilo.json created when jsonc exists");
    assert.deepEqual(kiloConfigFile(project, home, true).file, jsonc, "probe prefers the existing file");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- workbuddy

test("workbuddy project scope: skill copy + .mcp.json stdio entry; JSONC -> manual", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["workbuddy"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    assert.ok(text(skillFileOf(join(project, ".codebuddy"))).includes(SKILL_MARKER), "skill copied to .codebuddy/skills/");
    const mcp = json(join(project, ".mcp.json"));
    assert.deepEqual((mcp.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME], {
      type: "stdio",
      command: "npx",
      args: ["-y", PKG_NAME, "mcp"],
    });
    // JSONC .mcp.json -> manual, bytes untouched
    writeFileSync(join(project, ".mcp.json"), '{ "mcpServers": { "user": { "command": "x" } }, // note\n}', "utf8");
    const res2 = await installCliAgents(
      copts(project, home, warnings, { agents: ["workbuddy"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res2[0].status, "manual");
    assert.ok(res2[0].detail.includes("Manual"), "manual guidance");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- devin

test("devin project + global scope: mcp_config.json entry in both scopes", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["devin"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    const mcp = json(join(project, ".devin", "mcp_config.json"));
    assert.deepEqual((mcp.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME], {
      command: "npx",
      args: ["-y", PKG_NAME, "mcp"],
    });
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "project shared skill");
    const resG = await installCliAgents(
      copts(project, home, warnings, { agents: ["devin"], global: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(resG[0].status, "ok");
    const globalMcp = json(join(devinHome(home), "mcp_config.json"));
    assert.ok((globalMcp.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME], "global mcp_config.json");
    assert.ok(existsSync(join(home, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "global shared skill");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- shared rules

test("shared .mcp.json ownership: reasonix installs -> workbuddy idempotent -> reasonix uninstall removes the entry", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const det = detectCliAgents(home, emptyPathEnv());
    const r1 = await installCliAgents(copts(project, home, warnings, { agents: ["reasonix"] }), det);
    assert.equal(r1[0].status, "ok");
    const w1 = await installCliAgents(copts(project, home, warnings, { agents: ["workbuddy"] }), det);
    assert.ok(w1[0].detail.includes("already present"), `workbuddy sees the shared entry as present: ${w1[0].detail}`);
    const u = await uninstallCliAgents(copts(project, home, warnings, { agents: ["reasonix"] }), det);
    assert.equal(u[0].status, "ok");
    const after = json(join(project, ".mcp.json"));
    assert.equal((after.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_NAME], undefined, "entry removed by reasonix");
    assert.ok(u[0].detail.includes("shared"), "shared-file note present");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("uninstall: shared .agents/skills tree kept for every CLI agent (only codex removes it)", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const det = detectCliAgents(home, emptyPathEnv());
    await installCliAgents(copts(project, home, warnings, { agents: ["reasonix", "kilo", "devin"] }), det);
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")));
    await uninstallCliAgents(copts(project, home, warnings, { agents: ["reasonix", "kilo", "devin"] }), det);
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared tree kept after uninstall");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("failure isolation: one agent throwing does not block the others", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    // make the qwen settings.json path a DIRECTORY so the write throws
    const qwenDir = join(project, ".qwen");
    mkdirSync(join(qwenDir, "settings.json"), { recursive: true });
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen", "devin"] }),
      detectCliAgents(home, emptyPathEnv()),
    );
    const qwen = res.find((r) => r.agent === "qwen");
    const devin = res.find((r) => r.agent === "devin");
    assert.equal(qwen?.status, "failed", "qwen write failure surfaced");
    assert.equal(devin?.status, "ok", "devin unaffected by qwen failure");
    assert.ok(existsSync(join(project, ".devin", "mcp_config.json")), "devin artifacts written");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("dry-run writes nothing", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: [...CLI_AGENTS], dryRun: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.ok(res.every((r) => r.status === "ok"), "dry-run reports ok");
    assert.ok(res.every((r) => r.detail.includes("[dry-run]")), "dry-run details marked");
    const leftover = [".qwen", ".reasonix", ".kilo", ".codebuddy", ".devin", ".agents", ".mcp.json"];
    for (const name of leftover) {
      assert.ok(!existsSync(join(project, name)), `dry-run must not create ${name}`);
    }
    assert.ok(!existsSync(join(home, ".qwen")), "dry-run must not write home");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- skillAction passthrough (R4/R7)

test("skillAction: keep preserves a user-authored skill, overwrite backs up + replaces (R4 passthrough)", async () => {
  const { base, project, home } = await makeEnv();
  try {
    // user-authored skill at the qwen target path (no marker)
    const skillFile = skillFileOf(join(project, ".qwen"));
    mkdirSync(join(skillFile, ".."), { recursive: true });
    writeFileSync(skillFile, "# my own qwen skill\n", "utf8");

    // keep: file untouched, no skip warning (the wizard decision overrides legacy rules)
    const warnings: string[] = [];
    const logs: string[] = [];
    const kept = await installCliAgents(
      copts(project, home, warnings, { agents: ["qwen"], skillAction: "keep", log: (m) => logs.push(m) }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(kept[0].status, "ok");
    assert.equal(text(skillFile), "# my own qwen skill\n", "keep leaves the file alone");
    assert.ok(logs.some((m) => m.includes("kept")), `kept logged: ${logs.join(" | ")}`);
    assert.ok(!warnings.some((w) => w.includes("user-authored")), "keep is a decision, not a warning");

    // overwrite: backed up + replaced with the packaged skill
    const warnings2: string[] = [];
    const over = await installCliAgents(
      copts(project, home, warnings2, { agents: ["qwen"], skillAction: "overwrite" }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(over[0].status, "ok");
    assert.ok(text(skillFile).includes(SKILL_MARKER), "overwrite replaced the file with ours");
    assert.ok(existsSync(skillFile + ".bak"), "user-authored file backed up");
    assert.equal(text(skillFile + ".bak"), "# my own qwen skill\n", "backup keeps the original");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("--update with a user-authored skill at a shared-tree target backs up + overwrites (R7)", async () => {
  const { base, project, home } = await makeEnv();
  try {
    // reasonix project scope writes the shared .agents/skills/ tree
    const skillFile = skillFileOf(join(project, ".agents"));
    mkdirSync(join(skillFile, ".."), { recursive: true });
    writeFileSync(skillFile, "# hand-written shared skill\n", "utf8");

    const warnings: string[] = [];
    const res = await installCliAgents(
      copts(project, home, warnings, { agents: ["reasonix"], update: true }),
      detectCliAgents(home, emptyPathEnv()),
    );
    assert.equal(res[0].status, "ok");
    assert.ok(text(skillFile).includes(SKILL_MARKER), "--update replaced the user file with ours");
    assert.ok(existsSync(skillFile + ".bak"), "user-authored file backed up");
    assert.equal(text(skillFile + ".bak"), "# hand-written shared skill\n");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
