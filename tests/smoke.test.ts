// CLI smoke tests: spawn the built dist/cli.js and exercise describe / doctor /
// config / version against the mock vision server — payloads, exit codes.
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

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(cwd: string, home: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("VISION_") && v !== undefined) env[k] = v;
    }
    env.USERPROFILE = home;
    env.HOME = home;
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: out, stderr: err, code: code ?? -1 }));
  });
}

let tmp: { base: string; project: string; home: string } | null = null;

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-smoke-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { base, project, home };
  return { base, project, home };
}

function projectConfig(project: string, home: string, cfg: Record<string, unknown>): void {
  writeConfigFile(configPaths(project, home).projectFile, cfg as Parameters<typeof writeConfigFile>[1]);
}

test("built artifact exists — run `npm run build` first", () => {
  assert.ok(existsSync(CLI_PATH), `dist/cli.js missing — run npm run build first`);
});

test("version prints and exits 0", async () => {
  const { base, project, home } = await makeEnv();
  try {
    const r = await runCli(project, home, ["version"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^deepseek-vl-support v\d+\.\d+\.\d+/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("describe prints the vision text; --json emits structured output", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    try {
      const plain = await runCli(project, home, ["describe", "shot.png"]);
      assert.equal(plain.code, 0);
      assert.match(plain.stdout, /mock 描述/);

      // fresh file → no cache hit → question must reach the API
      writeFileSync(join(project, "shot2.png"), makeFakePng());
      const withQ = await runCli(project, home, ["describe", "shot2.png", "What", "color?"]);
      assert.equal(withQ.code, 0, `stderr: ${withQ.stderr}`);
      const body = mock.requests[mock.requests.length - 1].body as { messages: Array<{ content: Array<{ text: string }> }> };
      assert.equal(body.messages[1].content[0].text, "What color?");

      const j = await runCli(project, home, ["describe", "--json", "shot.png"]);
      assert.equal(j.code, 0);
      const parsed = JSON.parse(j.stdout) as { text: string; model: string; fromFallback: boolean };
      assert.equal(parsed.model, "qwen2.5vl:7b");
      assert.equal(parsed.fromFallback, false);
      assert.match(parsed.text, /mock 描述/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("describe failures: missing file / no args → exit 1 with stderr", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    try {
      const missing = await runCli(project, home, ["describe", "missing.png"]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /cannot read file|ENOENT/);

      const noArgs = await runCli(project, home, ["describe"]);
      assert.equal(noArgs.code, 1);
      assert.match(noArgs.stderr, /requires an image file/);

      const unknown = await runCli(project, home, ["bogus"]);
      assert.equal(unknown.code, 1);
      assert.match(unknown.stderr, /unknown command/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("doctor: exit 0 with healthy endpoint, exit 1 when unreachable", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    try {
      const ok = await runCli(project, home, ["doctor"]);
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /\[OK\].*qwen2\.5vl:7b/);

      const j = await runCli(project, home, ["doctor", "--json"]);
      assert.equal(j.code, 0);
      const report = JSON.parse(j.stdout) as { ok: boolean; primaryOk: boolean; modelPresent: boolean };
      assert.equal(report.ok, true);
      assert.equal(report.primaryOk, true);
      assert.equal(report.modelPresent, true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
  {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: "http://127.0.0.1:1/v1", model: "qwen2.5vl:7b" });
    try {
      const bad = await runCli(project, home, ["doctor"]);
      assert.equal(bad.code, 1, "doctor must exit 1 on unreachable endpoint");
      assert.match(bad.stdout, /unreachable|不可达/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});

test("config: get/set round-trip, path listing, invalid values rejected", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    try {
      const get = await runCli(project, home, ["config", "get", "model"]);
      assert.equal(get.code, 0);
      assert.equal(get.stdout.trim(), "qwen2.5vl:7b");

      const full = await runCli(project, home, ["config", "get"]);
      assert.equal(full.code, 0);
      assert.match(full.stdout, /baseUrl\s+: /);

      const paths = await runCli(project, home, ["config", "path"]);
      assert.equal(paths.code, 0);
      assert.ok(paths.stdout.includes(join(project, ".deepseek-vl", "config.json")));

      const set = await runCli(project, home, ["config", "set", "timeoutMs", "3000"]);
      assert.equal(set.code, 0);
      const back = await runCli(project, home, ["config", "get", "timeoutMs"]);
      assert.equal(back.stdout.trim(), "3000");

      const badNum = await runCli(project, home, ["config", "set", "timeoutMs", "abc"]);
      assert.equal(badNum.code, 1);
      assert.match(badNum.stderr, /positive number/);

      const badKey = await runCli(project, home, ["config", "set", "bogus", "x"]);
      assert.equal(badKey.code, 1);
      assert.match(badKey.stderr, /unknown config key/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("non-interactive install + uninstall via the CLI surface", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const ins = await runCli(project, home, [
        "install", "--non-interactive", "--target", "claude",
        "--base-url", mock.url, "--model", "qwen2.5vl:7b",
      ]);
      assert.equal(ins.code, 0, `install exit 0, stderr: ${ins.stderr}`);
      assert.ok(existsSync(join(project, ".claude", "hooks", "deepseek-vision-hook.cjs")));
      assert.ok(existsSync(join(project, ".deepseek-vl", "config.json")));

      const un = await runCli(project, home, ["uninstall", "--target", "claude"]);
      assert.equal(un.code, 0);
      assert.ok(!existsSync(join(project, ".claude", "hooks", "deepseek-vision-hook.cjs")));
      assert.ok(existsSync(join(project, ".deepseek-vl", "config.json")), "config kept by default");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});
