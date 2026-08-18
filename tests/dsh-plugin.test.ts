// DeepSeek Harness (dsh) native cordis plugin assertions: package.json dsh
// manifest + main + files, cordis.patch.yml shape, the built plugin bundle
// (exports name/inject/apply, @deepseek-ai stays a bare runtime import), the
// shared tools.ts helpers (describe_image/vision_status contract locked to the
// MCP wording, against a mock vision server), and the registerDsh guidance
// copy. Plugin LOADING inside a real dsh profile needs the real machine —
// that is the user's real-machine e2e checklist in docs/releasing.md.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callDescribeImage, callVisionStatus } from "../src/tools.ts";
import { makeFakePng, startMockVisionServer } from "./mock-vision-server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let tmp: { project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function makeEnv(): Promise<{ project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-dsh-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { project, home };
  // tools.ts resolves config/cache from os.homedir() — point it at the temp
  // home so tests never touch the real user config.
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return { project, home };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_")) delete process.env[k];
  }
});

afterEach(async () => {
  process.env = { ...savedEnv };
  if (tmp) {
    await rm(tmp.project, { recursive: true, force: true });
    await rm(tmp.home, { recursive: true, force: true });
    tmp = null;
  }
});

// ---------------------------------------------------------------- manifest

test("package.json dsh manifest: bundle.patch → cordis.patch.yml, main → plugin entry, files/keywords", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dsh?: { bundle?: { patch?: string } };
    main?: string;
    files?: string[];
    keywords?: string[];
  };
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "dsh.bundle.patch activates the bundle layer");
  assert.ok(existsSync(join(ROOT, "cordis.patch.yml")), "cordis.patch.yml exists at the repo root");
  assert.equal(pkg.main, "./dist/dsh-plugin.js", "main resolves the cordis plugin entry");
  assert.ok(pkg.files?.includes("cordis.patch.yml"), "files whitelist ships cordis.patch.yml");
  assert.ok(pkg.keywords?.includes("dsh-plugin"), "dsh-plugin keyword for the dsh discovery topic");
});

test("cordis.patch.yml: top-level array, insert row with stable id and package name", () => {
  const y = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  assert.match(y, /(^|\n)- insert:/m, "top-level array element opens with - insert:");
  assert.ok(y.includes("id: deepseek-vl"), "stable id deepseek-vl (matches MCP_SERVER_NAME / plugin name)");
  assert.ok(y.includes("name: deepseek-vl-support"), "name resolves the package main entry");
  assert.ok(y.includes("config: {}"), "empty config — plugin reads the VISION_* env / config.json chain");
  assert.match(y, /^[\x00-\x7F]*$/, "patch file is pure ASCII");
});

// ---------------------------------------------------------------- bundle

test("plugin source exports name/inject/apply (typed import of src/dsh-plugin.ts)", async () => {
  const mod = await import("../src/dsh-plugin.ts");
  assert.equal(mod.name, "deepseek-vl", "exported plugin name");
  assert.deepEqual(mod.inject, ["tools"], "inject = ['tools']");
  assert.equal(typeof mod.apply, "function", "apply(ctx) registers the tools");
});

test("dist/dsh-plugin.js exists and loads as ESM with the same exports (shipped artifact)", () => {
  const file = join(ROOT, "dist", "dsh-plugin.js");
  assert.ok(existsSync(file), "dist/dsh-plugin.js built (git installs ship it)");
  // Spawn a clean node: the bundle is a runtime artifact without declarations,
  // and this proves the shipped file itself is valid, loadable ESM.
  const script =
    `const m = await import(process.argv[1]);` +
    `if (m.name !== "deepseek-vl" || m.inject[0] !== "tools" || typeof m.apply !== "function") process.exit(1);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(file).href], { stdio: "pipe" });
});

test("dsh-plugin bundle keeps @deepseek-ai/dsh-tools as a bare runtime import (closure-injected)", () => {
  const s = readFileSync(join(ROOT, "dist", "dsh-plugin.js"), "utf8");
  assert.match(s, /from "@deepseek-ai\/dsh-tools"/, "bare import preserved — not bundled");
  assert.ok(s.includes("ctx.tools.register"), "tools registered via ctx.tools.register");
});

// ---------------------------------------------------------------- shared tools.ts

test("callDescribeImage: missing path → isError; success → [Vision of …] text via mock endpoint", async () => {
  const missing = await callDescribeImage({});
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "describe_image: missing required parameter `path`.");

  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { project } = await makeEnv();
    // tools.ts resolves config from process.cwd() + os.homedir(); homedir()
    // caches its first result process-wide, so in-process tests must not rely
    // on a HOME override — env VISION_* wins over every config file instead.
    process.env.VISION_BASE_URL = mock.url;
    process.env.VISION_MODEL = "qwen2.5vl:7b";
    const shotPath = join(project, "shot.png");
    await writeFile(shotPath, makeFakePng());

    // Absolute path: callDescribeImage resolves relative paths against
    // process.cwd() (the repo root), which must not be polluted by the test.
    const res = await callDescribeImage({ path: shotPath, question: "What does the error say?" });
    assert.equal(res.isError, false);
    // Wording locked to the MCP server output: `[Vision of <path> (model: …)]:`.
    assert.ok(res.text.startsWith("[Vision of "), "starts with the shared [Vision of …] banner");
    assert.ok(res.text.includes("shot.png"), "carries the image path as given");
    assert.ok(res.text.includes("(model: qwen2.5vl:7b)]:"), "carries the model line");
    assert.ok(res.text.length > 20, "carries the description body");
    assert.equal(mock.requests.length, 1, "exactly one API request");
  } finally {
    await mock.close();
  }
});

test("callVisionStatus: reports config state and endpoint health", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    await makeEnv();
    process.env.VISION_BASE_URL = mock.url;
    process.env.VISION_MODEL = "qwen2.5vl:7b";
    const res = await callVisionStatus();
    assert.equal(res.isError, false, "status is informational, not an error");
    assert.ok(res.text.includes("[deepseek-vl-support] vision_status"), "status banner");
    assert.ok(res.text.includes("[OK]"), "endpoint reachable + model found");
  } finally {
    await mock.close();
  }
});

// registerDsh guidance copy is asserted in tests/skillagents.test.ts through
// the installSkillAgents path (native command preferred, no dsh-mcp-client
// hand-write, skill copy kept).
