// Shared tool definitions for the vision surfaces: the MCP stdio server
// (src/mcp.ts) and the DeepSeek Harness cordis plugin (src/dsh-plugin.ts)
// register the same two tools with identical names, descriptions, output
// format and error semantics — single source of truth for the tool contract.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, listModels, modelIdMatches, VisionSizeError } from "./client.ts";
import { humanBytes, maskApiKey, resolveConfig } from "./config.ts";

export function describeImageSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the image file (png/jpg/jpeg/gif/webp/bmp), absolute or relative to the session cwd.",
      },
      question: {
        type: "string",
        description: "Optional question or focus for the description.",
      },
    },
    required: ["path"],
  };
}

export function visionStatusSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

export async function callDescribeImage(params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const path = params.path;
  if (typeof path !== "string" || !path.trim()) {
    return { text: "describe_image: missing required parameter `path`.", isError: true };
  }
  const abs = resolve(process.cwd(), path);
  const question = typeof params.question === "string" ? params.question : undefined;
  try {
    const res = await describe(abs, { question });
    return {
      text:
        res.fromCache
          ? `[Vision of ${path} (cached)]:\n${res.text}`
          : `[Vision of ${path} (model: ${res.model})]:\n${res.text}`,
      isError: false,
    };
  } catch (e) {
    if (e instanceof VisionSizeError) {
      return { text: `describe_image: ${e.message}`, isError: true };
    }
    return { text: `describe_image failed: ${e instanceof Error ? e.message : e}`, isError: true };
  }
}

export async function callVisionStatus(): Promise<{ text: string; isError: boolean }> {
  const cfg = resolveConfig(process.cwd(), homedir());
  const lines = [
    `[deepseek-vl-support] vision_status`,
    `  enabled : ${cfg.enabled}`,
    `  baseUrl : ${cfg.baseUrl}`,
    `  model   : ${cfg.model || "(not set)"}`,
    `  apiKey  : ${maskApiKey(cfg.apiKey)}`,
    `  timeout : ${cfg.timeoutMs}ms`,
    `  maxBytes: ${humanBytes(cfg.maxBytes)}`,
    `  fallbacks: ${cfg.fallbacks.length ? cfg.fallbacks.map((f) => f.model).join(", ") : "(none)"}`,
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
    const ids = await listModels(cfg.baseUrl, cfg.apiKey, 5000);
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
