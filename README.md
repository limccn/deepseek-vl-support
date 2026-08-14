# deepseek-vl-support

> **中文说明** → [docs/README.zh-CN.md](./docs/README.zh-CN.md)

Give DeepSeek (text-only) models **vision** in Claude Code and Codex by routing
image files to any OpenAI-compatible vision endpoint (OpenRouter, SiliconFlow,
DashScope, Ollama, llama.cpp, vLLM, LM Studio, …). Zero runtime dependencies,
MIT licensed.

```
Model (DeepSeek)  Read foo.png
  → PreToolUse hook (node hook.cjs)
      → detects image → cache miss → POST {baseUrl}/chat/completions (base64)
  → block + additionalContext: "[Vision of foo.png]: <detailed description>"
  → model reasons from the description (the original Read is replaced by text)
```

## Features

- **Claude Code**: PreToolUse(Read) hook intercepts image files automatically and
  injects the vision endpoint's detailed description as `additionalContext`;
  SessionStart self-check; `/vision` slash command; Agent Skills skill.
- **Codex**: MCP stdio server (`describe_image` / `vision_status` tools) +
  AGENTS.md guidance + automatic models.json bug fix (openai/codex#36382,
  `supports_search_tool` hides all MCP tools).
- **Description cache**: `sha256+mtimeMs+size+model` key, 64MB LRU; re-reading
  the same image with the same model does not cost another API call.
- **Fallback chain**: on primary-model failure, degrade in order, sharing one
  overall time budget.
- **One-command install/uninstall**: numbered menu wizard, idempotent, `.bak`
  backups before writes, marker checks protect user-authored files.

## Requirements

- Node.js ≥ 18 (zero runtime dependencies, devDependencies only)
- An OpenAI-compatible vision endpoint (remote or local)

## Quick start

```bash
# Run inside the target project directory (interactive wizard)
npx deepseek-vl-support@latest install
# or, after installing to PATH:
deepseek-vl-support install
```

> Both commands are equivalent: `npx deepseek-vl-support@latest …` and the local
> `deepseek-vl-support …` after installation point to the same bin (the package
> ships a single bin entry named after the package: `deepseek-vl-support`).
> Note: run `npx deepseek-vl-support@latest …` OUTSIDE the package's own
> directory — inside it, the local package.json matches the spec, npx skips
> installation, and the cmd reports `'deepseek-vl-support' is not recognized`
> (a run-location issue, unrelated to the package contents).

The wizard confirms each step via a numbered menu (every step has a default,
Enter skips):

1. Target tool: `claude` / `codex` / `both` (default both)
2. Vision endpoint preset: OpenRouter → SiliconFlow → DashScope → Custom → Ollama → llama.cpp → vLLM → LM Studio
3. Endpoint address (base URL, OpenAI-compatible, ends with `/v1`)
4. API key (Enter to skip; written only to `.deepseek-vl/config.json`; `.gitignore` already gets `.deepseek-vl/`)
5. Vision model id (e.g. `qwen2.5vl:7b`)
6. Fallback models (optional, `model@baseUrl, model2` or a JSON array)
7. Install scope: project (`.claude/` `.codex/`) or global (`~/.claude` `~/.codex`)

Restart the session as prompted after installation:

- Claude Code: restart the session for the hook to take effect; afterwards,
  reading an image file automatically injects the vision description;
- Codex: restart the session and verify with `codex mcp list` that the
  `deepseek-vl` server is connected.

CI / non-interactive install (all parameters can be flags or environment variables):

```bash
npx deepseek-vl-support install --non-interactive \
  --target claude --preset openrouter \
  --base-url https://openrouter.ai/api/v1 --model qwen/qwen2.5-vl-72b-instruct \
  --api-key sk-... --fallbacks "qwen/qwen2.5-vl-72b-instruct@https://api.siliconflow.cn/v1"
# or export environment variables: VISION_BASE_URL VISION_MODEL VISION_API_KEY VISION_FALLBACKS DVLS_TARGET DVLS_SCOPE
```

Preview before committing:

```bash
npx deepseek-vl-support install --non-interactive --dry-run --target both
# Preview which files will be written, without actually writing
```

## Endpoint examples

| Endpoint | base URL | Example model |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen2.5-vl-72b-instruct` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5vl:7b` (run `ollama pull qwen2.5vl:7b` first) |
| llama.cpp (local) | `http://localhost:8080/v1` | `llava` (`llama-server -m llava.gguf`) |
| vLLM (local) | `http://localhost:8000/v1` | `deepseek-ai/deepseek-vl2` |
| LM Studio (local) | `http://localhost:1234/v1` | `qwen2.5-vl-7b-instruct` |

## Configuration

Resolution precedence (field-by-field override): environment variables `VISION_*`
> project `.deepseek-vl/config.json` > global `~/.deepseek-vl/config.json` >
defaults (`http://localhost:11434/v1`, timeout 120000ms, maxBytes 10MB,
enabled true).

```jsonc
// .deepseek-vl/config.json (modifiable via `deepseek-vl-support config set <key> <value>`)
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen2.5-vl-72b-instruct",
  "apiKey": "sk-...",                    // optional; lives only in .deepseek-vl/config.json
  "timeoutMs": 120000,                   // per-request timeout (fallback chain shares the total budget)
  "maxBytes": 10485760,                  // large-image limit: above it, skip and hint to compress/crop
  "fallbacks": [
    { "model": "Qwen/Qwen2.5-VL-72B-Instruct", "baseUrl": "https://api.siliconflow.cn/v1" },
    { "model": "qwen2.5vl:7b" }          // missing fields inherit the primary config
  ]
}
```

- **Large-image limit (maxBytes)**: default 10MB. Images above the limit are not
  described (the hook lets the Read through and hints to compress/crop; >2MB
  gets a soft warning). Lower it to save bandwidth:
  `deepseek-vl-support config set maxBytes 5242880`.
- **Fallback models**: on primary failure (network/HTTP/timeout/empty response),
  degrade in order; `model@baseUrl` comma syntax or a JSON array both work.
  `deepseek-vl-support doctor --all` diagnoses each entry.
- **Disable vision**: `VISION_DISABLE=1` or `enabled:false` → hook / MCP become no-ops.
- View/change config: `deepseek-vl-support config get [key]` / `deepseek-vl-support config set <key> <value>` /
  `deepseek-vl-support config path`.

## Usage

### Claude Code (automatic)

- Reading any image (png/jpg/jpeg/gif/webp/bmp) in a session → automatically
  injects `[Vision of <file>]: <description>`;
- `/vision <image path> [question...]` slash command for manual description;
- Agent Skills: the `deepseek-vision` skill, with an overridable prompt (project
  `.deepseek-vl/vision-prompt.md` > global > built-in default).

### Codex (MCP tools)

- `mcp__deepseek-vl__describe_image(path, question?)` — describes an image (with caching);
- `mcp__deepseek-vl__vision_status()` — configuration summary + endpoint health check;
- AGENTS.md gets the usage guidance injected; DeepSeek models cannot see images
  themselves, so ask them to call the tools above to obtain text descriptions.
- **Project-level installs require trusting the project first**: Codex only loads
  the MCP section of a project-level `.codex/config.toml` in trusted directories —
  untrusted directories silently ignore it (only user-level servers are visible),
  and non-interactive `codex exec` even refuses to run ("Not inside a trusted
  directory"). After a project-level install, trust the project in an interactive
  `codex` session first; for CI / non-interactive / untrusted scenarios use a
  `--global` install instead.

## Uninstall

```bash
deepseek-vl-support uninstall            # removes hook/skill/command/MCP registration, keeps config + cache
deepseek-vl-support uninstall --purge-config   # also deletes .deepseek-vl/ (config+cache) and the .gitignore entry
deepseek-vl-support uninstall --global --target codex
```

Only files carrying this tool's markers are removed; user-authored files (no
marker) are always skipped with a notice. All modifications are backed up as
`.bak` first.

## Troubleshooting

- **Windows garbled text / broken JSON**: the hook and CLI force UTF-8 output;
  on garbled terminals run `chcp 65001` or use Windows Terminal / the VS Code
  terminal (UTF-8 by default).
- **Hook timeout**: each Read's vision call has a total budget of 50 seconds
  (including the fallback chain). Slow endpoints or large images make the model
  wait longer; prefer lowering maxBytes or switching to a faster endpoint.
- **Codex cannot see `mcp__deepseek-vl__*` tools**: openai/codex#36382 — DeepSeek's
  models.json `supports_search_tool: true` hides all MCP tools. The installer
  fixes it automatically; manual fix: set `"supports_search_tool": false` for
  the DeepSeek entry in `~/.codex/models.json`.
- **Codex requires approval on first MCP tool call**: the first call to
  `mcp__deepseek-vl__*` in an interactive session shows an approval prompt —
  click Allow once (standard Codex behavior for all MCP servers, not specific to
  this tool); under non-interactive `codex exec` (approval_policy=never) MCP
  calls are cancelled automatically ("user cancelled MCP tool call") — use the
  CLI command `deepseek-vl-support describe <file>` in that scenario.
- **Reasoning models unusable**: DeepSeek v4-r1 / reasoning models do not support
  function calling (tool use). Codex config needs
  `[model_providers.deepseek] wire_api = "chat"` and a non-reasoning model;
  prefer a non-reasoning vision model on the vision side too.
- **Limitation of pasted images**: images pasted via Ctrl+V in Claude Code go
  through the edit/paste channel, not the Read hook, and cannot be described
  automatically. Save them as files and Read (or use the `/vision` command, or
  Codex's describe_image tool).
- **`[Unsupported Image]` fallback text**: when vision is disabled
  (VISION_DISABLE / enabled:false), the model only sees the placeholder text
  `[Unsupported Image]` when reading images (no crash), and will usually notice
  and suggest calling the `deepseek-vision` skill — follow the hint.
- **Image too large**: above maxBytes, description is skipped — compress or crop
  first (e.g. under 5 MB, ~2000px long edge).
- **Endpoint unreachable**: `deepseek-vl-support doctor` prints detailed
  diagnostics; confirm the base URL ends with `/v1` and the model id matches the
  `/v1/models` list (Ollama may use the `./qwen2.5vl:7b` form; comparison is
  normalized internally).

## Development

```bash
npm install            # devDeps: typescript esbuild @types/node
npm run build          # esbuild → dist/cli.js + dist/hook.cjs + assets/
npx tsc --noEmit       # typecheck
node --test tests/     # mock-based automated tests (requires a build first)
```

Real-endpoint E2E manual: `docs/e2e-real-endpoint.md`; release process:
`docs/releasing.md`.

## Acknowledgements

This project was inspired by [pi-deepseek-vision](https://github.com/psychobarge/pi-deepseek-vision).
Thanks to psychobarge for their open-source work.

## License

[MIT](LICENSE)
