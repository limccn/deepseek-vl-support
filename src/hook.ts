// deepseek-vl-support hook — Claude Code PreToolUse(Read) + SessionStart.
// Bundled by esbuild into dist/hook.cjs (zero runtime deps) and copied into
// projects by the installer. The `/*! deepseek-vl-support-hook */` banner is
// the identity marker uninstall checks.
//
// Contract (see research/claude-code-hooks.md):
//  - stdin: hook event JSON (UTF-8), stdout: ONE hook JSON payload
//  - all logging → stderr; NEVER log to stdout
//  - always exit 0 (non-zero would block the Read tool / kill context
//    injection); failure paths emit `{}` (no-op, tool proceeds normally)
import { stat, readFile, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DescriptionCache, cacheDirFor } from "./cache.ts";
import { describe, listModels, modelIdMatches } from "./client.ts";
import { resolveConfig } from "./config.ts";
import { hasImageExtension, sniffImageKind } from "./detect.ts";
import { HOOK_BUDGET_MS } from "./identity.ts";

// Force UTF-8 for stdin/stdout on Windows (default cp936 would corrupt JSON)
process.stdin.setEncoding("utf8");
process.stdout.setDefaultEncoding("utf8");

function log(msg: string): void {
  process.stderr.write(`[deepseek-vl-support] ${msg}\n`);
}

/** Write the hook JSON payload in a single write, then exit only after the
 *  write flushed (process.exit() before flush truncates piped output).
 *  Exit naturally (process.exitCode) — on Windows a forced process.exit()
 *  after async HTTPS work asserts in libuv (UV_HANDLE_CLOSING, win/async.c);
 *  reproduced in E2E 0.1.3 with real endpoints and a minimal stdin+fetch
 *  repro (natural exit is clean). The unref'd watchdog forces an exit only
 *  if some future leak keeps the loop alive. */
function output(obj: unknown): void {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n", () => {
    process.exitCode = 0;
  });
  const watchdog = setTimeout(() => process.exit(0), 10_000);
  watchdog.unref();
}

function noop(): void {
  output({});
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  // Release the stdin handle after EOF. Windows: a live-but-closing stdin
  // handle at process.exit() triggers a libuv assertion
  // (UV_HANDLE_CLOSING, win/async.c) after async HTTPS work — observed with
  // real endpoints (E2E 0.1.3); localhost/mock servers do not reproduce it.
  process.stdin.destroy();
  return chunks.join("");
}

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

function cwdOf(input: { cwd?: unknown }): string {
  return typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
}

/** PreToolUse(matcher Read): image → describe → block + additionalContext.
 *  Non-image / disabled / oversized / failed → `{}` (Read proceeds). */
async function handleRead(input: Record<string, unknown>): Promise<void> {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Read") {
    noop();
    return;
  }
  const filePathRaw = (input.tool_input as Record<string, unknown> | undefined)?.file_path;
  if (typeof filePathRaw !== "string" || !filePathRaw) {
    noop();
    return;
  }
  const cwd = cwdOf(input);
  const filePath = resolve(cwd, filePathRaw);

  // Fast path 1: extension whitelist (pure string, zero I/O)
  if (!hasImageExtension(filePath)) {
    noop();
    return;
  }
  // Fast path 2: magic bytes (12-byte read)
  const head = await readHead(filePath, 12);
  const kind = head ? sniffImageKind(head) : null;
  if (!kind) {
    noop();
    return;
  }

  const cfg = resolveConfig(cwd);
  if (!cfg.enabled || !cfg.model) {
    log(`vision disabled or VISION_MODEL not set — no-op.`);
    noop();
    return;
  }

  let st;
  try {
    st = await stat(filePath);
  } catch {
    noop();
    return;
  }
  if (st.size > cfg.maxBytes) {
    log(
      `${basename(filePath)} is ${st.size} bytes > maxBytes=${cfg.maxBytes}. ` +
        `Not describing. Compress/crop it first.`,
    );
    noop();
    return;
  }

  try {
    const buffer = await readFile(filePath);
    const cache = new DescriptionCache(cacheDirFor(cwd));
    const cached = await cache.get(filePath, st, buffer, cfg.model);
    const text = cached ??
      (await describe(filePath, { cwd, budgetMs: HOOK_BUDGET_MS, warn: log })).text;

    output({
      decision: "block",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[Vision of ${basename(filePath)}]:\n${text}`,
      },
    });
  } catch (e) {
    log(`vision failed (Read proceeds without description): ${e instanceof Error ? e.message : e}`);
    noop();
  }
}

/** SessionStart (startup/clear/compact): light doctor; inject a bilingual
 *  warning block when the endpoint/model is not healthy. Always exit 0. */
async function handleStart(input: Record<string, unknown>): Promise<void> {
  const cwd = cwdOf(input);
  const cfg = resolveConfig(cwd);
  if (!cfg.enabled || !cfg.model) {
    noop();
    return;
  }
  const problems: string[] = [];
  try {
    const ids = await listModels(cfg.baseUrl, cfg.apiKey, 5000);
    if (ids !== null && !modelIdMatches(ids, cfg.model)) {
      problems.push(
        `model "${cfg.model}" not found on ${cfg.baseUrl} (available: ${ids.slice(0, 5).join(", ") || "(none)"})`,
      );
    }
  } catch (e) {
    problems.push(`vision endpoint ${cfg.baseUrl} unreachable: ${e instanceof Error ? e.message : e}`);
  }
  if (!problems.length) {
    noop();
    return;
  }
  const warning =
    `[deepseek-vl-support] Vision not configured correctly\n` +
    problems.map((p) => `- ${p}`).join("\n") +
    `\nRun \`npx @limccn/deepseek-vl-support doctor\` for details. ` +
    `Images will NOT be described automatically.`;
  output({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: warning,
    },
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] === "start" ? "start" : "read";
  let input: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    noop();
    return;
  }
  if (mode === "start") {
    await handleStart(input);
  } else {
    await handleRead(input);
  }
}

main().then(() => {
  process.exitCode = 0;
}).catch((e) => {
  log(`unexpected error: ${e instanceof Error ? e.message : e}`);
  output({});
});
