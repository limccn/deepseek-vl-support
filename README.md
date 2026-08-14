# deepseek-vl-support

> **中文说明** → [docs/README.zh-CN.md](./docs/README.zh-CN.md)

## What this does

Some AI models (such as DeepSeek) are text-only: they can read your files, but
they cannot look at pictures. Screenshots of errors, UI mockups, charts — these
are invisible to such models.

This small tool gives them "eyes". Once installed, whenever the model tries to
read a picture, the tool sends that picture to a vision service of your choice
(Moonshot, OpenRouter, SiliconFlow, Ollama …), receives a detailed text
description, and hands that description to the model. The model then works from
the description, as if it could see the picture.

```
Model (DeepSeek)  Read screenshot.png
  → this tool intercepts the read
  → picture → your vision service → detailed text description comes back
  → the model receives: "[Vision of screenshot.png]: <detailed description>"
  → the model continues from the description
```

No model settings to change, no extra configuration files to write — it works
automatically after a one-time setup. One command to install, one command to
remove. MIT licensed.

## Who this is for

- You use **Claude Code** or **Codex** with a DeepSeek (or other text-only) model.
- You want that model to understand pictures: error screenshots, UI mockups,
  charts, photos of notes.

## Before you start (what you need)

1. **Node.js 18 or newer.** Check with `node -v` — if it prints a version number,
   you are ready. If not, install it from <https://nodejs.org>.
2. **An account at a vision service, and its API key.** The vision service is
   the "eyes provider" — a website that looks at pictures for you. Cloud options
   you can register for: **Moonshot**, **OpenRouter**, **MiniMax**,
   **Zhipu GLM**, **StepFun**, **OpenCode Zen**, **SiliconFlow**,
   **DashScope**. Free local options: **Ollama**, **llama.cpp**, **vLLM**,
   **LM Studio** (these run on your own computer). The **API key** is a secret
   code from that service (usually under "API keys" on its website). The
   installer asks for it once and stores it only on your computer.
3. Claude Code or Codex already installed.

## Install (about 2 minutes)

Open a terminal in **your project folder**:

```bash
cd path/to/your/project
npx deepseek-vl-support@latest install
```

A numbered menu appears and asks 7 questions. **Most have a sensible default —
just press Enter to accept it.**

| # | Question | What it means | Default |
|---|---|---|---|
| 1 | Which tool to enhance? | The AI tool you use: `claude` / `codex` / `both` | both |
| 2 | Vision endpoint preset | Which "eyes provider" to use — pick the one you have an account for (see the endpoint table below) | openrouter |
| 3 | Base URL | The address of that service (the preset fills this in) | from preset |
| 4 | API key | Your secret code for that service; stored only on your computer | Enter skips |
| 5 | Vision model id | Which "eyes" to use (the preset fills this in) | from preset |
| 6 | Fallback models | Backup "eyes" if the main one fails (optional) | Enter skips |
| 7 | Install scope | This project only, or all your projects | project |

When it finishes:

1. **Restart the session** — the installer prints this reminder, and it is
   required for the effect to kick in.
2. Optional check — run the health check and look for `[OK]`:

```bash
npx deepseek-vl-support@latest doctor
```

Preview before committing (prints what would be written, writes nothing):

```bash
npx deepseek-vl-support@latest install --dry-run
```

> Tip: run `npx deepseek-vl-support@latest …` from **your own project folder**.
> Running it inside this tool's own source folder hits a known npx quirk
> (`'deepseek-vl-support' is not recognized`) — a run-location issue, not a
> package problem.

## Try it out

Fastest check — describe a picture directly in the terminal:

```bash
npx deepseek-vl-support@latest describe path/to/a/picture.png
```

A good text description comes back → everything is wired up correctly.

From then on:

- **Claude Code**: read any picture in the session (png / jpg / jpeg / gif /
  webp / bmp) — the model automatically receives the description. Manually:
  `/vision path/to/picture.png "your question"`.
- **Codex**: ask the model to call `mcp__deepseek-vl__describe_image(path)`;
  `mcp__deepseek-vl__vision_status()` shows the current settings plus a health
  check.

## Choosing the endpoint (reference)

| Endpoint | base URL | Example model |
|---|---|---|
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-32k-vision-preview` |
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen2.5-vl-72b-instruct` |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-VL-01` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| StepFun | `https://api.stepfun.com/v1` | `step-1o-turbo-vision` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `mimo-v2.5-free` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5vl:7b` (run `ollama pull qwen2.5vl:7b` first) |
| llama.cpp (local) | `http://localhost:8080/v1` | `llava` (`llama-server -m llava.gguf`) |
| vLLM (local) | `http://localhost:8000/v1` | `deepseek-ai/deepseek-vl2` |
| LM Studio (local) | `http://localhost:1234/v1` | `qwen2.5-vl-7b-instruct` |

## Everyday commands (cheat sheet)

| What you want | Command |
|---|---|
| Install | `npx deepseek-vl-support@latest install` |
| Health check | `npx deepseek-vl-support@latest doctor` (add `--all` to check fallbacks too) |
| Describe a picture now | `npx deepseek-vl-support@latest describe picture.png` |
| See current settings | `npx deepseek-vl-support@latest config get` |
| Change a setting | `npx deepseek-vl-support@latest config set maxBytes 5242880` |
| Remove the tool | `npx deepseek-vl-support@latest uninstall` |
| Remove + delete settings too | `npx deepseek-vl-support@latest uninstall --purge-config` |

## Changing settings

Your answers are saved in `.deepseek-vl/config.json` inside the project folder.
Usually you never need to touch it. The two settings worth knowing:

| Setting | Meaning | Default |
|---|---|---|
| `maxBytes` | Pictures bigger than this are skipped (saves time and money) | 10485760 (10 MB) |
| `timeoutMs` | How long to wait for one description | 120000 (2 minutes) |

Example — skip pictures over 5 MB:

```bash
npx deepseek-vl-support@latest config set maxBytes 5242880
```

Describing the same picture twice is free: results are cached on your machine
(64 MB limit). Change the picture and it gets described again.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The model still doesn't describe pictures | 1) Restart the session (required after install). 2) Run `… doctor` and look for `[OK]`. |
| `doctor` shows "unreachable" or no `[OK]` | The service address or key is wrong: check the base URL ends with `/v1` and the API key is correct. (If the service hides its model list, `doctor` shows a warning instead — that is fine as long as it says reachable.) |
| "image too large" hint | The picture exceeds the limit — compress or crop it (e.g. under 5 MB, long side ~2000 px), or raise the limit with `config set maxBytes …`. |
| Descriptions are slow | Lower the limit (`config set maxBytes 5242880`) or switch to a faster endpoint. |
| Pasted (Ctrl+V) pictures are not described | Pasted images bypass the read path — save the picture as a file first, then read it (or use `/vision` / `describe_image`). |
| Codex: `mcp__deepseek-vl__*` tools not visible | A known Codex bug hides them. The installer fixes it automatically; manual fix: in `~/.codex/models.json` set `"supports_search_tool": false` for the DeepSeek entry. |
| Codex asks for approval on the first tool call | Normal for any MCP server — click Allow once. In non-interactive `codex exec`, use `deepseek-vl-support describe <file>` instead. |
| Windows terminal shows garbled text | Run `chcp 65001`, or use Windows Terminal / the VS Code terminal. |
| DeepSeek v4-r1 / reasoning models unusable | Reasoning models cannot call tools. In Codex use `[model_providers.deepseek] wire_api = "chat"` plus a non-reasoning model; prefer a non-reasoning vision model too. |
| Nothing happens and the model sees `[Unsupported Image]` | Vision is switched off (`VISION_DISABLE=1` or `enabled: false` in the config) — turn it back on to use vision. |

## Advanced (optional)

Full settings example (`.deepseek-vl/config.json`, editable via
`deepseek-vl-support config set <key> <value>`):

```jsonc
{
  "baseUrl": "https://api.moonshot.cn/v1",
  "model": "moonshot-v1-32k-vision-preview",
  "apiKey": "sk-...",                    // optional; lives only in .deepseek-vl/config.json
  "timeoutMs": 120000,                   // per-request timeout (fallbacks share the total budget)
  "maxBytes": 10485760,                  // pictures above this are skipped
  "fallbacks": [
    { "model": "Qwen/Qwen2.5-VL-72B-Instruct", "baseUrl": "https://api.siliconflow.cn/v1" },
    { "model": "qwen2.5vl:7b" }          // missing fields inherit the primary config
  ]
}
```

- **Fallbacks**: if the main service fails (network error / timeout / empty
  answer), the tool retries with the next one, in order, sharing one time
  budget. `doctor --all` checks each entry.
- **Environment variables** override the file (field by field): `VISION_BASE_URL`,
  `VISION_MODEL`, `VISION_API_KEY`, `VISION_FALLBACKS`, `DVLS_TARGET`,
  `DVLS_SCOPE`.
- **Non-interactive / CI install** (no menu; all answers as flags):

```bash
npx deepseek-vl-support@latest install --non-interactive \
  --target both --preset custom \
  --base-url https://api.moonshot.cn/v1 --model moonshot-v1-32k-vision-preview \
  --api-key sk-... --fallbacks "qwen/qwen2.5-vl-72b-instruct@https://openrouter.ai/api/v1"
```

## For developers

```bash
npm install            # devDeps only: typescript esbuild @types/node
npm run build          # esbuild → dist/cli.js + dist/hook.cjs + assets/
npx tsc --noEmit       # typecheck
node --test tests/     # mock-based automated tests (requires a build first)
```

Real-endpoint E2E manual: `docs/e2e-real-endpoint.md`; release process:
`docs/releasing.md`.

## Acknowledgements

This project was inspired by
[pi-deepseek-vision](https://github.com/psychobarge/pi-deepseek-vision) — thanks
to psychobarge for the open-source work.

## License

[MIT](LICENSE)
