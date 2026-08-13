// MCP server tests: spawn `node dist/cli.js mcp` and drive JSON-RPC 2.0
// (newline-delimited) over stdio — initialize, tools/list, tools/call
// (describe_image + vision_status), error codes, and notifications ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcess;
  private pending: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private stderrBuf = "";

  constructor(cwd: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [CLI_PATH, "mcp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (this.waiters.length) this.waiters.shift()!(line);
        else this.pending.push(line);
      }
    });
    this.child.stderr!.on("data", (d: string) => {
      this.stderrBuf += d;
    });
  }

  send(obj: unknown): void {
    this.child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  /** Write raw bytes to stdin (e.g. a deliberately malformed JSON line). */
  sendRaw(s: string): void {
    this.child.stdin!.write(s + "\n");
  }

  /** Next protocol message from the server (fails when none arrives). */
  async next(timeoutMs = 3000): Promise<JsonRpcResponse> {
    if (this.pending.length) return JSON.parse(this.pending.shift()!) as JsonRpcResponse;
    return new Promise((resolve, reject) => {
      const waiter = (line: string) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line) as JsonRpcResponse);
        } catch (e) {
          reject(e);
        }
      };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("no response within timeout"));
      }, timeoutMs);
    });
  }

  async request(method: string, params: Record<string, unknown> | undefined, id = 0): Promise<JsonRpcResponse> {
    this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return this.next();
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }
}

let tmp: { base: string; project: string; home: string } | null = null;
let client: McpClient | null = null;

async function setup(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-mcp-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { base, project, home };
  return { base, project, home };
}

/** Env without VISION_* interference, with an isolated USERPROFILE home. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("VISION_") && v !== undefined) env[k] = v;
  }
  env.USERPROFILE = home;
  env.HOME = home;
  return env;
}

function projectConfig(project: string, home: string, cfg: Record<string, unknown>): void {
  writeConfigFile(configPaths(project, home).projectFile, cfg as Parameters<typeof writeConfigFile>[1]);
}

test("built artifact exists — run `npm run build` first", () => {
  assert.ok(existsSync(CLI_PATH), `dist/cli.js missing — run npm run build first`);
});

test("initialize echoes client protocol version + serverInfo; tools/list exposes 2 tools", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    client = new McpClient(project, cleanEnv(home));
    try {
      const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }, 1);
      assert.equal(init.id, 1);
      assert.equal(init.error, undefined);
      const result = init.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
      assert.equal(result.protocolVersion, "2025-06-18");
      assert.ok(result.capabilities);
      assert.equal(result.serverInfo.name, "deepseek-vl-support");

      const list = await client.request("tools/list", undefined, 2);
      const tools = (list.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["describe_image", "vision_status"]);
      const desc = tools.find((t) => t.name === "describe_image")!;
      assert.deepEqual(desc.inputSchema.required, ["path"]);
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("describe_image returns the vision text and forwards the question", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    client = new McpClient(project, cleanEnv(home));
    try {
      const res = await client.request(
        "tools/call",
        { name: "describe_image", arguments: { path: "shot.png", question: "What does the error say?" } },
        3,
      );
      assert.equal(res.error, undefined);
      const r = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(r.isError, false);
      assert.match(r.content[0].text, /\[Vision of shot\.png/);
      assert.match(r.content[0].text, /mock 描述/);
      const body = mock.requests[0].body as { messages: Array<{ content: Array<{ text: string }> }> };
      assert.equal(body.messages[1].content[0].text, "What does the error say?");
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("describe_image caches: second call served from cache without an API request", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    writeFileSync(join(project, "shot.png"), makeFakePng());
    client = new McpClient(project, cleanEnv(home));
    try {
      const r1 = await client.request("tools/call", { name: "describe_image", arguments: { path: "shot.png" } }, 4);
      const r2 = await client.request("tools/call", { name: "describe_image", arguments: { path: "shot.png" } }, 5);
      const t1 = (r1.result as { content: Array<{ text: string }> }).content[0].text;
      const t2 = (r2.result as { content: Array<{ text: string }> }).content[0].text;
      assert.match(t1, /\(model: qwen2\.5vl:7b\)/);
      assert.match(t2, /\(cached 缓存\)/);
      assert.match(t1, /mock 描述/);
      assert.match(t2, /mock 描述/);
      assert.equal(mock.requests.length, 1, "cache hit must not call the API");
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("vision_status reports config + endpoint health", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    client = new McpClient(project, cleanEnv(home));
    try {
      const res = await client.request("tools/call", { name: "vision_status", arguments: {} }, 6);
      const r = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.equal(r.isError, false);
      assert.match(r.content[0].text, /model\s+: qwen2\.5vl:7b/);
      assert.match(r.content[0].text, /\[OK\]/);
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("describe_image without path → isError tool result", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    client = new McpClient(project, cleanEnv(home));
    try {
      const res = await client.request("tools/call", { name: "describe_image", arguments: {} }, 7);
      const r = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /missing required parameter `path`/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("JSON-RPC error codes: unknown tool / unknown method / parse error / invalid request", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    client = new McpClient(project, cleanEnv(home));
    try {
      const unknownTool = await client.request("tools/call", { name: "nope" }, 8);
      assert.equal(unknownTool.error?.code, -32602);
      assert.match(unknownTool.error?.message ?? "", /unknown tool/);

      const unknownMethod = await client.request("bogus/method", {}, 9);
      assert.equal(unknownMethod.error?.code, -32601);

      client.sendRaw("this is not json");
      const parseErr = await client.next();
      assert.equal(parseErr.error?.code, -32700);
      assert.equal(parseErr.id, null);

      client.send(JSON.stringify({ jsonrpc: "2.0", id: 10, params: {} }));
      const invalid = await client.next();
      assert.equal(invalid.error?.code, -32600);
    } finally {
      await client.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("notifications/initialized produces NO response; server stays alive", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await setup();
    projectConfig(project, home, { baseUrl: mock.url, model: "qwen2.5vl:7b" });
    const mc = new McpClient(project, cleanEnv(home));
    client = mc;
    try {
      mc.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      await assert.rejects(() => mc.next(400), /no response within timeout/);
      const pong = await mc.request("ping", undefined, 11);
      assert.deepEqual(pong.result, {});
    } finally {
      await mc.close();
      client = null;
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});
