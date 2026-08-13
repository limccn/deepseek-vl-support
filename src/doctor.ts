// doctor: endpoint reachability + /v1/models + model presence, with optional
// fallback-chain probing (--all). Shared by the CLI, the installer summary
// and the SessionStart hook (light mode).
import { homedir } from "node:os";
import { listModels, modelIdMatches } from "./client.ts";
import { effectiveFallback, humanBytes, maskApiKey, resolveConfig } from "./config.ts";

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  /** override the base URL for the primary check only */
  url?: string;
  all?: boolean;
}

export interface FallbackStatus {
  model: string;
  baseUrl: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  lines: string[];
  primaryOk: boolean;
  modelPresent: boolean;
  fallbackStatus: FallbackStatus[];
}

const norm = (id: string) => id.replace(/^\.\//, "").toLowerCase();

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const cfg = resolveConfig(cwd, home);
  const lines: string[] = [];
  const baseUrl = opts.url?.trim() ? opts.url.replace(/\/+$/, "") : cfg.baseUrl;

  lines.push(`[deepseek-vl] doctor 诊断`);
  lines.push(`  baseUrl : ${baseUrl}`);
  lines.push(`  model   : ${cfg.model || "(not set 未设置)"}`);
  lines.push(`  apiKey  : ${maskApiKey(cfg.apiKey)}`);
  lines.push(`  timeout : ${cfg.timeoutMs}ms | maxBytes: ${humanBytes(cfg.maxBytes)} | enabled: ${cfg.enabled}`);
  lines.push(`  fallbacks: ${cfg.fallbacks.length ? cfg.fallbacks.map((f) => f.model).join(", ") : "(none 无)"}`);

  const fallbackStatus: FallbackStatus[] = [];

  if (!cfg.enabled) {
    lines.push(`  [SKIP] vision disabled (VISION_DISABLE / enabled:false) 视觉已禁用`);
    return { ok: false, lines, primaryOk: false, modelPresent: false, fallbackStatus };
  }
  if (!cfg.model) {
    lines.push(`  [ERROR] VISION_MODEL not set 未配置视觉模型 - set it in config or VISION_MODEL`);
    return { ok: false, lines, primaryOk: false, modelPresent: false, fallbackStatus };
  }

  let ids: string[] | null = null;
  let reachable = true;
  try {
    ids = await listModels(baseUrl, cfg.apiKey, 5000);
  } catch (e) {
    reachable = false;
    ids = null;
    lines.push(`  [ERROR] ${baseUrl} unreachable 不可达: ${e instanceof Error ? e.message : e}`);
  }

  let present = false;
  if (ids) {
    present = modelIdMatches(ids, cfg.model);
    if (present) {
      lines.push(`  [OK] endpoint reachable, model "${cfg.model}" found (${ids.length} model(s) listed)`);
      lines.push(`  [OK] 端点可达，模型 "${cfg.model}" 已找到（共列出 ${ids.length} 个模型）`);
    } else {
      lines.push(`  [ERROR] model "${cfg.model}" NOT in /models list: ${ids.slice(0, 8).join(", ") || "(empty)"}`);
      lines.push(`  [ERROR] 模型 "${cfg.model}" 不在 /models 列表中`);
    }
  } else if (ids === null && reachable) {
    lines.push(`  [WARN] endpoint reachable but /models is unavailable (404/405) 端点可达但无法列出模型`);
    present = true; // cannot verify → do not fail doctor
  }

  const primaryOk = reachable && present;

  if (opts.all && cfg.fallbacks.length) {
    lines.push(`  -- fallback chain 备用链路 --`);
    for (let i = 0; i < cfg.fallbacks.length; i++) {
      const fb = cfg.fallbacks[i];
      const eff = effectiveFallback(fb, cfg);
      let fIds: string[] | null = null;
      let fOk = false;
      let detail: string;
      try {
        fIds = await listModels(eff.baseUrl, eff.apiKey, 5000);
        fOk = fIds ? modelIdMatches(fIds, eff.model) : true;
        detail = fIds
          ? fOk
            ? `model "${eff.model}" found 模型存在`
            : `model "${eff.model}" NOT in list 模型不在列表 (${fIds.slice(0, 5).join(", ")})`
          : `/models unavailable (404/405) 无法列出模型`;
      } catch (e) {
        detail = `unreachable 不可达: ${e instanceof Error ? e.message : e}`;
      }
      fallbackStatus.push({ model: eff.model, baseUrl: eff.baseUrl, ok: fOk, detail });
      lines.push(`  fallback[${i + 1}] ${eff.model} @ ${eff.baseUrl}: ${fOk ? "[OK] " : "[FAIL] "}${detail}`);
    }
  }

  return { ok: primaryOk, lines, primaryOk, modelPresent: present, fallbackStatus };
}
