// src/dsh-plugin.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/tools.ts
import { homedir as homedir4 } from "node:os";
import { resolve as resolve2 } from "node:path";

// src/client.ts
import { open, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { basename as basename2, resolve } from "node:path";

// src/cache.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/identity.ts
var CONFIG_DIR = ".deepseek-vl";
var CONFIG_FILENAME = "config.json";
var CACHE_DIR = "cache";

// src/config.ts
var DEFAULT_BASE_URL = "http://localhost:11434/v1";
var DEFAULT_TIMEOUT_MS = 12e4;
var DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: "",
  apiKey: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBytes: DEFAULT_MAX_BYTES,
  enabled: true,
  fallbacks: []
};
function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}
function globalConfigDir(home = homedir()) {
  return join(home, CONFIG_DIR);
}
function configPaths(cwd, home = homedir()) {
  const projectDir = join(cwd, CONFIG_DIR);
  const globalDir = globalConfigDir(home);
  return {
    projectDir,
    globalDir,
    projectFile: join(projectDir, CONFIG_FILENAME),
    globalFile: join(globalDir, CONFIG_FILENAME),
    projectCacheDir: join(projectDir, CACHE_DIR),
    globalCacheDir: join(globalDir, CACHE_DIR)
  };
}
function parseFallbacks(raw) {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean).map((part) => {
        const at = part.lastIndexOf("@");
        if (at > 0) {
          return { model: part.slice(0, at).trim(), baseUrl: part.slice(at + 1).trim() };
        }
        return { model: part };
      });
    }
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ model: t });
    } else if (item && typeof item === "object") {
      const o = item;
      if (typeof o.model === "string" && o.model.trim()) {
        const entry = { model: o.model.trim() };
        if (typeof o.baseUrl === "string" && o.baseUrl.trim()) entry.baseUrl = o.baseUrl.trim();
        if (typeof o.apiKey === "string") entry.apiKey = o.apiKey;
        out.push(entry);
      }
    }
  }
  return out;
}
function normNumber(v, fallback) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}
function normBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(t)) return true;
    if (["0", "false", "no", "off"].includes(t)) return false;
  }
  return void 0;
}
function loadConfigFile(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw;
  const out = {};
  if (typeof o.baseUrl === "string" && o.baseUrl.trim()) out.baseUrl = stripTrailingSlash(o.baseUrl);
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  if (typeof o.apiKey === "string") out.apiKey = o.apiKey;
  if (o.timeoutMs !== void 0) out.timeoutMs = normNumber(o.timeoutMs, DEFAULTS.timeoutMs);
  if (o.maxBytes !== void 0) out.maxBytes = normNumber(o.maxBytes, DEFAULTS.maxBytes);
  const enabled = normBool(o.enabled);
  if (enabled !== void 0) out.enabled = enabled;
  if (o.fallbacks !== void 0) out.fallbacks = parseFallbacks(o.fallbacks);
  return out;
}
function envBool(value) {
  return normBool(value);
}
function resolveConfig(cwd = process.cwd(), home = homedir(), env = process.env) {
  const paths = configPaths(cwd, home);
  const cfg = { ...DEFAULTS, fallbacks: [...DEFAULTS.fallbacks] };
  const apply2 = (patch) => {
    if (!patch) return;
    if (patch.baseUrl !== void 0) cfg.baseUrl = patch.baseUrl;
    if (patch.model !== void 0) cfg.model = patch.model;
    if (patch.apiKey !== void 0) cfg.apiKey = patch.apiKey;
    if (patch.timeoutMs !== void 0) cfg.timeoutMs = patch.timeoutMs;
    if (patch.maxBytes !== void 0) cfg.maxBytes = patch.maxBytes;
    if (patch.enabled !== void 0) cfg.enabled = patch.enabled;
    if (patch.fallbacks !== void 0) cfg.fallbacks = patch.fallbacks.map((f) => ({ ...f }));
  };
  apply2(loadConfigFile(paths.globalFile));
  apply2(loadConfigFile(paths.projectFile));
  if (env.VISION_BASE_URL !== void 0 && env.VISION_BASE_URL.trim()) cfg.baseUrl = stripTrailingSlash(env.VISION_BASE_URL);
  if (env.VISION_MODEL !== void 0 && env.VISION_MODEL.trim()) cfg.model = env.VISION_MODEL.trim();
  if (env.VISION_API_KEY !== void 0) cfg.apiKey = env.VISION_API_KEY;
  if (env.VISION_TIMEOUT_MS !== void 0) cfg.timeoutMs = normNumber(env.VISION_TIMEOUT_MS, DEFAULTS.timeoutMs);
  if (env.VISION_MAX_BYTES !== void 0) cfg.maxBytes = normNumber(env.VISION_MAX_BYTES, DEFAULTS.maxBytes);
  if (env.VISION_FALLBACKS !== void 0) cfg.fallbacks = parseFallbacks(env.VISION_FALLBACKS);
  const disable = envBool(env.VISION_DISABLE);
  if (disable !== void 0) cfg.enabled = !disable;
  cfg.baseUrl = stripTrailingSlash(cfg.baseUrl);
  return cfg;
}
function effectiveFallback(fb, primary) {
  return {
    model: fb.model || primary.model,
    baseUrl: fb.baseUrl ? stripTrailingSlash(fb.baseUrl) : primary.baseUrl,
    apiKey: fb.apiKey !== void 0 ? fb.apiKey : primary.apiKey
  };
}
function maskApiKey(key) {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function humanBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// src/cache.ts
var CACHE_MAX_BYTES = 64 * 1024 * 1024;
function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function cacheDirFor(cwd, home = homedir2()) {
  if (existsSync2(join2(cwd, CONFIG_DIR, "config.json"))) return join2(cwd, CONFIG_DIR, CACHE_DIR);
  return join2(home, CONFIG_DIR, CACHE_DIR);
}
var DescriptionCache = class {
  dir;
  maxBytes;
  constructor(dir, maxBytes = CACHE_MAX_BYTES) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }
  recordPath(sha) {
    return join2(this.dir, `${sha}.json`);
  }
  async get(filePath, st, buffer, model) {
    const sha = sha256Of(buffer);
    const file = this.recordPath(sha);
    if (!existsSync2(file)) return null;
    let rec;
    try {
      rec = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
    if (typeof rec?.text !== "string" || rec.model !== model || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs || rec.path !== filePath) {
      return null;
    }
    return rec.text;
  }
  async set(filePath, st, buffer, model, text) {
    const sha = sha256Of(buffer);
    const rec = {
      key: sha,
      path: filePath,
      model,
      mtimeMs: st.mtimeMs,
      size: st.size,
      text
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.recordPath(sha), JSON.stringify(rec, null, 2) + "\n", "utf8");
    await this.prune();
  }
  /** Total cache size above maxBytes: evict oldest (by mtime) first. */
  async prune() {
    let entries;
    try {
      const names = await readdir(this.dir);
      const withStats = await Promise.all(
        names.filter((n) => n.endsWith(".json")).map(async (n) => {
          const p = join2(this.dir, n);
          const s = await stat(p).catch(() => null);
          return s ? { file: p, mtimeMs: s.mtimeMs, size: s.size } : null;
        })
      );
      entries = withStats.filter((e) => e !== null);
    } catch {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      await unlink(e.file).catch(() => {
      });
      total -= e.size;
    }
  }
  /** Remove the whole cache directory (used by `uninstall --purge-config`). */
  async clear() {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {
    });
  }
};

// src/detect.ts
import { basename } from "node:path";
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
function hasImageExtension(filePath) {
  const name2 = basename(filePath);
  const dot = name2.lastIndexOf(".");
  if (dot < 0 || dot === name2.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name2.slice(dot + 1).toLowerCase());
}
function eq(buf, off, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (buf[off + i] !== bytes[i]) return false;
  }
  return true;
}
function ascii(buf, off, s) {
  for (let i = 0; i < s.length; i++) {
    if (buf[off + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}
function sniffImageKind(buf) {
  if (buf.length >= 8 && eq(buf, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "png";
  if (buf.length >= 3 && eq(buf, 0, [255, 216, 255])) return "jpg";
  if (buf.length >= 4 && ascii(buf, 0, "GIF8")) return "gif";
  if (buf.length >= 12 && ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return "webp";
  if (buf.length >= 2 && ascii(buf, 0, "BM")) return "bmp";
  return null;
}
var MIME_BY_KIND = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
};
function mimeForKind(kind) {
  return MIME_BY_KIND[kind];
}
function mimeForPath(filePath) {
  const name2 = basename(filePath).toLowerCase();
  for (const kind of Object.keys(MIME_BY_KIND)) {
    if (name2.endsWith(`.${kind}`) || kind === "jpg" && name2.endsWith(".jpeg")) return MIME_BY_KIND[kind];
  }
  return "application/octet-stream";
}

// src/prompt.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";

// src/paths.ts
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
function packageRoot() {
  const metaUrl = import.meta.url;
  if (typeof metaUrl === "string" && metaUrl) {
    return join3(dirname2(fileURLToPath(metaUrl)), "..");
  }
  return "";
}
function assetsDir() {
  return join3(packageRoot(), "assets");
}
function packagedPromptPath() {
  return join3(assetsDir(), "vision-prompt.md");
}

// src/prompt.ts
var DEFAULT_PROMPT = "You are a vision specialist. Describe images exhaustively: all visible text verbatim, UI layout, colors, code, error messages, icons. Be precise and structured. If asked a specific question, answer it first, then add detail.";
function stripFrontmatter(text) {
  const trimmed = text.replace(/^﻿/, "");
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end >= 0) return trimmed.slice(end + 4);
    return trimmed.slice(3);
  }
  return trimmed;
}
function readPromptFile(file) {
  if (!existsSync3(file)) return void 0;
  try {
    const body = stripFrontmatter(readFileSync2(file, "utf8"));
    if (body.trim()) return body.trim();
  } catch {
    return void 0;
  }
  return void 0;
}
function resolveSystemPrompt(cwd = process.cwd(), home = homedir3()) {
  const project = join4(cwd, CONFIG_DIR, "vision-prompt.md");
  const global = join4(globalConfigDir(home), "vision-prompt.md");
  return readPromptFile(project) ?? readPromptFile(global) ?? readPromptFile(packagedPromptPath()) ?? DEFAULT_PROMPT;
}

// src/client.ts
var VisionSizeError = class extends Error {
  fileSize;
  maxBytes;
  constructor(fileSize, maxBytes) {
    super(
      `image too large: ${fileSize} bytes exceeds maxBytes=${maxBytes}. Compress or crop it first (e.g. under 5 MB, ~2000px on the long edge).`
    );
    this.name = "VisionSizeError";
    this.fileSize = fileSize;
    this.maxBytes = maxBytes;
  }
};
var SOFT_WARN_BYTES = 2 * 1024 * 1024;
async function readHead(filePath, n) {
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {
    });
  }
}
async function postChat(baseUrl, apiKey, model, systemPrompt, question, dataUri, timeoutMs) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: dataUri } }
            ]
          }
        ]
      })
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`timeout after ${timeoutMs}ms`);
    throw new Error(`network error: ${msg}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  let out;
  try {
    out = await res.json();
  } catch {
    throw new Error("invalid JSON response from vision endpoint");
  }
  const text = out?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("empty response - does the model support images?");
  }
  return text.trim();
}
function assertVisionReady(cfg) {
  if (!cfg.enabled) throw new Error("vision disabled (VISION_DISABLE=1 or enabled:false)");
  if (!cfg.model) {
    throw new Error(`VISION_MODEL is not set (server: ${cfg.baseUrl}) - e.g. export VISION_MODEL=qwen2.5vl:7b`);
  }
}
async function runDescribe(pathKey, st, buffer, dataUri, displayName, cfg, opts) {
  if (st.size > SOFT_WARN_BYTES) {
    const warn = opts.warn ?? ((m) => process.stderr.write(m + "\n"));
    warn(
      `[deepseek-vl-support] ${displayName} is ${st.size} bytes (>2MB): remote vision API may be slow and costly.`
    );
  }
  const cache = new DescriptionCache(cacheDirFor(opts.cwd ?? process.cwd(), opts.home));
  const cached = await cache.get(pathKey, st, buffer, cfg.model);
  if (cached) {
    return {
      text: cached,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      fromFallback: false,
      fromCache: true
    };
  }
  const totalBudget = Math.max(1e3, opts.budgetMs ?? cfg.timeoutMs);
  const started = Date.now();
  const attempts = [];
  attempts.push({ model: cfg.model, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, label: "primary" });
  for (const fb of cfg.fallbacks) {
    const eff = effectiveFallback(fb, cfg);
    if (eff.model && eff.baseUrl) {
      attempts.push({ model: eff.model, baseUrl: eff.baseUrl, apiKey: eff.apiKey, label: `fallback[${attempts.length}]` });
    }
  }
  const failures = [];
  const systemPrompt = resolveSystemPrompt(opts.cwd ?? process.cwd(), opts.home);
  const question = opts.question?.trim() || "Describe this image very precisely (text, UI, code, visible errors).";
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const remaining = totalBudget - (Date.now() - started);
    if (remaining <= 0) {
      failures.push({ model: a.model, baseUrl: a.baseUrl, error: "time budget exhausted" });
      break;
    }
    const attemptBudget = Math.min(cfg.timeoutMs, remaining);
    try {
      const text = await postChat(a.baseUrl, a.apiKey, a.model, systemPrompt, question, dataUri, attemptBudget);
      await cache.set(pathKey, st, buffer, a.model, text);
      return {
        text,
        model: a.model,
        baseUrl: a.baseUrl,
        fromFallback: i > 0
      };
    } catch (e) {
      failures.push({ model: a.model, baseUrl: a.baseUrl, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const chain = failures.map((f) => `  - ${f.model} @ ${f.baseUrl} -> ${f.error}`).join("\n");
  throw new Error(
    `vision failed on all ${failures.length} attempt(s):
${chain}
Run \`npx deepseek-vl-support doctor\` for diagnosis.`
  );
}
async function describe(filePath, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home;
  const cfg = resolveConfig(cwd, home);
  assertVisionReady(cfg);
  const abs = resolve(cwd, filePath);
  if (!hasImageExtension(abs)) {
    throw new Error(`not an image file (png/jpg/jpeg/gif/webp/bmp): ${filePath}`);
  }
  let st;
  try {
    st = await stat2(abs);
  } catch (e) {
    throw new Error(`cannot read file: ${filePath} (${e instanceof Error ? e.message : e})`);
  }
  if (st.size > cfg.maxBytes) throw new VisionSizeError(st.size, cfg.maxBytes);
  const buffer = await readFile2(abs);
  const head = await readHead(abs, 12);
  const kind = head ? sniffImageKind(head) : null;
  const mime = kind ? mimeForKind(kind) : mimeForPath(abs);
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  return runDescribe(abs, st, buffer, dataUri, basename2(abs), cfg, opts);
}
async function listModels(baseUrl, apiKey, timeoutMs = 5e3) {
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`unreachable: ${msg}`);
  }
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const data = body?.data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => typeof m?.id === "string" ? m.id : "").filter(Boolean);
}
function modelIdMatches(list, model) {
  const norm = (id) => id.replace(/^\.\//, "").toLowerCase();
  const target = norm(model);
  return list.some((id) => norm(id) === target);
}

// src/tools.ts
async function callDescribeImage(params) {
  const path = params.path;
  if (typeof path !== "string" || !path.trim()) {
    return { text: "describe_image: missing required parameter `path`.", isError: true };
  }
  const abs = resolve2(process.cwd(), path);
  const question = typeof params.question === "string" ? params.question : void 0;
  try {
    const res = await describe(abs, { question });
    return {
      text: res.fromCache ? `[Vision of ${path} (cached)]:
${res.text}` : `[Vision of ${path} (model: ${res.model})]:
${res.text}`,
      isError: false
    };
  } catch (e) {
    if (e instanceof VisionSizeError) {
      return { text: `describe_image: ${e.message}`, isError: true };
    }
    return { text: `describe_image failed: ${e instanceof Error ? e.message : e}`, isError: true };
  }
}
async function callVisionStatus() {
  const cfg = resolveConfig(process.cwd(), homedir4());
  const lines = [
    `[deepseek-vl-support] vision_status`,
    `  enabled : ${cfg.enabled}`,
    `  baseUrl : ${cfg.baseUrl}`,
    `  model   : ${cfg.model || "(not set)"}`,
    `  apiKey  : ${maskApiKey(cfg.apiKey)}`,
    `  timeout : ${cfg.timeoutMs}ms`,
    `  maxBytes: ${humanBytes(cfg.maxBytes)}`,
    `  fallbacks: ${cfg.fallbacks.length ? cfg.fallbacks.map((f) => f.model).join(", ") : "(none)"}`
  ];
  if (!cfg.enabled) {
    lines.push(`  [SKIP] vision disabled (VISION_DISABLE / enabled:false)`);
    return { text: lines.join("\n"), isError: false };
  }
  if (!cfg.model) {
    lines.push(`  [ERROR] VISION_MODEL not set`);
    return { text: lines.join("\n"), isError: true };
  }
  try {
    const ids = await listModels(cfg.baseUrl, cfg.apiKey, 5e3);
    if (ids === null) {
      lines.push(`  [WARN] endpoint reachable but /models unavailable (404/405)`);
      lines.push(`  [OK]  endpoint ${cfg.baseUrl} reachable`);
    } else if (modelIdMatches(ids, cfg.model)) {
      lines.push(`  [OK] ${cfg.baseUrl} reachable, model "${cfg.model}" found (${ids.length} model(s))`);
    } else {
      lines.push(`  [ERROR] model "${cfg.model}" NOT in /models list: ${ids.slice(0, 8).join(", ") || "(empty)"}`);
    }
  } catch (e) {
    lines.push(`  [ERROR] ${cfg.baseUrl} unreachable: ${e instanceof Error ? e.message : e}`);
  }
  return { text: lines.join("\n"), isError: false };
}

// src/dsh-plugin.ts
var name = "deepseek-vl";
var inject = ["tools"];
function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "describe_image",
      description: "Describe an image file with the configured vision model; returns detailed text (visible text, UI, colors, code, errors).",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Path to the image file (png/jpg/jpeg/gif/webp/bmp), absolute or relative to the session cwd."
        },
        question: { type: "string", description: "Optional question or focus for the description." }
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }]
      },
      async execute(args, exec) {
        if (exec.signal?.aborted) throw new Error("describe_image: cancelled");
        const res = await callDescribeImage(args);
        if (res.isError) throw new Error(res.text);
        return res.text;
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "vision_status",
      description: "Vision configuration summary + endpoint health check (model visibility).",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }]
      },
      async execute(_args, exec) {
        if (exec.signal?.aborted) throw new Error("vision_status: cancelled");
        const res = await callVisionStatus();
        return res.text;
      }
    })
  );
}
export {
  apply,
  inject,
  name
};
