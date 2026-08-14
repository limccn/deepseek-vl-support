// Codex integration: config.toml MCP section, AGENTS.md managed block, and
// the DeepSeek models.json fix (openai/codex#36382: `supports_search_tool:
// true` hides all MCP tools). All edits are line/section based, idempotent,
// and back up the file to `<file>.bak` before the first modification.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  MCP_SERVER_NAME,
  PKG_NAME,
} from "./identity.ts";
import { templatePath } from "./paths.ts";

export function readTextFile(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Copy `p` to `p.bak` (backup of the pre-modification state). */
export function backupFile(p: string): string | null {
  try {
    const bak = `${p}.bak`;
    copyFileSync(p, bak);
    return bak;
  } catch {
    return null;
  }
}

export interface EditResult {
  changed: boolean;
  backup?: string | null;
}

function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

// ---------------------------------------------------------------- TOML

const MCP_SECTION_RE = /^\s*\[\s*mcp_servers\.(?:"deepseek-vl"|deepseek-vl)\s*\]/;
const SECTION_RE = /^\s*\[/;

/** JSON escaping is valid TOML basic-string escaping (\", \\, \n, \uXXXX). */
export function tomlEscape(s: string): string {
  return JSON.stringify(s);
}

export function buildMcpBlock(version: string): string {
  const args = ["-y", `${PKG_NAME}@${version}`, "mcp"].map(tomlEscape).join(", ");
  return (
    `[mcp_servers.${MCP_SERVER_NAME}]\n` +
    `command = ${tomlEscape("npx")}\n` +
    `args = [${args}]\n` +
    // vision reasoning can exceed Codex's default 60s tool timeout
    `tool_timeout_sec = 180\n`
  );
}

/** Insert/replace the [mcp_servers.deepseek-vl] section (idempotent). */
export function upsertMcpSection(tomlPath: string, version: string): EditResult {
  const existing = readTextFile(tomlPath);
  const block = buildMcpBlock(version);

  if (existing === null) {
    ensureDir(tomlPath);
    writeFileSync(tomlPath, block + "\n", "utf8");
    return { changed: true };
  }

  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => MCP_SECTION_RE.test(l));
  if (idx >= 0) {
    // find the end of the section (next [section] line or EOF)
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (SECTION_RE.test(lines[i])) {
        end = i;
        break;
      }
    }
    const head = lines.slice(0, idx).join("\n").trimEnd();
    const tail = lines.slice(end).join("\n");
    const content = `${head}${head ? "\n\n" : ""}${block}${tail ? "\n" + tail : ""}`;
    if (content === existing) return { changed: false };
    const backup = backupFile(tomlPath);
    ensureDir(tomlPath);
    writeFileSync(tomlPath, content, "utf8");
    return { changed: true, backup };
  }

  const content = `${existing.trimEnd()}\n\n${block}`;
  const backup = backupFile(tomlPath);
  ensureDir(tomlPath);
  writeFileSync(tomlPath, content, "utf8");
  return { changed: true, backup };
}

/** Remove only the [mcp_servers.deepseek-vl] section; keep everything else. */
export function removeMcpSection(tomlPath: string): EditResult {
  const existing = readTextFile(tomlPath);
  if (existing === null) return { changed: false };
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => MCP_SECTION_RE.test(l));
  if (idx < 0) return { changed: false };
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, idx).join("\n").trimEnd();
  const tail = lines.slice(end).join("\n").trim();
  let content: string;
  if (head && tail) content = `${head}\n\n${tail}\n`;
  else if (head) content = `${head}\n`;
  else if (tail) content = `${tail}\n`;
  else content = "";
  if (content.trim() === existing.trim()) return { changed: false };
  const backup = backupFile(tomlPath);
  ensureDir(tomlPath);
  writeFileSync(tomlPath, content, "utf8");
  return { changed: true, backup };
}

// ---------------------------------------------------------------- AGENTS.md

export function agentsBlock(): string {
  const fragment = readTextFile(templatePath("agents-fragment.md")) ?? "";
  return `${AGENTS_START_MARKER}\n${fragment.trim()}\n${AGENTS_END_MARKER}`;
}

function replaceManagedBlock(content: string, block: string): string {
  const re = new RegExp(`${AGENTS_START_MARKER}[\\s\\S]*?(?:${AGENTS_END_MARKER}|$)`);
  if (!re.test(content)) return content;
  return content.replace(re, block);
}

/** Insert/replace the managed block between the AGENTS markers. */
export function upsertAgentsBlock(agentsPath: string): EditResult {
  const existing = readTextFile(agentsPath);
  const block = agentsBlock();

  if (existing === null) {
    ensureDir(agentsPath);
    writeFileSync(agentsPath, block + "\n", "utf8");
    return { changed: true };
  }
  if (!existing.includes(AGENTS_START_MARKER)) {
    const content = `${existing.trimEnd()}\n\n${block}\n`;
    const backup = backupFile(agentsPath);
    ensureDir(agentsPath);
    writeFileSync(agentsPath, content, "utf8");
    return { changed: true, backup };
  }
  const content = replaceManagedBlock(existing, block);
  if (content === existing) return { changed: false };
  const backup = backupFile(agentsPath);
  ensureDir(agentsPath);
  writeFileSync(agentsPath, content, "utf8");
  return { changed: true, backup };
}

/** Remove the managed block (and its surrounding blank lines) only. */
export function removeAgentsBlock(agentsPath: string): EditResult {
  const existing = readTextFile(agentsPath);
  if (existing === null) return { changed: false };
  if (!existing.includes(AGENTS_START_MARKER)) return { changed: false };
  const re = new RegExp(`\\n?\\s*${AGENTS_START_MARKER}[\\s\\S]*?${AGENTS_END_MARKER}\\n?`);
  const content = existing.replace(re, "");
  if (content === existing) return { changed: false };
  const backup = backupFile(agentsPath);
  ensureDir(agentsPath);
  writeFileSync(agentsPath, content, "utf8");
  return { changed: true, backup };
}

// ---------------------------------------------------------------- models.json

export interface ModelsJsonFixResult {
  changed: boolean;
  fixedEntries: string[];
  backup?: string | null;
  reason: string;
}

/**
 * openai/codex#36382: DeepSeek's official models.json ships
 * `supports_search_tool: true` which hides ALL mcp__* tools. Fix: flip it to
 * false. Accepts an array or `{models: [...]}` shape; backups before edit.
 */
export function fixModelsJson(modelsPath: string): ModelsJsonFixResult {
  const existing = readTextFile(modelsPath);
  const reason =
    "models.json bug (openai/codex#36382): `supports_search_tool: true` hides all MCP tools. " +
    "Flattened to false for DeepSeek entries.";
  if (existing === null) return { changed: false, fixedEntries: [], reason };
  let data: unknown;
  try {
    data = JSON.parse(existing);
  } catch {
    return { changed: false, fixedEntries: [], reason };
  }
  const entries = Array.isArray(data)
    ? data
    : Array.isArray((data as { models?: unknown[] })?.models)
      ? (data as { models: unknown[] }).models
      : null;
  if (!entries) return { changed: false, fixedEntries: [], reason };

  const fixed: string[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    const name = String(rec.name ?? rec.id ?? "").toLowerCase();
    if (name.includes("deepseek") && rec.supports_search_tool === true) {
      rec.supports_search_tool = false;
      fixed.push(String(rec.name ?? rec.id ?? "?"));
    }
  }
  if (!fixed.length) return { changed: false, fixedEntries: [], reason };

  const backup = backupFile(modelsPath);
  ensureDir(modelsPath);
  writeFileSync(modelsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { changed: true, fixedEntries: fixed, backup, reason };
}

/** models.json lookup: project .codex/models.json, then ~/.codex/models.json. */
export function findModelsJson(cwd: string, home: string = homedir()): string | null {
  const project = join(cwd, ".codex", "models.json");
  if (existsSync(project)) return project;
  const user = join(home, ".codex", "models.json");
  if (existsSync(user)) return user;
  return null;
}
