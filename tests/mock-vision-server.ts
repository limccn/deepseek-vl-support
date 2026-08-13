// Shared mock OpenAI-compatible vision server for tests.
// Routes: POST /v1/chat/completions, GET /v1/models.
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface MockRequest {
  path: string;
  body: unknown;
}

export interface MockVisionOptions {
  models?: string[];
  /** Custom chat handler: return {status, content}. content null → empty response. */
  chat?: (body: unknown) => { status?: number; content?: string | null };
  delayMs?: number;
  modelsStatus?: number;
}


export interface MockVisionServer {
  url: string;
  port: number;
  requests: MockRequest[];
  close(): Promise<void>;
}

const DEFAULT_CHAT = (): { status?: number; content?: string | null } => ({
  content: "mock 描述：截图中有错误对话框与按钮。mock description with UI layout details.",
});

export function startMockVisionServer(opts: MockVisionOptions = {}): Promise<MockVisionServer> {
  const requests: MockRequest[] = [];
  const chat = opts.chat ?? DEFAULT_CHAT;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ path: req.url ?? "", body });

    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const r = chat(body);
      const status = r.status ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      if (status === 200) {
        res.end(JSON.stringify({ choices: [{ message: { content: r.content ?? null } }] }));
      } else {
        res.end(JSON.stringify({ error: { message: `mock failure (${status})` } }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      if (opts.modelsStatus !== undefined) {
        res.writeHead(opts.modelsStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "models endpoint not implemented" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: (opts.models ?? ["qwen2.5vl:7b", "llama3.2-vision:11b"]).map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        port: addr.port,
        requests,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** PNG magic bytes + 8KB of zeros — enough for magic sniffing and size math. */
export function makeFakePng(size = 8192): Buffer {
  const buf = Buffer.alloc(size);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  magic.copy(buf, 0);
  return buf;
}
