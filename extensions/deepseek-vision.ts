// pi / omp native extension: transparent vision for text-only models
// (DeepSeek). Pattern: psychobarge's pi-deepseek-vision — intercept pasted
// images (input event) and image files read via the `read` tool
// (tool_result), self-check on session_start, expose a /vision command.
//
// Difference from psychobarge: ZERO vision logic here. Every description is
// delegated to the package CLI subprocess
//   `node <pkg-root>/dist/cli.js describe --data-uri <data:...> <question>`
// so config resolution, size guards, caching and the fallback chain are
// exactly the same as the skill / MCP paths (single source of truth; npm and
// git installs are isomorphic).
//
// Runtime imports: node builtins only — no @earendil-works/pi-coding-agent
// import (types below are structural; pi loads this file with jiti).
//
// Event shapes follow pi extensions.md / psychobarge; the real-machine e2e
// checklist (design §10) re-verifies `event.images`, the `tool_result`
// image block and the transform return against the live pi.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root — one level above extensions/. Isomorphic across install
 *  layouts: npm `~/.pi/agent/npm/node_modules/deepseek-vl-support/`, git
 *  `~/.pi/agent/git/github.com/limccn/deepseek-vl-support/`, omp
 *  `~/.omp/plugins/node_modules/deepseek-vl-support/`. */
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(pkgRoot, "dist", "cli.js");

const DESCRIBE_TIMEOUT_MS = 120_000;
const VISION_PROMPT = "describe it very precisely (text, UI, code, errors)";

/** The CLI must exist for every delegation — an anomalous install (no
 *  dist/cli.js) degrades to a single notify per session, not per turn. */
let cliMissingNotified = false;

interface PiApi {
  on(event: string, handler: (event: unknown) => unknown): unknown;
  registerCommand?(name: string, def: { description: string; handler: (args: string[], ctx: unknown) => unknown }): unknown;
  registerSlashCommand?(name: string, def: { description: string; execute: (args: string[], ctx: unknown) => unknown }): unknown;
}

export default function (pi: PiApi): void {
  pi.on("input", (event) => handleInput(event));
  pi.on("tool_result", (event) => handleToolResult(event));
  pi.on("session_start", (event) => handleSessionStart(event));
  registerVisionCommand(pi);
}

// ---------------------------------------------------------------- guards

/** No-op when the active model already takes images (psychobarge's guard:
 *  ctx.model.input includes "image"). */
function modelSupportsImages(e: { model?: { input?: unknown } }): boolean {
  return Array.isArray(e?.model?.input) && e.model.input.includes("image");
}

function notify(e: unknown, msg: string): void {
  const ui = (e as { ui?: { notify?: (m: string) => void } })?.ui;
  try {
    ui?.notify?.(msg);
  } catch {
    /* TUI unavailable — drop the notice */
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- CLI subprocess

/** Run the packaged CLI, return stdout trimmed. Non-zero exit → throw with
 *  stderr truncated to 300 chars. Esc/Ctrl+C aborts the child; a hard
 *  timeout kills it too. Explicitly spawns `node` (pi itself runs on bun —
 *  process.execPath must not be trusted; npm installs bring node to PATH,
 *  same assumption as the skill fallback). */
function runCli(args: string[], signal?: AbortSignal, timeoutMs = DESCRIBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn("node", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(stdout.trim());
      else if (code === null) {
        reject(new Error(timedOut ? `cli timed out after ${timeoutMs}ms` : "cli interrupted"));
      } else {
        reject(new Error(stderr.trim().slice(0, 300) || `cli exited with code ${code}`));
      }
    });
  });
}

/** Describe one image data URI via the CLI. Returns the description text. */
async function describeImage(
  dataUri: string,
  question: string,
  signal: AbortSignal | undefined,
  event: unknown,
): Promise<string> {
  if (!existsSync(CLI)) {
    if (!cliMissingNotified) {
      cliMissingNotified = true;
      notify(event, `[deepseek-vl-support] ${CLI} not found — reinstall the package (vision hooks disabled)`);
    }
    throw new Error("missing dist/cli.js");
  }
  return runCli(["describe", "--data-uri", dataUri, question], signal);
}

function extractDataUri(image: unknown): string | null {
  const img = image as { data?: unknown; mimeType?: unknown; url?: unknown } | undefined;
  if (typeof img?.data === "string" && img.data.startsWith("data:")) return img.data;
  if (typeof img?.url === "string" && img.url.startsWith("data:")) return img.url;
  // pi event shapes carry {data, mimeType} with a raw base64 payload (the
  // psychobarge reference builds the URI the same way) — wrap it.
  if (typeof img?.data === "string" && img.data.length > 0) {
    const mime = typeof img.mimeType === "string" && img.mimeType.length > 0 ? img.mimeType : "image/png";
    return `data:${mime};base64,${img.data}`;
  }
  return null;
}

function isImageBlock(b: unknown): boolean {
  return typeof (b as { type?: unknown }).type === "string" && (b as { type: string }).type === "image";
}

// ---------------------------------------------------------------- hooks

/** input: pasted images on a non-vision model → describe each, inject the
 *  descriptions as a text prefix and drop the images. On failure: notify and
 *  continue (pi's default). */
async function handleInput(event: unknown): Promise<unknown> {
  const e = event as {
    model?: { input?: unknown };
    input?: unknown;
    images?: unknown;
    signal?: AbortSignal;
    ui?: unknown;
  };
  if (modelSupportsImages(e)) return { action: "continue" };
  const images = Array.isArray(e.images) ? e.images : [];
  if (images.length === 0) return { action: "continue" };

  try {
    const texts: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const dataUri = extractDataUri(images[i]);
      if (!dataUri) continue;
      const text = await describeImage(dataUri, `Image ${i + 1}/${images.length}: ${VISION_PROMPT}`, e.signal, e);
      texts.push(text);
    }
    if (texts.length === 0) return { action: "continue" };
    const original = typeof e.input === "string" ? e.input : "";
    const prefix = texts.map((t) => `[Vision of attached image: ${t}]`).join("\n");
    return { action: "transform", text: original ? `${prefix}\n\n${original}` : prefix, images: [] };
  } catch (err) {
    notify(e, `[deepseek-vl-support] vision failed: ${errMsg(err)}`);
    return { action: "continue" };
  }
}

/** tool_result: a `read` tool that returned image blocks → replace each
 *  block with a text block carrying the description. Failure: notify, leave
 *  the result untouched (never crash the turn). */
async function handleToolResult(event: unknown): Promise<unknown> {
  const e = event as {
    model?: { input?: unknown };
    toolName?: unknown;
    content?: unknown;
    signal?: AbortSignal;
    ui?: unknown;
  };
  if (modelSupportsImages(e)) return;
  if (e.toolName !== "read") return;
  const content = Array.isArray(e.content) ? e.content : [];
  const imageCount = content.filter(isImageBlock).length;
  if (imageCount === 0) return;

  try {
    // Descriptions are keyed by block index, not by sequence — an image
    // block without an extractable data URI stays untouched instead of
    // shifting a description onto the wrong block.
    const texts = new Map<number, string>();
    let n = 0;
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      if (!isImageBlock(b)) continue;
      n++;
      const dataUri = extractDataUri(b);
      if (!dataUri) continue;
      const text = await describeImage(dataUri, `Image ${n}/${imageCount}: ${VISION_PROMPT}`, e.signal, e);
      texts.set(i, `[Vision: ${text}]`);
    }
    if (texts.size === 0) return;
    const replaced = content.map((b, i) => (texts.has(i) ? { type: "text", text: texts.get(i) } : b));
    return { content: replaced };
  } catch (err) {
    notify(e, `[deepseek-vl-support] vision failed: ${errMsg(err)}`);
    return;
  }
}

/** session_start: fire-and-forget doctor check (never blocks session
 *  startup — a slow endpoint probe must not delay the first turn). */
function handleSessionStart(event: unknown): void {
  const e = event as { signal?: AbortSignal; ui?: unknown };
  runCli(["doctor"], e.signal, 20_000)
    .then((out) => notify(e, `[deepseek-vl-support] vision status:\n${out}`))
    .catch((err) => notify(e, `[deepseek-vl-support] vision check failed: ${errMsg(err)}`));
}

/** /vision command: print the doctor summary (endpoint + model check). */
function registerVisionCommand(pi: PiApi): void {
  const def = {
    description: "DeepSeek vision status: endpoint reachability + model check (deepseek-vl-support)",
    handler: async (args: string[], ctx: unknown) => {
      const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
      try {
        const out = await runCli(["doctor"], signal, 30_000);
        notify(ctx, out);
      } catch (err) {
        notify(ctx, `[deepseek-vl-support] vision check failed: ${errMsg(err)}`);
      }
    },
  };
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("vision", def as never);
  } else if (typeof pi.registerSlashCommand === "function") {
    pi.registerSlashCommand("vision", def as never);
  }
}
