// Hand-rolled MCP stdio server (JSON-RPC 2.0, newline-delimited), zero deps.
// Tools: describe_image(path, question?) + vision_status() (shared with the
// dsh cordis plugin via tools.ts).
// stdout carries ONLY protocol messages; everything else goes to stderr.
import { createInterface } from "node:readline";
import { PKG_NAME } from "./identity.ts";
import { callDescribeImage, callVisionStatus, describeImageSchema, visionStatusSchema } from "./tools.ts";

const SERVER_VERSION = "0.2.6";
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
