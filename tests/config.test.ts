// Config resolution chain: defaults < global file < project file < env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULTS,
  configPaths,
  effectiveFallback,
  parseFallbacks,
  resolveConfig,
  writeConfigFile,
} from "../src/config.ts";

async function makeDirs(): Promise<{ project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-cfg-"));
  const project = join(base, "project");
  const home = join(base, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  return { project, home };
}

test("defaults when nothing is configured", async () => {
  const { project, home } = await makeDirs();
  const cfg = resolveConfig(project, home, {});
  assert.equal(cfg.baseUrl, DEFAULT_BASE_URL);
  assert.equal(cfg.model, "");
  assert.equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(cfg.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.fallbacks, []);
});

test("global file applies, project file overrides per-field", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  writeConfigFile(gp.globalFile, { baseUrl: "http://global:8080/v1", model: "global-model", timeoutMs: 5000 });
  writeConfigFile(gp.projectFile, { baseUrl: "http://project:9000/v1", maxBytes: 999 });

  const cfg = resolveConfig(project, home, {});
  assert.equal(cfg.baseUrl, "http://project:9000/v1"); // project wins for baseUrl
  assert.equal(cfg.model, "global-model"); // global still applies
  assert.equal(cfg.timeoutMs, 5000); // global applies
  assert.equal(cfg.maxBytes, 999); // project applies
  assert.equal(cfg.enabled, true);
});

test("env wins over files (per-field)", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  writeConfigFile(gp.globalFile, { baseUrl: "http://global:1/v1", model: "file-model", timeoutMs: 1111 });

  const cfg = resolveConfig(project, home, {
    VISION_BASE_URL: "http://env:2/v1",
    VISION_MODEL: "env-model",
    VISION_TIMEOUT_MS: "2222",
  });
  assert.equal(cfg.baseUrl, "http://env:2/v1");
  assert.equal(cfg.model, "env-model");
  assert.equal(cfg.timeoutMs, 2222);
  assert.equal(cfg.apiKey, "");

  const cfg2 = resolveConfig(project, home, {
    VISION_API_KEY: "sk-env",
    VISION_DISABLE: "1",
  });
  assert.equal(cfg2.apiKey, "sk-env");
  assert.equal(cfg2.enabled, false);
});

test("trailing slashes are stripped", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  writeConfigFile(gp.globalFile, { baseUrl: "http://x/v1///" });
  assert.equal(resolveConfig(project, home, {}).baseUrl, "http://x/v1");
  assert.equal(resolveConfig(project, home, { VISION_BASE_URL: "http://y///" }).baseUrl, "http://y");
});

test("invalid numbers fall back to defaults", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  writeConfigFile(gp.globalFile, { timeoutMs: -5 as never, maxBytes: "abc" as never });
  const cfg = resolveConfig(project, home, {});
  assert.equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(cfg.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(resolveConfig(project, home, { VISION_MAX_BYTES: "NaN" }).maxBytes, DEFAULT_MAX_BYTES);
});

test("fallbacks parse from JSON and comma syntax, env overrides file", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  writeConfigFile(gp.globalFile, { fallbacks: [{ model: "a" }, { model: "b", baseUrl: "http://b/v1" }] });
  let cfg = resolveConfig(project, home, {});
  assert.equal(cfg.fallbacks.length, 2);
  assert.deepEqual(cfg.fallbacks[1], { model: "b", baseUrl: "http://b/v1" });

  cfg = resolveConfig(project, home, {
    VISION_FALLBACKS: JSON.stringify([{ model: "e1" }, { model: "e2", baseUrl: "http://e2/v1", apiKey: "k2" }]),
  });
  assert.deepEqual(cfg.fallbacks, [
    { model: "e1" },
    { model: "e2", baseUrl: "http://e2/v1", apiKey: "k2" },
  ]);

  assert.deepEqual(parseFallbacks("m1@http://a/v1, m2"), [
    { model: "m1", baseUrl: "http://a/v1" },
    { model: "m2" },
  ]);
  assert.deepEqual(parseFallbacks(""), []);
  assert.deepEqual(parseFallbacks("not json at all"), [{ model: "not json at all" }]);
});

test("enabled:false in file disables; writeConfigFile deep-merges and omits defaults", async () => {
  const { project, home } = await makeDirs();
  const gp = configPaths(project, home);
  const merged = writeConfigFile(gp.globalFile, { model: "first", enabled: true });
  assert.equal(merged.model, "first");
  const merged2 = writeConfigFile(gp.globalFile, { model: "second", apiKey: "k" });
  assert.equal(merged2.model, "second");
  assert.equal(merged2.apiKey, "k");

  const cfg = resolveConfig(project, home, {});
  assert.equal(cfg.model, "second");
  assert.equal(cfg.apiKey, "k");

  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(gp.globalFile, "utf8"));
  assert.ok(!("enabled" in raw), "default true should be omitted on write");
  assert.ok(!("timeoutMs" in raw), "default timeout should be omitted on write");

  writeConfigFile(gp.globalFile, { enabled: false });
  assert.equal(resolveConfig(project, home, {}).enabled, false);
});

test("effectiveFallback inherits from primary", () => {
  const primary = { ...DEFAULTS, baseUrl: "http://p/v1", model: "pm", apiKey: "pk" };
  assert.deepEqual(effectiveFallback({ model: "fm" }, primary), {
    model: "fm",
    baseUrl: "http://p/v1",
    apiKey: "pk",
  });
  assert.deepEqual(
    effectiveFallback({ model: "fm2", baseUrl: "http://f/v1/", apiKey: "" }, primary),
    { model: "fm2", baseUrl: "http://f/v1", apiKey: "" },
  );
});

test("cleanup", async () => {
  const { project, home } = await makeDirs();
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
