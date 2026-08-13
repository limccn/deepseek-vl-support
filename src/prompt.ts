// Vision system prompt: 3-level override
//   project .deepseek-vl/vision-prompt.md > global ~/.deepseek-vl/vision-prompt.md
//   > packaged assets/vision-prompt.md > built-in DEFAULT_PROMPT.
// Mirrors the pi-deepseek-vision reference (agents/vision.md).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalConfigDir } from "./config.ts";
import { CONFIG_DIR } from "./identity.ts";
import { packagedPromptPath } from "./paths.ts";

export const DEFAULT_PROMPT =
  "You are a vision specialist. Describe images exhaustively: all visible text " +
  "verbatim, UI layout, colors, code, error messages, icons. Be precise and structured. " +
  "If asked a specific question, answer it first, then add detail.";

/** Strip YAML frontmatter (`---`-delimited) and return the body. */
export function stripFrontmatter(text: string): string {
  const trimmed = text.replace(/^﻿/, "");
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end >= 0) return trimmed.slice(end + 4);
    return trimmed.slice(3);
  }
  return trimmed;
}

export function readPromptFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const body = stripFrontmatter(readFileSync(file, "utf8"));
    if (body.trim()) return body.trim();
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveSystemPrompt(cwd: string = process.cwd(), home: string = homedir()): string {
  const project = join(cwd, CONFIG_DIR, "vision-prompt.md");
  const global = join(globalConfigDir(home), "vision-prompt.md");
  return readPromptFile(project) ?? readPromptFile(global) ?? readPromptFile(packagedPromptPath()) ?? DEFAULT_PROMPT;
}
