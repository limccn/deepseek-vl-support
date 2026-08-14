// Hand-rolled MCP stdio server (JSON-RPC 2.0, newline-delimited), zero deps.
// Tools: describe_image(path, question?) + vision_status().
// stdout carries ONLY protocol messages; everything else goes to stderr.
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, listModels, modelIdMatches, VisionSizeError } from "./client.ts";
import { humanBytes, maskApiKey, resolveConfig } from "./config.ts";
import { PKG_NAME } from "./identity.ts";

const SERVER_VERSION = "0.2.1";
const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errorResponse(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function resultResponse(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function toolResult(id: unknown, text: string, isError = false): void {
  resultResponse(id, {
    content: [{ type: "text", text }],
    isError,
  });
}

function describeImageSchema() {
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

function visionStatusSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

async function callDescribeImage(params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
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

async function callVisionStatus(): Promise<{ text: string; isError: boolean }> {
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

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id;
  const method = req.method;

  if (method === "initialize") {
    const clientVersion = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
    resultResponse(id, {
      protocolVersion: typeof clientVersion === "string" && clientVersion ? clientVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: PKG_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "notifications/initialized") return; // no response
  if (method === "ping") {
    resultResponse(id, {});
    return;
  }
  if (method === "tools/list") {
    resultResponse(id, {
      tools: [
        {
          name: "describe_image",
          description:
            "Describe an image file with the configured vision model; returns detailed text (visible text, UI, colors, code, errors).",
          inputSchema: describeImageSchema(),
        },
        {
          name: "vision_status",
          description:
            "Vision configuration summary + endpoint health check (model visibility).",
          inputSchema: visionStatusSchema(),
        },
      ],
    });
    return;
  }
  if (method === "tools/call") {
    const name = req.params?.name;
    const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
    if (name === "describe_image") {
      const r = await callDescribeImage(args);
      toolResult(id, r.text, r.isError);
      return;
    }
    if (name === "vision_status") {
      const r = await callVisionStatus();
      toolResult(id, r.text, r.isError);
      return;
    }
    errorResponse(id, -32602, `unknown tool: ${String(name)}`);
    return;
  }

  errorResponse(id, -32601, `method not found: ${String(method)}`);
}

/** Run the stdio MCP server until stdin closes. */
export async function runMcpServer(): Promise<void> {
  process.stdin.setEncoding("utf8");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (typeof req.method !== "string") {
      send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32600, message: "invalid request" } });
      continue;
    }
    try {
      await handleRequest(req);
    } catch (e) {
      if (req.id !== undefined) {
        errorResponse(req.id, -32603, `internal error: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
