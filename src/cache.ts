// Description cache: key = sha256(file) + mtimeMs + size + model.
// Stored as `.deepseek-vl/cache/<sha256>.json` (project) or
// `~/.deepseek-vl/cache/` (global). Remote vision APIs are billed per call;
// re-reading the same image must not re-invoke the API.
//
// One record per sha: when a different model describes the same file the
// record is overwritten. The old model then misses and re-fetches (design §5:
// "换模型…自然失效，不跨模型复用描述" — descriptions are never reused across
// models, and overwriting keeps the format a single human-readable record).
//
// The cache file content doubles as the "Plan B" description file format:
// `[Vision of <path>]:\n<description>`.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPaths } from "./config.ts";
import { CACHE_DIR, CONFIG_DIR } from "./identity.ts";

export const CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB cap

export function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Cache location follows the config scope: when the project has its own
 *  .deepseek-vl/config.json use the project cache, otherwise global. */
export function cacheDirFor(cwd: string, home: string = homedir()): string {
  if (existsSync(join(cwd, CONFIG_DIR, "config.json"))) return join(cwd, CONFIG_DIR, CACHE_DIR);
  return join(home, CONFIG_DIR, CACHE_DIR);
}

export interface CacheRecord {
  key: string;
  path: string;
  model: string;
  mtimeMs: number;
  size: number;
  text: string;
}

export class DescriptionCache {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number = CACHE_MAX_BYTES) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  private recordPath(sha: string): string {
    return join(this.dir, `${sha}.json`);
  }

  async get(filePath: string, st: Stats, buffer: Buffer, model: string): Promise<string | null> {
    const sha = sha256Of(buffer);
    const file = this.recordPath(sha);
    if (!existsSync(file)) return null;
    let rec: CacheRecord;
    try {
      rec = JSON.parse(await readFile(file, "utf8")) as CacheRecord;
    } catch {
      return null;
    }
    if (
      typeof rec?.text !== "string" ||
      rec.model !== model ||
      rec.size !== st.size ||
      rec.mtimeMs !== st.mtimeMs ||
      rec.path !== filePath
    ) {
      return null;
    }
    return rec.text;
  }

  async set(
    filePath: string,
    st: Stats,
    buffer: Buffer,
    model: string,
    text: string,
  ): Promise<void> {
    const sha = sha256Of(buffer);
    const rec: CacheRecord = {
      key: sha,
      path: filePath,
      model,
      mtimeMs: st.mtimeMs,
      size: st.size,
      text,
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.recordPath(sha), JSON.stringify(rec, null, 2) + "\n", "utf8");
    await this.prune();
  }

  /** Total cache size above maxBytes: evict oldest (by mtime) first. */
  async prune(): Promise<void> {
    let entries: Array<{ file: string; mtimeMs: number; size: number }>;
    try {
      const names = await readdir(this.dir);
      const withStats = await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n) => {
            const p = join(this.dir, n);
            const s = await stat(p).catch(() => null);
            return s ? { file: p, mtimeMs: s.mtimeMs, size: s.size } : null;
          }),
      );
      entries = withStats.filter((e): e is NonNullable<typeof e> => e !== null);
    } catch {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      await unlink(e.file).catch(() => {});
      total -= e.size;
    }
  }

  /** Remove the whole cache directory (used by `uninstall --purge-config`). */
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
