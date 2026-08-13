// Hook contract tests: spawn the built dist/hook.cjs with stdin hook JSON and
// assert stdout carries exactly ONE JSON payload (no logging pollution),
// stderr carries logs, and the process always exits 0.
//
// Requires `npm run build` first (tests the bundled artifact, per design).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configPaths, writeConfigFile } from "../src/config.ts";
import { startMockVisionServer } from "./mock-vision-server.ts";
import type { MockVisionServer } from "./mock-vision-server.ts";
import { makeFakePng } from "./mock-vision-server.ts";

const HOOK_PATH = fileURLToPath(new URL("../dist/hook.cjs", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runHook(
  args: string[],
  opts: { input: unknown; cwd: string; env: Record<string, string> },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: out, stderr: err, code: code ?? -1 }));
    child.stdin.end(JSON.stringify(opts.input));
  });
}

/** Env without VISION_* interference, with an isolated USERPROFILE home. */
function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("VISION_") && v !== undefined) env[k] = v;
  }
  env.USERPROFILE = home;
  env.HOME = home;
  return { ...env, ...extra };
}

const READ_EVENT = (cwd: string, filePath: string): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: filePath },
  cwd,
});

let tmp: { base: string; project: string; home: string } | null = null;

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-hook-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { base, project, home };
  return { base, project, home };
}

test.afterEach(async () => {
  if (tmp) {
    await rm(tmp.base, { recursive: true, force: true });
    tmp = null;
  }
});

function projectConfig(project: string, home: string, cfg: Record<string, unknown>): void {
  writeConfigFile(configPaths(project, home).projectFile, cfg as Parameters<typeof writeConfigFile>[1]);
}

test("built artifact exists — run `npm run build` first", () => {
  assert.ok(existsSync(HOOK_PATH), `dist/hook.cjs missing — run npm run build first`);
});

test("non-image file → {} and exit 0", async () => {
  const { base, project, home } = await makeEnv();
  writeFileSync(join(project, "notes.txt"), "plain text", "utf8");
  try {
    const r = await runHook([], { input: READ_EVENT(project, "notes.txt"), cwd: project, env: cleanEnv(home) });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Grep tool / missing file_path → {}", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const r1 = await runHook([], {
      input: { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, cwd: project },
      cwd: project,
      env: cleanEnv(home),
    });
    assert.deepEqual(JSON.parse(r1.stdout.trim()), {});
    const r2 = await runHook([], { input: { hook_event_name: "PreToolUse", tool_name: "Read" }, cwd: project, env: cleanEnv(home) });
    assert.deepEqual(JSON.parse(r2.stdout.trim()), {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("image + healthy mock endpoint → block with additionalContext, single stdout line", async () => {
  const mock = await startMockVisionServer();
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "vision-model" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    try {
      const r = await runHook([], { input: READ_EVENT(project, "shot.png"), cwd: project, env: cleanEnv(home) });
      assert.equal(r.code, 0);
      const lines = r.stdout.trim().split("\n");
      assert.equal(lines.length, 1, "stdout must carry exactly one JSON line");
      const out = JSON.parse(lines[0]) as {
        decision: string;
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(out.decision, "block");
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.match(out.hookSpecificOutput.additionalContext, /\[Vision of shot\.png\]:/);
      assert.match(out.hookSpecificOutput.additionalContext, /mock 描述/);
      assert.equal(mock.requests.length, 1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("cache: second Read of same image hits cache (no second API call)", async () => {
  const mock = await startMockVisionServer();
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "vision-model" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    try {
      const r1 = await runHook([], { input: READ_EVENT(project, "shot.png"), cwd: project, env: cleanEnv(home) });
      const r2 = await runHook([], { input: READ_EVENT(project, "shot.png"), cwd: project, env: cleanEnv(home) });
      assert.equal(r1.code, 0);
      assert.equal(r2.code, 0);
      const a1 = JSON.parse(r1.stdout.trim()) as { hookSpecificOutput: { additionalContext: string } };
      const a2 = JSON.parse(r2.stdout.trim()) as { hookSpecificOutput: { additionalContext: string } };
      assert.equal(a2.hookSpecificOutput.additionalContext, a1.hookSpecificOutput.additionalContext);
      assert.equal(mock.requests.length, 1, "second Read must be served from cache");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("VISION_DISABLE=1 → {} + stderr hint, exit 0", async () => {
  const mock = await startMockVisionServer();
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "vision-model" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    try {
      const r = await runHook([], {
        input: READ_EVENT(project, "shot.png"),
        cwd: project,
        env: cleanEnv(home, { VISION_DISABLE: "1" }),
      });
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout.trim()), {});
      assert.match(r.stderr, /disabled|跳过/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("unreachable endpoint → {} + stderr failure, Read proceeds, exit 0", async () => {
  const { base, project, home } = await makeEnv();
  projectConfig(project, home, { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model" });
  writeFileSync(join(project, "shot.png"), makeFakePng());
  try {
    const r = await runHook([], { input: READ_EVENT(project, "shot.png"), cwd: project, env: cleanEnv(home) });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {}, "failure must not block the Read tool");
    assert.match(r.stderr, /vision failed/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("oversized image → {} + stderr, no API call", async () => {
  const mock = await startMockVisionServer();
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "vision-model", maxBytes: 100 });
    writeFileSync(join(project, "big.png"), makeFakePng(2048));
    try {
      const r = await runHook([], { input: READ_EVENT(project, "big.png"), cwd: project, env: cleanEnv(home) });
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout.trim()), {});
      assert.match(r.stderr, /maxBytes|过大/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("garbage stdin → {}, exit 0", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const r = await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK_PATH], { cwd: project, env: cleanEnv(home) });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: out, stderr: err, code: code ?? -1 }));
      child.stdin.end("{not json at all");
    });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook-start healthy → {}", async () => {
  const mock = await startMockVisionServer({ models: ["vision-model"] });
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "vision-model" });
    try {
      const r = await runHook(["start"], {
        input: { hook_event_name: "SessionStart", cwd: project },
        cwd: project,
        env: cleanEnv(home),
      });
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout.trim()), {});
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("hook-start unreachable → SessionStart warning, exit 0", async () => {
  const { base, project, home } = await makeEnv();
  projectConfig(project, home, { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model" });
  try {
    const r = await runHook(["start"], {
      input: { hook_event_name: "SessionStart", cwd: project },
      cwd: project,
      env: cleanEnv(home),
    });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout.trim()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /unreachable|not configured correctly/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
