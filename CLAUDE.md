# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

DeepSeek (and other text-only) models cannot see images. This package gives them vision:
whenever the model reads a picture, a vision service (any OpenAI-compatible
`/v1/chat/completions` endpoint) describes it and the text description is injected into the
model's context. Zero runtime dependencies, Node ≥ 18, MIT. `README.md` is the user-facing
product doc (do not duplicate it here); `docs/README.zh-CN.md` is its Chinese counterpart.

One config feeds **five surfaces**:
1. `describe` CLI — `npx @limccn/deepseek-vl-support describe <file> [question] [--json]`
2. **Claude Code hook** — `dist/hook.cjs` copied to `.claude/hooks/`, wired via
   `PreToolUse(Read)` + `SessionStart` entries in `.claude/settings.json`; a `/vision`
   slash command and a `deepseek-vision` skill are also installed
3. **MCP server** — `deepseek-vl` stdio server with tools `describe_image` and
   `vision_status` (launched as `npx -y @limccn/deepseek-vl-support mcp`)
4. **Skill** — `deepseek-vision` Agent Skills product (5 byte-identical copies; see
   AgentSkills conformance below)
5. **Native plugins** — pi/omp extension (`extensions/deepseek-vision.ts`) and dsh cordis
   plugin (`dist/dsh-plugin.js` + `cordis.patch.yml`)

## Repo layout (key files)

- `src/cli.ts` — CLI entry: `install | uninstall | describe | doctor | config | mcp | version`
- `src/install.ts` — installer wizard + all per-target artifact writes (22 targets)
- `src/plugin.ts` — Agent Plugins payload materialization + 10 client registrations; display
  labels in `AGENT_LABELS`
- `src/cliagents.ts` — native CLI-agent installs (qwen / reasonix / kilo / workbuddy / devin)
- `src/skillagents.ts` — skill installs (trae / pi / omp / dsh)
- `src/config.ts` — config load/merge/precedence + endpoint presets; `src/client.ts` —
  vision client + fallback chain + size guard; `src/cache.ts` — disk cache
- `src/hook.ts` / `src/hooksettings.ts` — hook logic + settings.json entries
- `src/mcp.ts` — MCP server; `src/dsh-plugin.ts` — dsh cordis plugin entry
- `src/identity.ts` — artifact marker strings (managed-file recognition)
- `build.mjs` — esbuild: `dist/cli.js` (ESM, shebang) + `dist/hook.cjs` (standalone CJS,
  zero deps, banner `/*! deepseek-vl-support-hook */`) + `dist/dsh-plugin.js`; copies
  `assets/SKILL.md` → `skills/deepseek-vision/SKILL.md` and `mcp.json` → `.mcp.json`
- Root `plugin.json` / `mcp.json` / `.mcp.json` / `marketplace.json` / `cordis.patch.yml` —
  Agent Plugins v1.0.0 + dsh payload, **committed to git** (the repo is the plugin install
  source for Copilot/Hermes and dsh git installs)
- `docs/` — user docs (`README.zh-CN.md`, `banner/`); not packaged into the npm tarball

## Commands

```bash
npm run build       # build.mjs → dist/ + skills/ + .mcp.json (required before tests)
npm run typecheck   # tsc --noEmit
npm run test        # node --test "tests/*.test.ts" (mock-based; run build first)
npm run verify      # build + typecheck + test
node --test tests/install.test.ts        # single test file
node dist/hook.cjs </dev/null            # hook self-contained check → prints {} exit 0
npm pack --dry-run                       # tarball manifest check (see Release process)
```

Known gotcha: running `npx -y @limccn/deepseek-vl-support@<ver> …` **inside this repo's own
directory** matches the local package.json, npx skips the download, and cmd reports
`'deepseek-vl-support' is not recognized` — a run-location artifact. Smoke-test outside the
package dir (e.g. under `%TEMP%`). A stale global install (`npm ls -g @limccn/deepseek-vl-support`)
can likewise shadow npx and run an OLD version silently.

## Configuration

Files: project `.deepseek-vl/config.json`, global `~/.deepseek-vl/config.json`.

| Field | Meaning | Default |
|---|---|---|
| `baseUrl` | vision service address | openrouter preset |
| `model` | vision model id | from preset |
| `apiKey` | secret key (masked in `config get` output) | none |
| `timeoutMs` | per-request timeout; fallbacks share the total budget | 120000 |
| `maxBytes` | images above this are skipped | 10485760 (10 MB) |
| `fallbacks` | `[{model, baseUrl}]` — retried in order when the primary fails | none |
| `enabled` | `false` = vision off entirely (same as `VISION_DISABLE`) | true |

Env vars apply to **all** surfaces and need no re-install after changing: `VISION_BASE_URL`,
`VISION_MODEL`, `VISION_API_KEY`, `VISION_TIMEOUT_MS`, `VISION_MAX_BYTES`,
`VISION_FALLBACKS` (`model@baseUrl` comma-separated), `VISION_DISABLE` (`1`/`true`).
Install-time env: `DVLS_TARGET`, `DVLS_SCOPE` behave like `--target`/`--scope`.

Precedence: `VISION_*` env > project `config.json` > global `config.json` > built-in defaults.

Cache: `.deepseek-vl/cache/<sha256-of-image>.json` (64 MB cap), keyed on content — editing a
file re-describes it. Cache lives in the same dir as the config file that was read.

Endpoint presets: openrouter (default), moonshot, minimax, zhipu, stepfun, opencodezen,
siliconflow, dashscope, ollama, llamacpp, vllm, lmstudio; `later` = skip endpoint config
("Decide later" — everything else installs, doctor reports model not set).

## Agent targets (22)

`--target` accepts a comma-separated list; the wizard defaults to `claude,codex` plus the
agents detected on this machine. Idempotent re-install; marker-based uninstall; every file
write deep-merges JSON, backs the target up to `<file>.bak` before the first change, and
never touches user files lacking our marker.

**Native agents** (project or global scope; scope question only for these):

| Target | What the installer does |
|---|---|
| `claude` | `.claude/settings.json` PreToolUse(Read) + SessionStart entries + hook copy + `/vision` command + skill |
| `codex` | `.codex/config.toml` MCP section (pins `@limccn/deepseek-vl-support@<version>`, `tool_timeout_sec = 180`) + AGENTS.md block + `~/.codex/models.json` fix (`supports_search_tool: false` for the DeepSeek entry — a known Codex bug hides MCP tools without it) + project `.agents/skills/` write (project scope only) |
| `opencode` | `opencode.json` `mcp.deepseek-vl` (`type: local`, `npx -y … mcp`) + `.agents/skills/` |
| `qwen` | `.qwen/skills/deepseek-vision/` + `settings.json` mcpServers + PreToolUse hook (`node "<abs path to hook.cjs>"`); global `~/.qwen/`; a JSONC settings.json is reported manual (bytes untouched) |
| `reasonix` | `.agents/skills/` + project `.mcp.json` + `.reasonix/settings.json` hook; global writes a `[[plugins]]` block to `~/.reasonix/config.toml` + `~/.agents/skills/` |
| `kilo` | `.agents/skills/` + `.kilo/kilo.json` `mcp.deepseek-vl` (command as an **array**); global probes `~/.config/kilo/kilo.json` then `.jsonc` |
| `workbuddy` | `.codebuddy/skills/deepseek-vision/` + project `.mcp.json` (`type: stdio`); global `~/.codebuddy/.mcp.json` |
| `devin` | `.agents/skills/` + `.devin/mcp_config.json`; global `%APPDATA%\devin` (win32) / `~/.config/devin` (posix); no official npm package — `https://devin.ai/download` |

**Skill agents** (project scope only, never trigger the scope question): `trae`
(`.trae/skills/deepseek-vision/` + manual import guidance — IDE, no CLI automation),
`pi` (shared `.agents/skills/` skill; prefers `pi install npm:@limccn/deepseek-vl-support` — user
skill + native extension; writes `mcpServers` to `~/.pi/agent/mcp.json` only when the
pi-mcp-adapter extension is detected), `omp` (shared skill, rank 70; prefers
`omp install npm:@limccn/deepseek-vl-support` — skill + auto MCP from `.mcp.json` + extension,
activate with `/reload-plugins`), `dsh` (shared skill, rank 200; prefers
`dsh plugin --profile web add @limccn/deepseek-vl-support@latest` — native describe_image +
vision_status tools via cordis patch).

**Plugin clients** (always global; materialize `~/.deepseek-vl/plugin/` = exactly
`plugin.json` + `mcp.json` + `.mcp.json` + `skills/`, then register): `copilot`
(`copilot plugin install` + marketplace add, or `enabledPlugins` in `~/.copilot/settings.json`
when no CLI), `cursor` (copy to `~/.cursor/plugins/local/deepseek-vl-support/`, marked),
`kiro` (manual — Powers panel import), `openclaw` (`openclaw plugins install` + gateway
restart), `hermes` (`hermes plugins install limccn/deepseek-vl-support --no-enable` + enable),
`vscode` (`chat.pluginLocations["~/.deepseek-vl/plugin"] = true` in user settings.json, `.bak`
backed), `chatgpt-codex` (marketplace shim at `~/.deepseek-vl/marketplace/` + `codex plugin
marketplace add` + `codex plugin add`; uninstall keeps the registration), `grok`
(`grok plugin install ~/.deepseek-vl/plugin --trust`; no CLI → manual guidance mentioning
`~/.grok/plugins/`; unconfirmed whether Grok reads `mcp.json` or only its dot-convention
`.mcp.json` — record on a real machine), `nanoclaw` (template copy to
`~/.deepseek-vl/nanoclaw-templates/` — always a copy, NanoClaw rejects symlinks — + `ncl
groups create --template deepseek-vl-support --name "DeepSeek Vision"` with
`NANOCLAW_TEMPLATES_DIR` set; stamping does not wire a channel, tasks start paused;
**uninstall is manual** — NanoClaw has no plugin uninstall, delete the stamped group to
clean up), `other` (materialize + generic guidance for any spec-compliant agent).

One client failing never blocks the others — each is reported separately. Plugin clients
read **global** config only (`~/.deepseek-vl/config.json` / `VISION_*` env); a project-local
`.deepseek-vl/config.json` is invisible to their MCP subprocesses — use
`config set <key> <value> --global` instead.

Uninstall ownership: `uninstall --target <agent>` removes that agent's artifacts but
**keeps** the shared `.agents/skills/deepseek-vision/` tree (other agents may use it);
only `--target codex` removes the shared tree. `qwen`/`workbuddy` also remove their own
skill copies and hooks. Plugin uninstall keeps the materialized dir unless `--purge-config`.

## Non-interactive / CI install

```bash
npx @limccn/deepseek-vl-support@latest install --non-interactive \
  --target claude,codex --preset custom \
  --base-url https://api.moonshot.cn/v1 --model moonshot-v1-32k-vision-preview \
  --api-key sk-... --fallbacks "qwen/qwen2.5-vl-72b-instruct@https://openrouter.ai/api/v1"
# skip endpoint config entirely:
npx @limccn/deepseek-vl-support@latest install --non-interactive --target opencode --preset later
```

`--dry-run` prints what would be written, writes nothing. `--update` refreshes managed
artifacts, backs up hand-written skill files to `<file>.bak` before replacing them, and skips
the keep/overwrite questions. The keep/overwrite wizard prompts (config exists / skill file
exists) are interactive-only — non-interactive runs deep-merge config and follow the managed-
file rules silently. `--preset later` never asks anything. Legacy `--clients copilot,cursor`
filters plugin agents in non-interactive runs.

## E2E: real-endpoint manual (was docs/e2e-real-endpoint.md)

Mock tests cover the pipeline; this validates against a REAL vision endpoint. Run once per
release in a clean directory. Prereqs: Node ≥ 18, a real OpenAI-compatible endpoint key, and
`npm run build`.

1. **Clean-room install**: `mkdir -p ~/tmp/dvls-e2e && cd ~/tmp/dvls-e2e && rm -rf project &&
   mkdir project && cd project`, then
   `npx @limccn/deepseek-vl-support install --non-interactive --target claude,codex --preset openrouter
   --api-key $OPENROUTER_API_KEY`. Verify with `--dry-run` first (predictable); then
   `ls -R .deepseek-vl .claude .codex .gitignore` and confirm `.gitignore` contains `.deepseek-vl/`.
2. **Config + doctor**: `config get` (key masked); `doctor` → `[OK]` endpoint reachable +
   model found, exit 0; `doctor --all` → per-entry fallback diagnostics. A `/v1/models`
   404/405 degrades to a warning (not a failure); network errors / missing model exit 1.
3. **describe**: `describe some/screenshot.png` (detailed description: visible text/UI/colors/
   errors), `describe … "What error message is shown?"` (question forwarded as the text part),
   `describe --json …` (contains `text/model/fromFallback`).
4. **Cache hit**: first call hits the API, second is a cache hit (0 API calls);
   `.deepseek-vl/cache/<sha256>.json`; `touch` the file → API called again.
5. **Claude Code e2e**: confirm `.claude/settings.json` has the hook entries; restart the
   session; read a screenshot → model receives `[Vision of <file>]:` description and answers
   from it (oversized/failed images still Read, hint on stderr); `/vision <path> describe
   this` triggers manually.
6. **Codex e2e**: `codex mcp list` shows `deepseek-vl` connected; if tools invisible, check
   the models.json fix (§Agent targets); ask the model to call
   `mcp__deepseek-vl__describe_image(<path>)`; `mcp__deepseek-vl__vision_status` self-checks.
   Non-interactive `codex exec` needs `--dangerously-bypass-approvals-and-sandbox` and, when
   the project is not in `~/.codex/config.toml` trust list, `-c` MCP overrides
   (`-c 'mcp_servers.deepseek-vl.command="npx"' -c 'mcp_servers.deepseek-vl.args=["-y",
   "@limccn/deepseek-vl-support@<ver>", "mcp"]' -c 'mcp_servers.deepseek-vl.tool_timeout_sec=180'`).
7. **Fallback chain** (optional): `config set fallbacks '{"model":"Qwen/Qwen2.5-VL-72B-Instruct",
   "baseUrl":"https://api.siliconflow.cn/v1"}'`, break the primary
   (`config set baseUrl http://127.0.0.1:1/v1`), describe → automatic fallback success, restore.
8. **Cleanup**: `uninstall --purge-config`; `git status` clean again.

### Agent Plugins E2E (10 clients)

Once per release on machines that have the clients. `npm run build` first; install with
`--target copilot,cursor,kiro,openclaw,hermes,vscode,chatgpt-codex,grok,nanoclaw,other
--preset openrouter --api-key $OPENROUTER_API_KEY`. Menu shows one multi-select of all 12
agents; undetected plugin clients are flagged `(not detected — manual instructions)`; scope
question is skipped when only plugin agents are selected. Check
`ls ~/.deepseek-vl/plugin/` shows exactly 4 entries.

Verification records live in git history (pre-0.2.9 releases recorded real-machine results in
this doc's predecessor). Current standing, as of 0.2.8 (2026-08-19):

**Pass criteria** (full release gate): steps 1–4 match expectations (doctor exit 0, describe
returns a real description, cache hit costs 0 API calls); in a Claude Code session the model
answers from the injected description; `codex mcp list` shows the server and describe_image
works; for every plugin client present on the test machine the skill is discoverable and a
real describe_image call succeeds (incl. the Copilot session-level R4 check on an
authenticated machine), bare `npx` launch is confirmed per client (§9.6 — or the risk
triggered for a client is documented), R2 uninstall command names are confirmed, and the
new-client behaviors (VS Code settings entry + `.bak`, Grok `.mcp.json` caveat, chatgpt-codex
marketplace shim + uninstall keeps registration, NanoClaw template copy / no symlinks,
`other` guidance) are recorded; no leftovers in the directory after uninstall.

- **Done**: repo-as-install-source works (`copilot plugin install <repo>`, version from repo
  `plugin.json`); MCP stdio handshake (`initialize` → serverInfo, `tools/list` →
  `[describe_image, vision_status]`); npm tarball manifest; copilot MCP discovery
  (plugin-sourced server listed); codex / copilot / pi / omp / dsh real-machine e2e (dsh
  both npm + git source; pi 0.84.2 `read` interception incl. the ENAMETOOLONG fix; omp 17.3.7
  with `bun` runtime note: a machine with omp but no bun needs `npm i -g bun`).
- **Still user-owned TODOs**: interactive session-level checks for Copilot (this machine's
  account gets CAPIError 400 — model authorization issue, not the plugin), Kiro/OpenClaw/
  Hermes/Grok/NanoClaw client machines, uninstall command names R2 (`openclaw plugins
  uninstall`, `hermes plugins uninstall` — implemented from CLI conventions, unconfirmed),
  VS Code settings entry behavior on a real machine.

Known risk §9.6 (R3): bare `npx` in `mcp.json`/`.mcp.json` (`command: "npx"`, `args: ["-y",
"@limccn/deepseek-vl-support", "mcp"]`) fails with ENOENT when a client spawns MCP stdio with
`shell: false` (raw CreateProcess without PATHEXT on Windows) — decision was to keep bare
`npx` (documented KNOWN RISK; user env is assumed to have npm/npx). Record per client
`<client>: npx launch OK` on its real machine.

## Release process (was docs/releasing.md)

`npm publish` from this machine is manual; a published GitHub release also triggers the
dual-publish workflow (`.github/workflows/publish.yml` → npmjs + GitHub Packages).
**0.2.x unscoped** (`deepseek-vl-support` on npmjs) is a **frozen legacy channel** —
published only manually (temporary rename → build → publish → revert), never by the workflow.

1. **Version bump**: `npm version <major|minor|patch>`. Four manual version constants must
   match package.json (plugin.test.ts asserts the static files; the src constants are manual):
   `VERSION` in `src/cli.ts`, `SERVER_VERSION` in `src/mcp.ts`, `"version"` in root
   `plugin.json`, `"version"` in `marketplace.json` (both `metadata.version` and
   `plugins[0].version`). Then `npm run build` (regenerates `skills/` + `.mcp.json`) and
   `node --test "tests/plugin.test.ts"`. **Commit the regenerated `skills/deepseek-vision/SKILL.md`
   and `.mcp.json` with the bump** — the git repo IS the plugin install source (dist/ is not
   committed, except `dist/dsh-plugin.js` which git installs of dsh need).
   Keep the single bin entry named after the package
   (`"bin": { "deepseek-vl-support": "dist/cli.js" }`).
2. **All green**: `npm run build && npx tsc --noEmit && node --test "tests/*.test.ts"`.
3. **Pack manifest**: `npm pack --dry-run`. Must contain: `dist/cli.js`, `dist/hook.cjs`,
   `dist/dsh-plugin.js`, `assets/`, `extensions/deepseek-vision.ts` (shipped as TS source,
   NOT bundled — pi/omp load it via jiti), `skills/deepseek-vision/SKILL.md`,
   `plugin.json`, `mcp.json`, `.mcp.json` (byte-identical to mcp.json), `README.md`,
   `LICENSE`. `marketplace.json` intentionally NOT packaged (repo-only, for Copilot
   marketplace installs). Must NOT contain: `tests/`, `.trellis/`, `node_modules/`, `src/`,
   `docs/` (npm force-includes root-level `README*` regardless of `files` — localized
   READMEs must stay under docs/), temp files. Check the `pi` manifest key
   (`extensions`/`skills` + `pi-package` keyword) and `dsh` key
   (`bundle.patch: ./cordis.patch.yml` + `dsh-plugin` keyword + `main: ./dist/dsh-plugin.js`)
   survive the build; `dist/dsh-plugin.js` must keep `@deepseek-ai/dsh-tools` as a bare
   import (the dsh profile closure injects it). Verify `node dist/hook.cjs </dev/null`
   prints `{}` and exits 0.
4. **Publish**: `npm publish --dry-run` first, then `npm publish --access public`
   (scoped packages default to private — `--access public` is required on first publish).
   On `E403 Two-factor authentication … is required to publish`: the
   terminal prompts for a 6-digit OTP and retries; if it still fails, use a granular access
   token with "Bypass two-factor authentication in automated environments" and
   `npm config set //registry.npmjs.org/:_authToken <token>`. GitHub Packages (if used)
   is published from `.github/workflows/publish.yml` on a release; its first publish
   defaults to private — flip to public in the package settings page.
5. **Post-publish smoke** (in a SEPARATE directory outside the package, e.g. under `%TEMP%`):
   `npx -y @limccn/deepseek-vl-support@<version> version`, then in a configured project
   `npx -y @limccn/deepseek-vl-support@<version> doctor`. Refresh a stale global install
   (`npm i -g @limccn/deepseek-vl-support@latest`) — it can silently shadow npx and run an
   old version with plausible output.

**Rollback**: npm cannot delete versions — `npm deprecate @limccn/deepseek-vl-support@<ver> "broken —
use <new-version> instead"`. Installer writes `.bak` backups before every write; `uninstall`
reverses by marker; config/cache are kept so reinstalling restores. Codex's config.toml MCP
section pins the version — after upgrading, re-run `install --update` to refresh it.

**Pre-release self-check**:
- [ ] mock tests green; version sync (4 constants); `skills/` + `.mcp.json` regenerated and committed
- [ ] real-endpoint E2E passes once for describe + doctor
- [ ] `describe --data-uri "data:image/png;base64,<1px png>"` smoke in a configured project
- [ ] dsh real-machine e2e (user-owned): npm + git sources install, `deepseek-vl` layer in
      `dsh --profile web --dump-config`, describe_image/vision_status called in a real LLM
      session; `remove` + restart cleans up
- [ ] codex / copilot real-machine e2e (user-owned; this machine's sandbox blocks elevated
      session tool calls and the cc-switch proxy returns 400 on DeepSeek thinking-mode —
      unrelated to the package)
- [ ] pi/omp real-machine e2e (user-owned): extension interception (paste/drag, `read` →
      `[Vision: …]`, `/vision`), omp MCP auto-registration; extension must never pass a
      base64 data URI as spawn argv (Windows 32 KB / Linux 128 KB argv caps → ENAMETOOLONG;
      decode to a temp file, pass the path, delete in finally)
- [ ] install-wizard keep/overwrite e2e (user-owned): menus appear with existing
      config/skill; `Overwrite` on a hand-written skill backs up to `.bak`; `--update`
      refreshes without asking; non-interactive runs keep existing config silently
- [ ] spike findings persisted: the hook's plan-A design (`block` + `additionalContext`
      visible to the model in Claude Code) is recorded where a future maintainer can find it
- [ ] `npm pack --dry-run` manifest matches, no secrets (`~/.deepseek-vl` never packs)

## Maintenance conventions

- **Managed files carry markers** (`src/identity.ts`: SKILL_MARKER, COMMAND_MARKER, …).
  Never overwrite/delete a user-authored file that lacks our marker; back up first writes
  to `<file>.bak`; uninstall only removes marked artifacts.
- **AgentSkills conformance** (enforced by tests/plugin.test.ts): `name: deepseek-vision`
  kebab-case and identical to the parent dir name; `description` 1–1024 chars with trigger
  words; `allowed-tools: Bash Read` space-separated (NO commas); the frontmatter comment
  marker line is retained by design (valid YAML, uninstall relies on the marker); the 5
  SKILL.md copies (src/assets, assets/, skills/deepseek-vision/, .agents/skills/deepseek-vision/,
  installed) are byte-identical, and `references/vision-prompt.md` must ship alongside —
  build + installer keep them in sync.
- **Wizard UX rules** (R5): pure-name labels (no detection annotations), project scope
  recommended, "Decide later" preset last option; undetected selected agents are flagged
  non-blockingly with an install hint.
- **Windows shim probe order** (0.2.1 regression): npm global installs create three shims
  per CLI (`x`, `x.cmd`, `x.ps1`); probe `.exe` → `.cmd` → `.bat` → extensionless last
  (PATHEXT-consistent). Extensionless-first breaks raw `spawn` on every Windows machine.
