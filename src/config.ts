// Configuration model + resolution chain + read/write.
//
// Resolution priority (per-field override, not whole-object replacement):
//   env (VISION_*) > project .deepseek-vl/config.json >
//   global ~/.deepseek-vl/config.json > defaults.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CACHE_DIR, CONFIG_DIR, CONFIG_FILENAME } from "./identity.ts";

export interface FallbackConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
  fallbacks: FallbackConfig[];
}

export interface ConfigPaths {
  projectDir: string;
  globalDir: string;
  projectFile: string;
  globalFile: string;
  projectCacheDir: string;
  globalCacheDir: string;
}

export const DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export const DEFAULTS: VisionConfig = {
  baseUrl: DEFAULT_BASE_URL,
  model: "",
  apiKey: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBytes: DEFAULT_MAX_BYTES,
  enabled: true,
  fallbacks: [],
};

export const CONFIG_KEYS = [
  "baseUrl",
  "model",
  "apiKey",
  "timeoutMs",
  "maxBytes",
  "enabled",
  "fallbacks",
] as const;

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function globalConfigDir(home: string = homedir()): string {
  return join(home, CONFIG_DIR);
}

export function configPaths(cwd: string, home: string = homedir()): ConfigPaths {
  const projectDir = join(cwd, CONFIG_DIR);
  const globalDir = globalConfigDir(home);
  return {
    projectDir,
    globalDir,
    projectFile: join(projectDir, CONFIG_FILENAME),
    globalFile: join(globalDir, CONFIG_FILENAME),
    projectCacheDir: join(projectDir, CACHE_DIR),
    globalCacheDir: join(globalDir, CACHE_DIR),
  };
}

/** Parse a fallbacks value: JSON array string, or already an array of
 *  {model,baseUrl?,apiKey?} objects / plain model-id strings. */
export function parseFallbacks(raw: unknown): FallbackConfig[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      // comma-separated `model@baseUrl, model2` syntax
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((part) => {
          const at = part.lastIndexOf("@");
          if (at > 0) {
            return { model: part.slice(0, at).trim(), baseUrl: part.slice(at + 1).trim() };
          }
          return { model: part };
        });
    }
  }
  if (!Array.isArray(value)) return [];
  const out: FallbackConfig[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ model: t });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.model === "string" && o.model.trim()) {
        const entry: FallbackConfig = { model: o.model.trim() };
        if (typeof o.baseUrl === "string" && o.baseUrl.trim()) entry.baseUrl = o.baseUrl.trim();
        if (typeof o.apiKey === "string") entry.apiKey = o.apiKey;
        out.push(entry);
      }
    }
  }
  return out;
}

function normNumber(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

function normBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(t)) return true;
    if (["0", "false", "no", "off"].includes(t)) return false;
  }
  return undefined;
}

/** Read and validate a config.json file. Returns null when missing or
 *  unparseable (callers must never throw on a broken config file). */
export function loadConfigFile(file: string): Partial<VisionConfig> | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: Partial<VisionConfig> = {};
  if (typeof o.baseUrl === "string" && o.baseUrl.trim()) out.baseUrl = stripTrailingSlash(o.baseUrl);
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  if (typeof o.apiKey === "string") out.apiKey = o.apiKey;
  if (o.timeoutMs !== undefined) out.timeoutMs = normNumber(o.timeoutMs, DEFAULTS.timeoutMs);
  if (o.maxBytes !== undefined) out.maxBytes = normNumber(o.maxBytes, DEFAULTS.maxBytes);
  const enabled = normBool(o.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  if (o.fallbacks !== undefined) out.fallbacks = parseFallbacks(o.fallbacks);
  return out;
}

function envBool(value: string | undefined): boolean | undefined {
  return normBool(value);
}

export function resolveConfig(
  cwd: string = process.cwd(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): VisionConfig {
  const paths = configPaths(cwd, home);
  const cfg: VisionConfig = { ...DEFAULTS, fallbacks: [...DEFAULTS.fallbacks] };

  const apply = (patch: Partial<VisionConfig> | null) => {
    if (!patch) return;
    if (patch.baseUrl !== undefined) cfg.baseUrl = patch.baseUrl;
    if (patch.model !== undefined) cfg.model = patch.model;
    if (patch.apiKey !== undefined) cfg.apiKey = patch.apiKey;
    if (patch.timeoutMs !== undefined) cfg.timeoutMs = patch.timeoutMs;
    if (patch.maxBytes !== undefined) cfg.maxBytes = patch.maxBytes;
    if (patch.enabled !== undefined) cfg.enabled = patch.enabled;
    if (patch.fallbacks !== undefined) cfg.fallbacks = patch.fallbacks.map((f) => ({ ...f }));
  };

  apply(loadConfigFile(paths.globalFile));
  apply(loadConfigFile(paths.projectFile));

  // env wins over everything
  if (env.VISION_BASE_URL !== undefined && env.VISION_BASE_URL.trim()) cfg.baseUrl = stripTrailingSlash(env.VISION_BASE_URL);
  if (env.VISION_MODEL !== undefined && env.VISION_MODEL.trim()) cfg.model = env.VISION_MODEL.trim();
  if (env.VISION_API_KEY !== undefined) cfg.apiKey = env.VISION_API_KEY;
  if (env.VISION_TIMEOUT_MS !== undefined) cfg.timeoutMs = normNumber(env.VISION_TIMEOUT_MS, DEFAULTS.timeoutMs);
  if (env.VISION_MAX_BYTES !== undefined) cfg.maxBytes = normNumber(env.VISION_MAX_BYTES, DEFAULTS.maxBytes);
  if (env.VISION_FALLBACKS !== undefined) cfg.fallbacks = parseFallbacks(env.VISION_FALLBACKS);
  const disable = envBool(env.VISION_DISABLE);
  if (disable !== undefined) cfg.enabled = !disable;

  cfg.baseUrl = stripTrailingSlash(cfg.baseUrl);
  return cfg;
}

/** Effective config for a fallback entry: missing fields inherit from the
 *  primary config. */
export function effectiveFallback(
  fb: FallbackConfig,
  primary: VisionConfig,
): { model: string; baseUrl: string; apiKey: string } {
  return {
    model: fb.model || primary.model,
    baseUrl: fb.baseUrl ? stripTrailingSlash(fb.baseUrl) : primary.baseUrl,
    apiKey: fb.apiKey !== undefined ? fb.apiKey : primary.apiKey,
  };
}

export function maskApiKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Deep-merge `patch` into the file at `file` (creating it when missing)
 *  and write it back pretty-printed. Returns the merged object. */
export function writeConfigFile(file: string, patch: Partial<VisionConfig>): VisionConfig {
  const merged: VisionConfig = { ...DEFAULTS, fallbacks: [...DEFAULTS.fallbacks] };
  const existing = loadConfigFile(file);
  const apply = (p: Partial<VisionConfig> | null) => {
    if (!p) return;
    Object.assign(merged, p, p.fallbacks ? { fallbacks: p.fallbacks.map((f) => ({ ...f })) } : {});
  };
  apply(existing);
  apply(patch);

  const out: Record<string, unknown> = {};
  if (merged.baseUrl !== DEFAULTS.baseUrl) out.baseUrl = merged.baseUrl;
  if (merged.model) out.model = merged.model;
  if (merged.apiKey) out.apiKey = merged.apiKey;
  if (merged.timeoutMs !== DEFAULTS.timeoutMs) out.timeoutMs = merged.timeoutMs;
  if (merged.maxBytes !== DEFAULTS.maxBytes) out.maxBytes = merged.maxBytes;
  if (!merged.enabled) out.enabled = false;
  if (merged.fallbacks.length) out.fallbacks = merged.fallbacks;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  return merged;
}
