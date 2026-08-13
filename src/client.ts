// OpenAI-compatible vision client.
// describe(): size guard → base64 data URI → cache → fallback chain with a
// shared time budget. listModels(): /v1/models probe for doctor/startup checks.
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
        `Compress or crop it first (e.g. under 5 MB, ~2000px on the long edge). ` +
        `图片过大：超过限制 ${maxBytes} 字节，请先压缩或裁剪（如 5 MB 以内、长边约 2000px）。`,
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
    throw new Error("empty response - does the model support images? 空响应——该模型是否支持图片输入？");
  }
  return text.trim();
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

  if (!cfg.enabled) throw new Error("vision disabled (VISION_DISABLE=1 or enabled:false)");
  if (!cfg.model) {
    throw new Error(`VISION_MODEL is not set (server: ${cfg.baseUrl}) - e.g. export VISION_MODEL=qwen2.5vl:7b`);
  }

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
  if (st.size > SOFT_WARN_BYTES) {
    const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
    warn(
      `[deepseek-vl] ${basename(abs)} is ${st.size} bytes (>2MB): remote vision API ` +
        `may be slow and costly. 图片超过 2MB，远程视觉接口可能较慢且费用较高。`,
    );
  }

  const buffer = await readFile(abs);
  const head = await readHead(abs, 12);
  const kind = head ? sniffImageKind(head) : null;
  const mime = kind ? mimeForKind(kind) : mimeForPath(abs);
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;

  const cache = new DescriptionCache(cacheDirFor(cwd, home));
  const cached = await cache.get(abs, st, buffer, cfg.model);
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
  const systemPrompt = resolveSystemPrompt(cwd, home);
  const question = opts.question?.trim() || "Describe this image very precisely (text, UI, code, visible errors). 请非常精确地描述这张图片（文字、界面、代码、可见错误）。";

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
      await cache.set(abs, st, buffer, a.model, text);
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
      `Run \`npx deepseek-vl-support doctor\` for diagnosis. 视觉调用全部失败，请运行 doctor 诊断。`,
  );
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
