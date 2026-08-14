// Vision client tests against a mock HTTP server:
// success / fallback / chain-all-fail / size guard / empty content / timeout /
// soft warning / listModels / cache integration.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, listModels, VisionSizeError } from "../src/client.ts";
import { configPaths, writeConfigFile } from "../src/config.ts";
import type { FallbackConfig } from "../src/config.ts";
import { makeFakePng, startMockVisionServer } from "./mock-vision-server.ts";
import type { MockVisionServer } from "./mock-vision-server.ts";

let tmp: { project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function setup(overrides: Record<string, unknown> = {}): Promise<{ project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-client-"));
  const project = join(base, "project");
  const home = join(base, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const gp = configPaths(project, home);
  writeConfigFile(gp.projectFile, {
    baseUrl: (overrides.baseUrl as string | undefined) ?? "http://localhost:11434/v1",
    model: (overrides.model as string | undefined) ?? "vision-model",
    apiKey: (overrides.apiKey as string | undefined) ?? "",
    timeoutMs: (overrides.timeoutMs as number | undefined) ?? 5000,
    maxBytes: (overrides.maxBytes as number | undefined) ?? 10 * 1024 * 1024,
    fallbacks: (overrides.fallbacks as FallbackConfig[] | undefined) ?? [],
  });
  tmp = { project, home };
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

test("success: posts data URI with correct payload, returns text", async () => {
  const mock = await startMockVisionServer();
  try {
    const { project, home } = await setup({ baseUrl: mock.url });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());

    const res = await describe(img, { cwd: project, home });
    assert.match(res.text, /mock description/);
    assert.equal(res.fromFallback, false);

    const req = mock.requests[0];
    assert.equal(req.path, "/v1/chat/completions");
    const body = req.body as { model: string; messages: Array<{ role: string; content: unknown }> };
    assert.equal(body.model, "vision-model");
    const sys = body.messages[0];
    assert.equal(sys.role, "system");
    assert.match(String(sys.content), /vision specialist/);
    const user = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    assert.equal(user[0].type, "text");
    assert.match(String(user[0].text), /Describe this image/);
    assert.match(user[1].image_url?.url ?? "", /^data:image\/png;base64,/);
  } finally {
    await mock.close();
  }
});

test("question is forwarded as the text part", async () => {
  const mock = await startMockVisionServer();
  try {
    const { project, home } = await setup({ baseUrl: mock.url });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());
    await describe(img, { cwd: project, home, question: "What color is the button?" });
    const body = mock.requests[0].body as { messages: Array<{ content: Array<{ text: string }> }> };
    assert.equal(body.messages[1].content[0].text, "What color is the button?");
  } finally {
    await mock.close();
  }
});

test("fallback: primary 500 → fallback succeeds", async () => {
  let calls = 0;
  const mock = await startMockVisionServer({
    chat: () => {
      calls++;
      if (calls === 1) return { status: 500 };
      return { content: "fallback description" };
    },
  });
  try {
    const { project, home } = await setup({
      baseUrl: mock.url,
      fallbacks: [{ model: "backup-model" }],
    });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());

    const res = await describe(img, { cwd: project, home });
    assert.equal(res.text, "fallback description");
    assert.equal(res.fromFallback, true);
    assert.equal(res.model, "backup-model");
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("chain all fail: error contains full chain summary", async () => {
  const mock = await startMockVisionServer({ chat: () => ({ status: 503 }) });
  try {
    const { project, home } = await setup({
      baseUrl: mock.url,
      fallbacks: [{ model: "fb1" }, { model: "fb2", baseUrl: "http://127.0.0.1:1/v1" }],
    });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());

    await assert.rejects(
      () => describe(img, { cwd: project, home, budgetMs: 3000 }),
      (e: unknown) => {
        const msg = (e as Error).message;
        assert.match(msg, /vision failed on all/);
        assert.match(msg, /vision-model/);
        assert.match(msg, /HTTP 503/);
        assert.match(msg, /fb1/);
        assert.match(msg, /fb2/);
        return true;
      },
    );
    assert.ok(mock.requests.length >= 1);
  } finally {
    await mock.close();
  }
});

test("size guard: oversized file → VisionSizeError, zero requests", async () => {
  const mock = await startMockVisionServer();
  try {
    const { project, home } = await setup({ baseUrl: mock.url, maxBytes: 100 });
    const img = join(project, "big.png");
    await writeFile(img, makeFakePng(2048));

    await assert.rejects(
      () => describe(img, { cwd: project, home }),
      (e: unknown) => {
        assert.ok(e instanceof VisionSizeError);
        assert.match((e as Error).message, /compress/i);
        assert.equal((e as VisionSizeError).fileSize, 2048);
        assert.equal((e as VisionSizeError).maxBytes, 100);
        return true;
      },
    );
    assert.equal(mock.requests.length, 0, "no request must be sent for oversized image");
  } finally {
    await mock.close();
  }
});

test("empty content → explicit error (non-vision model hint)", async () => {
  const mock = await startMockVisionServer({ chat: () => ({ content: null }) });
  try {
    const { project, home } = await setup({ baseUrl: mock.url });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());
    await assert.rejects(() => describe(img, { cwd: project, home }), /empty response/);
  } finally {
    await mock.close();
  }
});

test("timeout aborts with clear message and does not hang", async () => {
  const mock = await startMockVisionServer({ delayMs: 500 });
  try {
    const { project, home } = await setup({ baseUrl: mock.url, timeoutMs: 150 });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());
    await assert.rejects(() => describe(img, { cwd: project, home }), /timeout after 150ms/);
  } finally {
    await mock.close();
  }
});

test(">2MB file emits soft warning but still succeeds", async () => {
  const mock = await startMockVisionServer();
  try {
    const { project, home } = await setup({ baseUrl: mock.url });
    const img = join(project, "large.png");
    await writeFile(img, makeFakePng(2 * 1024 * 1024 + 17)); // >2MB, <10MB
    const warnings: string[] = [];
    const res = await describe(img, { cwd: project, home, warn: (m) => warnings.push(m) });
    assert.equal(res.fromCache, undefined);
    assert.ok(warnings.some((w) => w.includes("2MB")), `expected soft warning, got: ${warnings.join("|")}`);
  } finally {
    await mock.close();
  }
});

test("non-image file / missing file → clear errors", async () => {
  const { project, home } = await setup();
  await assert.rejects(() => describe(join(project, "notes.txt"), { cwd: project, home }), /not an image/);
  await assert.rejects(() => describe(join(project, "missing.png"), { cwd: project, home }), /cannot read file/);
});

test("cache integration: second call hits cache (single API request), file change misses", async () => {
  const mock = await startMockVisionServer();
  try {
    const { project, home } = await setup({ baseUrl: mock.url });
    const img = join(project, "shot.png");
    await writeFile(img, makeFakePng());

    const r1 = await describe(img, { cwd: project, home });
    assert.equal(r1.fromCache, undefined);
    const r2 = await describe(img, { cwd: project, home });
    assert.equal(r2.fromCache, true);
    assert.equal(r2.text, r1.text);
    assert.equal(mock.requests.length, 1, "cache hit must not call the API");

    await writeFile(img, makeFakePng()); // same size, different content
    const r3 = await describe(img, { cwd: project, home });
    assert.equal(r3.fromCache, undefined);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("listModels: ok / 404→null / unreachable throws", async () => {
  const mock = await startMockVisionServer({ models: ["m1", "m2"] });
  try {
    assert.deepEqual(await listModels(mock.url, ""), ["m1", "m2"]);
  } finally {
    await mock.close();
  }
  const mock404 = await startMockVisionServer({ modelsStatus: 404 });
  try {
    assert.equal(await listModels(mock404.url, ""), null);
  } finally {
    await mock404.close();
  }
  const dead = await startMockVisionServer();
  const deadUrl = dead.url;
  await dead.close();
  await assert.rejects(() => listModels(deadUrl, ""), /unreachable/);
});
