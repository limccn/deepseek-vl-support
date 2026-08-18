// DeepSeek Harness (dsh) native cordis plugin: registers describe_image +
// vision_status as first-party tools (same names/descriptions/output format
// as the MCP server — shared via tools.ts), so `dsh plugin --profile web add
// deepseek-vl-support` gives a dsh session vision with no extra config.
//
// Activation: package.json "dsh" key → cordis.patch.yml insert line → the
// profile pnpm closure loads this module (package main entry) and injects
// @deepseek-ai/cordis + @deepseek-ai/dsh-tools at runtime. Those packages are
// devDependencies here for types only — this file is bundled with them
// external (see build.mjs), so the plugin never ships its own copies.
//
// Contract source: the official dsh plugin docs (develop/basic/tool.md) and
// the @deepseek-ai/dsh-tools tutorial (defineTool + ctx.tools.register +
// execute(args, exec) with exec.signal). Real-machine e2e checklist lives in
// docs/releasing.md.
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { callDescribeImage, callVisionStatus } from "./tools.ts";

/** Stable plugin id — matches the cordis.patch.yml insert id. */
export const name = "deepseek-vl";

export const inject = ["tools"] as const;

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "describe_image",
      description:
        "Describe an image file with the configured vision model; returns detailed text (visible text, UI, colors, code, errors).",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Path to the image file (png/jpg/jpeg/gif/webp/bmp), absolute or relative to the session cwd.",
        },
        question: { type: "string", description: "Optional question or focus for the description." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args, exec) {
        // The shared core has no AbortSignal input — the per-call budget
        // (cfg.timeoutMs) bounds the request, so cancellation is best-effort:
        // refuse to start an already-cancelled call instead of orphaning work.
        if (exec.signal?.aborted) throw new Error("describe_image: cancelled");
        const res = await callDescribeImage(args);
        if (res.isError) throw new Error(res.text);
        return res.text;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "vision_status",
      description: "Vision configuration summary + endpoint health check (model visibility).",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(_args, exec) {
        if (exec.signal?.aborted) throw new Error("vision_status: cancelled");
        const res = await callVisionStatus();
        // Health-check results are informational — a broken endpoint is a
        // readable report, not an isError.
        return res.text;
      },
    }),
  );
}
