// Identity constants shared by every artifact the installer writes.
// These strings are the ONLY thing that marks a file/entry as ours:
// uninstall removes artifacts that carry them, and never touches files
// that don't. Keep them stable across releases.
export const PKG_NAME = "deepseek-vl-support";
export const BIN_NAME = "deepseek-vl-support";
export const MCP_SERVER_NAME = "deepseek-vl";

export const CONFIG_DIR = ".deepseek-vl";
export const CONFIG_FILENAME = "config.json";
export const CACHE_DIR = "cache";

// Claude Code hook artifact
export const HOOK_FILENAME = "deepseek-vision-hook.cjs";
export const HOOK_MARKER = "deepseek-vl-support-hook";
// Substring used to recognize OUR hook entries inside settings.json
// (both the PreToolUse Read entry and the SessionStart entry embed it in
// their command strings).
export const HOOK_COMMAND_IDENT = "deepseek-vision-hook";

// skill / slash-command markers (checked by includes(), placed at the top
// of the file so they double as human-readable provenance)
export const SKILL_DIRNAME = "deepseek-vision";
export const SKILL_MARKER = "deepseek-vl-support:skill";
export const COMMAND_FILENAME = "vision.md";
export const COMMAND_MARKER = "deepseek-vl-support:command";

// Codex AGENTS.md managed block markers
export const AGENTS_START_MARKER = "<!-- deepseek-vl:start -->";
export const AGENTS_END_MARKER = "<!-- deepseek-vl:end -->";

export const GITIGNORE_ENTRY = ".deepseek-vl/";

// Agent Plugins portable package (src/plugin.ts)
export const PLUGIN_DIRNAME = "plugin"; // ~/.deepseek-vl/plugin/ (materialized plugin dir)
export const PLUGIN_REPO = "https://github.com/limccn/deepseek-vl-support";
export const PLUGIN_GITHUB_SLUG = "limccn/deepseek-vl-support";
// Cursor local plugin dir name + marker file inside it (uninstall only
// removes the directory when the marker is present)
export const CURSOR_PLUGIN_DIRNAME = "deepseek-vl-support";
export const CURSOR_PLUGIN_MARKER_FILE = ".deepseek-vl-managed";
export const CURSOR_PLUGIN_MARKER = "deepseek-vl-support:managed";

// Total vision budget inside the hook (hook timeout is 60s; leave a buffer)
export const HOOK_BUDGET_MS = 50_000;
