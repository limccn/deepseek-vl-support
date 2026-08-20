// OpenAI-compatible vision client.
// describe()/describeDataUri(): size guard → base64 data URI → cache →
// fallback chain with a shared time budget. listModels(): /v1/models probe
// for doctor/startup checks.
import type { Stats } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DescriptionCache, cacheDirFor } from "./cache.ts";
import { effectiveFallback, resolveConfig } from "./config.ts";
import type { VisionConfig } from "./config.ts";
import { hasImageExtension, mimeForKind, mimeForPath, sniffImageKind } from "./detect.ts";
import { resolveSystemPrompt } from "./prompt.ts";

export class VisionSizeError extends Error {
  readonly fileSize: number;
  readonly maxBytes: number;

  constructor(fileSize: number, maxBytes: number) {
    super(
      `image too large: ${fileSize} bytes exceeds maxBytes=${maxBytes}. ` +
        `Compress or crop it first (e.g. under 5 MB, ~2000px on the long edge).`,
    );
    this.name = "VisionSizeError";
    this.fileSize = fileSize;
    this.maxBytes = maxBytes;
  }
}

export interface AttemptFailure {
  model: string;
  baseUrl: string;
  error: string;
}

export interface DescribeResult {
  text: string;
  model: string;
  baseUrl: string;
  /** true when the result came from a fallback entry, not the primary model */
  fromFallback: boolean;
  /** true when served from the description cache (no API call) */
  fromCache?: boolean;
}

export interface DescribeOptions {
  cwd?: string;
  home?: string;
  question?: string;
  /** Overall time budget shared across the whole fallback chain.
   *  Defaults to cfg.timeoutMs. */
  budgetMs?: number;
  /** stderr logger (hook passes its own); used for the >2MB soft warning */
  warn?: (msg: string) => void;
}

export const SOFT_WARN_BYTES = 2 * 1024 * 1024;

async function readHead(filePath: string, n: number): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function postChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  question: string,
  dataUri: string,
  timeoutMs: number,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res: Response;
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
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
      }),
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
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    throw new Error("invalid JSON response from vision endpoint");
  }
  const text = (out as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("empty response - does the model support images?");
  }
  return text.trim();
}

/** Cache key path for describeDataUri input (no real file path exists).
 *  Content identity comes from sha256(buffer)+size+model, so a fixed path
 *  key is safe: identical payloads hit, different ones never collide. */
const INLINE_PATH = "data:";

const DATA_URI_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

function assertVisionReady(cfg: VisionConfig): void {
  if (!cfg.enabled) throw new Error("vision disabled (VISION_DISABLE=1 or enabled:false)");
  if (!cfg.model) {
    throw new Error(`VISION_MODEL is not set (server: ${cfg.baseUrl}) - e.g. export VISION_MODEL=qwen2.5vl:7b`);
  }
}

/** The part of describe() shared with describeDataUri: soft warning, cache,
 *  primary attempt, fallback chain with a shared time budget, cache write
 *  keyed on the model that actually answered. `pathKey` is the cache
 *  identity (file path, or INLINE_PATH for inline data); `st` may be a
 *  pseudo-Stats ({size, mtimeMs: 0}) for inline data — cache.ts only reads
 *  those two fields. */
async function runDescribe(
  pathKey: string,
  st: Stats,
  buffer: Buffer,
  dataUri: string,
  displayName: string,
  cfg: VisionConfig,
  opts: DescribeOptions,
): Promise<DescribeResult> {
  if (st.size > SOFT_WARN_BYTES) {
    const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
    warn(
      `[deepseek-vl-support] ${displayName} is ${st.size} bytes (>2MB): remote vision API ` +
        `may be slow and costly.`,
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
      fromCache: true,
    };
  }

  const totalBudget = Math.max(1000, opts.budgetMs ?? cfg.timeoutMs);
  const started = Date.now();
  const attempts: Array<{ model: string; baseUrl: string; apiKey: string; label: string }> = [];
  attempts.push({ model: cfg.model, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, label: "primary" });
  for (const fb of cfg.fallbacks) {
    const eff = effectiveFallback(fb, cfg);
    if (eff.model && eff.baseUrl) {
      attempts.push({ model: eff.model, baseUrl: eff.baseUrl, apiKey: eff.apiKey, label: `fallback[${attempts.length}]` });
    }
  }

  const failures: AttemptFailure[] = [];
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
        fromFallback: i > 0,
      };
    } catch (e) {
      failures.push({ model: a.model, baseUrl: a.baseUrl, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const chain = failures
    .map((f) => `  - ${f.model} @ ${f.baseUrl} -> ${f.error}`)
    .join("\n");
  throw new Error(
    `vision failed on all ${failures.length} attempt(s):\n${chain}\n` +
      `Run \`npx @limccn/deepseek-vl-support doctor\` for diagnosis.`,
  );
}

/**
 * Describe an image file. Handles: size guard (before base64), soft warning
 * for >2MB files, cache hit, primary attempt, fallback chain with a shared
 * time budget, and cache write keyed on the model that actually answered.
 */
export async function describe(
  filePath: string,
  opts: DescribeOptions = {},
): Promise<DescribeResult> {
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
    st = await stat(abs);
  } catch (e) {
    throw new Error(`cannot read file: ${filePath} (${e instanceof Error ? e.message : e})`);
  }

  // Size guard BEFORE base64 / any network call
  if (st.size > cfg.maxBytes) throw new VisionSizeError(st.size, cfg.maxBytes);

  const buffer = await readFile(abs);
  const head = await readHead(abs, 12);
  const kind = head ? sniffImageKind(head) : null;
  const mime = kind ? mimeForKind(kind) : mimeForPath(abs);
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;

  return runDescribe(abs, st, buffer, dataUri, basename(abs), cfg, opts);
}

/**
 * Describe an image passed inline as a data URI
 * (data:<mime>;base64,<payload>). Same size guard / cache / fallback chain
 * as describe(); the cache key is sha256(buffer)+size+model on a fixed
 * path, so identical payloads hit the cache and different ones never
 * collide.
 */
export async function describeDataUri(
  dataUri: string,
  opts: DescribeOptions = {},
): Promise<DescribeResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home;
  const cfg = resolveConfig(cwd, home);

  assertVisionReady(cfg);

  const m = DATA_URI_RE.exec(dataUri);
  if (!m) {
    throw new Error("invalid data URI (expected data:<mime>;base64,<payload>)");
  }
  const mime = m[1].toLowerCase();
  if (!mime.startsWith("image/")) {
    throw new Error(`not an image data URI (mime: ${mime})`);
  }
  let buffer: Buffer;
  try {
    buffer = m[2]
      ? Buffer.from(m[3].replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(m[3]), "utf8");
  } catch {
    throw new Error("invalid data URI payload (bad base64 or percent-encoding)");
  }
  if (buffer.length === 0) throw new Error("empty image data URI");

  // Size guard BEFORE any network call (the payload is decoded first —
  // the size is only known after decoding)
  if (buffer.length > cfg.maxBytes) throw new VisionSizeError(buffer.length, cfg.maxBytes);

  const st = { size: buffer.length, mtimeMs: 0 } as Stats;
  return runDescribe(INLINE_PATH, st, buffer, dataUri, "inline image", cfg, opts);
}

/**
 * GET {baseUrl}/models with a short timeout.
 * Returns the list of model ids; null when the endpoint does not implement
 * /models (404/405 → doctor degrades to a warning instead of failing).
 * Throws on network errors / other status codes.
 */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<string[] | null> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`unreachable: ${msg}`);
  }
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const data = (body as { data?: Array<{ id?: unknown }> })?.data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
}

/** Case/`./`-insensitive model id comparison (ollama lists `./qwen…`). */
export function modelIdMatches(list: string[], model: string): boolean {
  const norm = (id: string) => id.replace(/^\.\//, "").toLowerCase();
  const target = norm(model);
  return list.some((id) => norm(id) === target);
}

export type { VisionConfig };
