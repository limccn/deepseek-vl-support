// Skill-copy agent tests (src/skillagents.ts): detection (PATH probes +
// config-dir fallbacks), opencode.json deep-merge discipline (backup, user
// keys preserved, idempotent re-install, uninstall removes our entry only),
// trae skill copy + user-authored file protection, pi adapter-gated mcp.json,
// omp shared-skill guidance, dsh skill-only guidance, the shared
// .agents/skills/ ownership rule, and the package.json pi manifest contract.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectSkillModuleAgents,
  installSkillAgents,
  opencodeConfigDir,
  opencodeConfigFile,
  SHARED_SKILL_KEEP_NOTE,
  SKILL_MODULE_AGENTS,
  traeConfigDir,
  uninstallSkillAgents,
  type SkillAgentOptions,
} from "../src/skillagents.ts";
import { MCP_SERVER_NAME, PKG_NAME, SKILL_DIRNAME, SKILL_MARKER } from "../src/identity.ts";
import { runInstall, runUninstall } from "../src/install.ts";
import { startMockVisionServer } from "./mock-vision-server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let tmp: { base: string; project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-skill-"));
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

/** SkillAgentOptions with the agents defaulting to the full module list and a
 *  captured warnings array. */
function sopts(cwd: string, home: string, warnings: string[]): SkillAgentOptions {
  return { cwd, home, agents: [...SKILL_MODULE_AGENTS], warnings };
}

function detectedAllFalse(env: NodeJS.ProcessEnv, home: string): boolean {
  return SKILL_MODULE_AGENTS.every((a) => detectSkillModuleAgents(home, env)[a].detected === false);
}

function fakeBins(names: string[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  const exts = process.platform === "win32" ? [".cmd"] : [""];
  for (const name of names) {
    for (const ext of exts) writeFileSync(join(dir, name + ext), "", "utf8");
  }
}

// ---------------------------------------------------------------- detection

test("detection: hermetic PATH and empty home → nothing detected", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const env = { PATH: "" };
    const d = detectSkillModuleAgents(home, env);
    assert.equal(detectedAllFalse(env, home), true);
    for (const a of SKILL_MODULE_AGENTS) {
      assert.equal(d[a].bin, null, `${a} has no resolved bin`);
      assert.ok(d[a].reason.length > 0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("detection: CLI on PATH is detected; trae is a directory-only probe", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const binDir = join(base, "bin");
    fakeBins(["opencode", "pi", "dsh"], binDir);
    const env = { PATH: binDir };
    const d = detectSkillModuleAgents(home, env);
    assert.equal(d.opencode.detected, true);
    assert.equal(d.opencode.bin, join(binDir, "opencode" + (process.platform === "win32" ? ".cmd" : "")));
    assert.equal(d.pi.detected, true);
    assert.equal(d.dsh.detected, true);
    assert.equal(d.trae.detected, false, "trae has no CLI — dir probe only");
    // trae appears once its config dir exists (still no CLI on PATH)
    mkdirSync(traeConfigDir(home), { recursive: true });
    assert.equal(detectSkillModuleAgents(home, env).trae.detected, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("detection: config-dir fallback when no CLI is on PATH", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const env = { PATH: "" };
    assert.equal(detectSkillModuleAgents(home, env).opencode.detected, false);
    mkdirSync(opencodeConfigDir(home), { recursive: true });
    assert.equal(detectSkillModuleAgents(home, env).opencode.detected, true, "opencode config dir fallback");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    assert.equal(detectSkillModuleAgents(home, env).pi.detected, true, "pi config dir fallback");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    assert.equal(detectSkillModuleAgents(home, env).dsh.detected, true, "dsh config dir fallback");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- opencode

test("opencode install: opencode.json deep-merge (user keys + foreign mcp servers kept), backup, shared skill", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const file = opencodeConfigFile(project, home);
    writeFileSync(
      file,
      JSON.stringify({ "user-key": "keep", mcp: { "other-server": { type: "local", command: ["echo", "hi"] } } }, null, 2) + "\n",
      "utf8",
    );
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const opencode = results.find((r) => r.agent === "opencode");
    assert.equal(opencode?.status, "ok");
    assert.ok(opencode!.detail.includes("backup"), `backup noted: ${opencode!.detail}`);
    const data = json(file) as { "user-key": string; mcp: Record<string, unknown> };
    assert.equal(data["user-key"], "keep", "user keys untouched");
    assert.ok(data.mcp["other-server"], "foreign mcp servers untouched");
    const entry = data.mcp[MCP_SERVER_NAME] as Record<string, unknown>;
    assert.deepEqual(entry, { type: "local", command: ["npx", "-y", PKG_NAME, "mcp"], enabled: true });
    assert.ok(existsSync(`${file}.bak`), "backup written before first modification");
    const skill = join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md");
    assert.ok(existsSync(skill), "shared skill written");
    assert.ok(text(skill).includes(SKILL_MARKER), "skill carries our marker");
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "references", "vision-prompt.md")));
    assert.deepEqual(warnings, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("opencode re-install is idempotent: entry kept, no rewrite", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const before = text(opencodeConfigFile(project, home));
    const second = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const detail = second.find((r) => r.agent === "opencode")!.detail;
    assert.ok(detail.includes("already present") && detail.includes("idempotent, no change"), detail);
    assert.equal(text(opencodeConfigFile(project, home)), before, "file not rewritten");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("opencode uninstall removes our entry only; shared skill kept with the ownership note", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const file = opencodeConfigFile(project, home);
    writeFileSync(
      file,
      JSON.stringify(
        { mcp: { [MCP_SERVER_NAME]: { type: "local", command: ["npx", "-y", PKG_NAME, "mcp"] }, "other-server": { type: "local" } } },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const results = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const detail = results.find((r) => r.agent === "opencode")!.detail;
    assert.ok(detail.includes("removed mcp["), detail);
    assert.ok(detail.includes(SHARED_SKILL_KEEP_NOTE), `keep note present: ${detail}`);
    const data = json(file) as { mcp: Record<string, unknown> };
    assert.equal(data.mcp[MCP_SERVER_NAME], undefined, "our entry gone");
    assert.ok(data.mcp["other-server"], "foreign servers kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("opencode global scope: config under the global dir; project untouched; no project .agents", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const projectFile = opencodeConfigFile(project, home);
    writeFileSync(projectFile, JSON.stringify({ "user-key": 1 }, null, 2) + "\n", "utf8");
    const warnings: string[] = [];
    const results = await installSkillAgents(
      { ...sopts(project, home, warnings), global: true },
      detectSkillModuleAgents(home, { PATH: "" }),
    );
    assert.equal(results.find((r) => r.agent === "opencode")?.status, "ok");
    const globalFile = opencodeConfigFile(project, home, true);
    assert.ok(existsSync(globalFile), "global opencode.json written");
    const data = json(globalFile) as { mcp: Record<string, unknown> };
    assert.ok(data.mcp[MCP_SERVER_NAME], "MCP entry in the global file");
    assert.deepEqual(json(projectFile), { "user-key": 1 }, "project opencode.json untouched");
    assert.ok(!existsSync(join(project, ".agents")), "global scope skips the project skill write");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("opencode manual mode: invalid JSON file left untouched; other agents still install (failure isolation)", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const file = opencodeConfigFile(project, home);
    writeFileSync(file, "{ not json", "utf8");
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const opencode = results.find((r) => r.agent === "opencode")!;
    assert.equal(opencode.status, "manual");
    assert.ok(opencode.detail.includes("left untouched"), opencode.detail);
    assert.equal(text(file), "{ not json", "file never modified");
    const trae = results.find((r) => r.agent === "trae")!;
    assert.equal(trae.status, "manual", "trae result still produced — one failure does not block the others");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- trae

test("trae install: skill copied to .trae/skills with marker + manual import guidance; undetected hint", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const trae = results.find((r) => r.agent === "trae")!;
    assert.equal(trae.status, "manual");
    assert.ok(trae.detail.includes("Trae not detected — install it first"), trae.detail);
    assert.ok(trae.detail.includes("Settings → Rules & Skills"), `import guidance: ${trae.detail}`);
    const skillDir = join(project, ".trae", "skills", SKILL_DIRNAME);
    assert.ok(existsSync(join(skillDir, "SKILL.md")), "SKILL.md copied");
    assert.ok(text(join(skillDir, "SKILL.md")).includes(SKILL_MARKER), "marker present");
    assert.ok(existsSync(join(skillDir, "references", "vision-prompt.md")));
    assert.deepEqual(warnings, []);
    // detected trae: no "install it first" hint
    mkdirSync(traeConfigDir(home), { recursive: true });
    const detected = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    assert.ok(!detected.find((r) => r.agent === "trae")!.detail.includes("Trae not detected"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("trae: user-authored SKILL.md is never overwritten; uninstall keeps it and reports", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const skillDir = join(project, ".trae", "skills", SKILL_DIRNAME);
    const skillFile = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, "# my own skill\n", "utf8");
    const warnings: string[] = [];
    await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    assert.equal(text(skillFile), "# my own skill\n", "user-authored SKILL.md untouched");
    assert.ok(warnings.some((w) => w.includes("exists without our marker")), `warned: ${warnings.join("|")}`);
    // the managed references file was still written; uninstall removes only it
    const results = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const detail = results.find((r) => r.agent === "trae")!.detail;
    assert.ok(detail.includes("user-authored") && detail.includes("kept"), detail);
    assert.equal(text(skillFile), "# my own skill\n", "still kept after uninstall");
    assert.ok(!existsSync(join(skillDir, "references", "vision-prompt.md")), "our references file removed");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("trae uninstall removes the whole managed tree and the empty dirs", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const results = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const detail = results.find((r) => r.agent === "trae")!.detail;
    assert.ok(detail.includes("deleted"), detail);
    assert.ok(!existsSync(join(project, ".trae", "skills", SKILL_DIRNAME)), "skill dir removed (empty parents stay)");
    // uninstall again: nothing to remove, reported cleanly
    const again = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    assert.ok(again.find((r) => r.agent === "trae")!.detail.includes("nothing to remove"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- pi

test("pi: no adapter → mcp.json never written, guidance prints the native install first, shared skill still installed", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const pi = results.find((r) => r.agent === "pi")!;
    assert.equal(pi.status, "manual");
    assert.ok(pi.detail.includes(`pi install npm:${PKG_NAME}`), `native install recommended first: ${pi.detail}`);
    assert.ok(
      pi.detail.includes("native extension") && pi.detail.includes("pasting an image or reading an image file is described automatically"),
      `extension note present: ${pi.detail}`,
    );
    assert.ok(pi.detail.includes("pi-mcp-adapter"), "adapter kept as the tooling supplement");
    assert.ok(!existsSync(join(home, ".pi", "agent", "mcp.json")), "no mcp.json without the adapter");
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "skill installed regardless");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pi: adapter present via pre-seeded mcp.json → merged idempotently; uninstall removes only our entry", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const file = join(home, ".pi", "agent", "mcp.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { "other-server": { command: "echo" } } }, null, 2) + "\n", "utf8");
    const warnings: string[] = [];
    const first = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const pi = first.find((r) => r.agent === "pi")!;
    assert.equal(pi.status, "ok");
    assert.ok(pi.detail.includes("added mcpServers"), pi.detail);
    assert.ok(pi.detail.includes("backup"), pi.detail);
    let data = json(file) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(data.mcpServers[MCP_SERVER_NAME], { command: "npx", args: ["-y", PKG_NAME, "mcp"] });
    assert.ok(data.mcpServers["other-server"], "foreign servers kept");
    const second = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    assert.ok(second.find((r) => r.agent === "pi")!.detail.includes("already present"));
    const before = text(file);
    await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    data = json(file) as { mcpServers: Record<string, unknown> };
    assert.equal(data.mcpServers[MCP_SERVER_NAME], undefined, "our entry removed");
    assert.ok(data.mcpServers["other-server"], "foreign servers kept after uninstall");
    assert.notEqual(text(file), before, "uninstall rewrites the file");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pi: adapter present via ~/.pi/agent/npm dir → mcp.json created", async () => {
  const { base, project, home } = await makeEnv();
  try {
    mkdirSync(join(home, ".pi", "agent", "npm"), { recursive: true });
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    assert.equal(results.find((r) => r.agent === "pi")?.status, "ok");
    const file = join(home, ".pi", "agent", "mcp.json");
    assert.ok(existsSync(file));
    const data = json(file) as { mcpServers: Record<string, unknown> };
    assert.ok(data.mcpServers[MCP_SERVER_NAME], "entry written");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- omp

test("omp: shared skill written + native install guidance; no config file ever touched", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const omp = results.find((r) => r.agent === "omp")!;
    assert.equal(omp.status, "ok");
    assert.ok(omp.detail.includes(`omp install npm:${PKG_NAME}`), `native install command in guidance: ${omp.detail}`);
    assert.ok(omp.detail.includes("Oh My Pi not detected — install it first"), "omp not detected — install it first");
    assert.ok(omp.detail.includes("/reload-plugins"), "reload hint present");
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared skill written");
    assert.ok(!existsSync(join(home, ".omp")), "no omp config dir created");
    assert.ok(!existsSync(join(project, ".omp")), "no project omp config created");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("omp: detected via PATH → no undetected prefix; uninstall keeps the shared tree", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const bins = join(base, "bins");
    mkdirSync(bins, { recursive: true });
    writeFileSync(join(bins, "omp" + (process.platform === "win32" ? ".cmd" : "")), "", "utf8");
    const warnings: string[] = [];
    const env = { PATH: bins };
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, env));
    const omp = results.find((r) => r.agent === "omp")!;
    assert.ok(!omp.detail.includes("not detected"), `no undetected prefix when on PATH: ${omp.detail}`);
    const un = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, env));
    const detail = un.find((r) => r.agent === "omp")!.detail;
    assert.ok(detail.includes(SHARED_SKILL_KEEP_NOTE), detail);
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared skill kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("package.json pi manifest: explicit skills+extensions globs pointing at existing dirs, pi-package keyword, files whitelist complete", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    pi?: { extensions?: string[]; skills?: string[] };
    keywords?: string[];
    files?: string[];
  };
  assert.ok(Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0, "pi.extensions present and non-empty (pi: {} would load nothing)");
  for (const glob of pkg.pi!.extensions!) {
    const dir = join(ROOT, glob.replace(/^\.\//, ""));
    assert.ok(existsSync(dir), `pi.extensions glob "${glob}" resolves to an existing directory`);
  }
  assert.ok(Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0, "pi.skills present and non-empty");
  for (const glob of pkg.pi!.skills!) {
    const dir = join(ROOT, glob.replace(/^\.\//, ""));
    assert.ok(existsSync(dir), `pi.skills glob "${glob}" resolves to an existing directory`);
  }
  assert.ok(pkg.keywords?.includes("pi-package"), "pi-package keyword for the pi.dev gallery");
  assert.ok(pkg.files?.includes("extensions/"), "files whitelist ships extensions/");
  assert.ok(pkg.files?.includes("skills/"), "files whitelist ships skills/");
  assert.ok(pkg.files?.includes(".mcp.json") && pkg.files?.includes("mcp.json"), "files whitelist ships both mcp manifests");
});

test("AGENTS ordering: omp sits right after pi and before dsh (D3)", async () => {
  const { AGENTS } = await import("../src/plugin.ts");
  const pi = AGENTS.indexOf("pi");
  const omp = AGENTS.indexOf("omp");
  const dsh = AGENTS.indexOf("dsh");
  assert.ok(pi >= 0 && omp >= 0 && dsh >= 0, "pi/omp/dsh all present");
  assert.equal(omp, pi + 1, "Oh My Pi immediately follows Pi Agent");
  assert.ok(dsh > omp, "dsh after omp");
});

// ---------------------------------------------------------------- dsh

test("dsh: shared skill + manual MCP guidance; uninstall removes no own artifacts", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const warnings: string[] = [];
    const results = await installSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const dsh = results.find((r) => r.agent === "dsh")!;
    assert.equal(dsh.status, "manual");
    assert.ok(dsh.detail.includes("cordis.patch.yml"), dsh.detail);
    assert.ok(dsh.detail.includes("dsh not detected — install it first"), dsh.detail);
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")));
    const un = await uninstallSkillAgents(sopts(project, home, warnings), detectSkillModuleAgents(home, { PATH: "" }));
    const detail = un.find((r) => r.agent === "dsh")!.detail;
    assert.ok(detail.includes(SHARED_SKILL_KEEP_NOTE), detail);
    assert.ok(existsSync(join(project, ".agents", "skills", SKILL_DIRNAME, "SKILL.md")), "shared skill kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ownership

test("shared .agents/skills ownership: pi uninstall keeps it; codex uninstall deletes it", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        targets: ["pi"],
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });
      const skillDir = join(project, ".agents", "skills", SKILL_DIRNAME);
      assert.ok(existsSync(join(skillDir, "SKILL.md")), "pi install wrote the shared skill");
      await runUninstall({ cwd: project, home, targets: ["pi"] });
      assert.ok(existsSync(join(skillDir, "SKILL.md")), "pi uninstall keeps the shared skill");
      await runUninstall({ cwd: project, home, targets: ["codex"] });
      assert.ok(!existsSync(skillDir), "codex uninstall (the owner) deletes the tree");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});
