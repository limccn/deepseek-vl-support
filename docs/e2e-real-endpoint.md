# Real-endpoint E2E manual

Automated tests use a mock server; this manual validates against a REAL
vision endpoint (D5). Run it once per release in a clean directory.

## 0. Prerequisites

- Node ≥ 18 (`node -v`)
- An OpenAI-compatible vision endpoint with a working key (examples use
  OpenRouter; other endpoints take identical parameters)
- This repo already built: `npm run build`

## 1. Clean-room install

```bash
mkdir -p ~/tmp/dvls-e2e && cd ~/tmp/dvls-e2e
rm -rf project && mkdir project && cd project
npx deepseek-vl-support install --non-interactive \
  --target claude,codex --preset openrouter \
  --api-key $OPENROUTER_API_KEY
```

Verify (dry-run first, predictable results):

```bash
npx deepseek-vl-support install --dry-run --non-interactive --target claude,codex --preset openrouter
# [dry-run] ... preview only, nothing is written
ls -R .deepseek-vl .claude .codex .gitignore   # generated as expected
cat .gitignore                                  # contains .deepseek-vl/
```

## 2. Config + doctor

```bash
deepseek-vl-support config get          # confirm baseUrl/model/apiKey (key is masked)
deepseek-vl-support doctor              # expect [OK] endpoint reachable + model found, exit code 0
deepseek-vl-support doctor --all        # per-entry fallback chain diagnostics
```

When the endpoint does not implement `/v1/models` (404/405), doctor degrades to
a warning instead of failing; network errors / missing model exit with code 1.

## 3. describe — single-image description (CLI)

```bash
deepseek-vl-support describe some/screenshot.png
deepseek-vl-support describe some/screenshot.png "What error message is shown?"
deepseek-vl-support describe --json some/screenshot.png
```

Checkpoints: the output is a detailed description (visible text/UI/colors/errors);
the question is forwarded as the text part; `--json` contains `text/model/fromFallback`.

## 4. Cache hit

```bash
deepseek-vl-support describe --json some/screenshot.png   # first run: calls the API
deepseek-vl-support describe --json some/screenshot.png   # second run: cache hit
ls .deepseek-vl/cache/                            # <sha256>.json; content is the description text
touch some/screenshot.png && deepseek-vl-support describe some/screenshot.png   # file changed → API called again
```

## 5. Claude Code end-to-end

Run inside a clean directory against a Claude Code project:

1. Confirm `.claude/settings.json` contains the PreToolUse(Read) and SessionStart
   entries (`node .claude/hooks/deepseek-vision-hook.cjs`).
2. Restart the session (the SessionStart hook prints diagnostics).
3. Read a screenshot in the session:
   - expect the model to receive the injected `[Vision of <file>]:` description
     and answer from it (the plan-A check point, see spike notes);
   - when the image is too large or the endpoint fails, the Read still runs and
     stderr carries the hint.
4. `/vision path/to/image.png describe this` slash command triggers manually.

## 6. Codex end-to-end

1. `codex mcp list` → confirm the `deepseek-vl` server is listed (connected).
2. If tools are not visible → check the models.json fix (the DeepSeek entry in
   `~/.codex/models.json` should have `supports_search_tool: false`; the
   installer handles this automatically).
3. In the session ask: "use mcp__deepseek-vl__describe_image on <path>, then
   analyze the screenshot from the description".
4. `mcp__deepseek-vl__vision_status` self-checks the endpoint and model.

## 7. Fallback chain (optional)

```bash
deepseek-vl-support config set fallbacks '{"model":"Qwen/Qwen2.5-VL-72B-Instruct","baseUrl":"https://api.siliconflow.cn/v1"}'
deepseek-vl-support config set baseUrl http://127.0.0.1:1/v1   # deliberately break the primary
deepseek-vl-support describe some/screenshot.png               # expect automatic fallback success
deepseek-vl-support config set baseUrl https://openrouter.ai/api/v1   # restore
```

## 8. Cleanup

```bash
deepseek-vl-support uninstall --purge-config    # remove all artifacts + config/cache
git status                              # the project directory should be clean again
```

## 9. Agent Plugins (10 clients)

Run once per release on machines that actually have the client installed.
Prerequisite: the real endpoint configured (see step 0) and `npm run build`.

```bash
npx deepseek-vl-support install --target copilot,cursor,kiro,openclaw,hermes,vscode,chatgpt-codex,grok,nanoclaw,other --preset openrouter --api-key $OPENROUTER_API_KEY
# menu: one multi-select list of all 12 agents (claude + codex native,
# 10 plugin clients); plugin agents not detected on this machine are
# flagged "(not detected — manual instructions)"; scope is skipped when
# only plugin agents are selected (they are always global)
ls ~/.deepseek-vl/plugin/            # plugin.json + mcp.json + .mcp.json + skills/ (exactly 4 entries)
```

### 9.0 Final release verification record (2026-08-14, this machine)

- [x] Repo-as-install-source: `copilot plugin install
      https://github.com/limccn/deepseek-vl-support` against the pushed
      12-agent commit (a591dd8) → "Installed 1 skill", version 0.2.0
      (Copilot CLI 1.0.59). Direct repo/URL installs print a deprecation
      warning — marketplace is the future path (official copilot-plugins
      marketplace PR stays out of scope).
- [x] MCP stdio handshake on the final code: `initialize` →
      serverInfo `{name: deepseek-vl-support, version: 0.2.0}`;
      `tools/list` → `[describe_image, vision_status]`; clean exit 0.
      (Launched with shell resolution — the §9.6 raw-spawn risk remains a
      per-client real-machine item.)
- [x] `npm pack --dry-run`: tarball contains `plugin.json`, `mcp.json`,
      `.mcp.json`, `skills/deepseek-vision/SKILL.md`, `assets/`, `dist/`;
      excludes `marketplace.json`, `tests/`, `src/`, `docs/`, `.trellis/`.
- [ ] Still open after the 0.2.1 run: §9.1 session-level R4 check (copilot
      IS signed in on this box, but the account's model returns CAPI 400 —
      see §9.0.1), §9.2–9.5 and 9.7–9.10 client machines, R2 uninstall
      command names.

### 9.0.1 0.2.1 record — R5 fix + real-machine re-verification (2026-08-14)

Endpoint used throughout: **Moonshot** `https://api.moonshot.cn/v1`,
model `moonshot-v1-32k-vision-preview` (12 models listed by `/models`).
`doctor` timed out twice on first contact (120s abort); every immediate
retry succeeded — recorded as an environment note (cold CDN path), not a
defect.

- [x] **0.2.1 published** (R5 fix, see below): `npm run verify` 102/102
      green; `npm pack --dry-run` → 14 files, version 0.2.1, manifest
      matches the whitelist; registry `npm view deepseek-vl-support
      version` → `0.2.1`; post-publish smoke outside the package
      (`npx -y deepseek-vl-support@0.2.1 version` → 0.2.1); stale global
      install refreshed to 0.2.1. 0.2.0 stays published (deprecate is the
      maintainer's call).
- [x] **R5 — installer shim-selection defect (found by the 0.2.0 Copilot
      E2E)**: on Windows, npm global installs create three shims per CLI
      (`copilot`, `copilot.cmd`, `copilot.ps1`). `findOnPath` probed
      extensions `["", ".cmd", ".exe", ".bat"]`, so it resolved the
      **extensionless POSIX sh script first**; raw `spawn` (no shell) →
      CreateProcess ENOENT → `copilot plugin install` failed on every
      Windows machine with npm-installed client CLIs. Mock tests only
      created `.cmd` shims, which masked it. **Fix (0.2.1)**: probe order
      `.exe` → `.cmd` → `.bat` → extensionless last (PATHEXT-consistent)
      on win32, plus a regression test with real npm shim shapes
      (extensionless + `.cmd` siblings). Re-verified on the real machine:
      the 0.2.1 installer resolved
      `C:\Users\limc\AppData\Roaming\npm\copilot.cmd` and reported
      `[copilot] ok`.
- [x] **Claude Code (clean-room, real endpoint)**: hook installed
      (`.claude/settings.json` PreToolUse(Read) + SessionStart entries,
      hook file present), SessionStart hook protocol check passes, real
      MCP `describe_image` call in a running Claude Code session returned
      a description matching the test PNG's known content. OPEN user step:
      restart a session and confirm the model answers from the injected
      `[Vision of <file>]:` description + `/vision` works. The E2E project
      was cleaned up — one-liner to try it in any project:
      `npx -y deepseek-vl-support@0.2.1 install --non-interactive --target
      claude --base-url https://api.moonshot.cn/v1 --model
      moonshot-v1-32k-vision-preview --api-key <key>`.
- [x] **Codex: skipped as a todo (user decision)**. 0.142.5 does not load
      project-scope `.codex/config.toml` MCP without project trust;
      `-c` override proves the config valid. Non-interactive `codex exec`
      loads the MCP tools but cannot approve tool calls. An interactive
      session on the user's machine remains open.
- [x] **Copilot (static)**: `copilot plugin list` lists
      `deepseek-vl-support` — labeled `v0.2.0` because Copilot resolves the
      plugin version from the **GitHub marketplace** (repo `plugin.json`
      on `main`; the 0.2.1 commits were not yet pushed at check time), while
      the materialized `~/.deepseek-vl/plugin/plugin.json` was 0.2.1.
      `copilot mcp list` shows `Workspace servers: deepseek-vl (local)` —
      plugin-sourced MCP IS discovered (see the §9.1 correction).
- [ ] **Copilot session-level R4: skipped as a todo (user decision)**.
      Headless `copilot -p` fails for ANY prompt with
      `CAPIError: 400 The requested model is not supported` (baseline
      `"say hi"` fails identically) — an account-side model configuration
      issue, not the plugin (no model key in `~/.copilot/config.json` to
      override; interactive sessions on a Copilot-enabled account remain
      the user-side check).
- [x] **Cleanup**: `uninstall --target claude,codex,copilot
      --purge-config` removed all artifacts (hook entries/file/skill/
      command; `.codex/config.toml` MCP section + AGENTS.md block +
      `.agents/skills/`; copilot CLI uninstall + `settings.json` entries;
      `~/.deepseek-vl` deleted) and the E2E sandbox dir was removed.

### 9.1 GitHub Copilot

- [ ] Install line shows `installed via <path>` (CLI present) or
      `wrote ~/.copilot/settings.json` (fallback when the CLI is missing)
- [ ] `copilot plugin list` lists `deepseek-vl-support`
- [x] **R4 — verified 2026-08-14 (Copilot CLI 1.0.59)**: skills ARE
      discovered via spec semantics (`copilot plugin install` reports
      "Installed 1 skill"). With the plugin installed, `copilot mcp list`
      DOES list the plugin's MCP server —
      `Workspace servers: deepseek-vl (local)` (observed 2026-08-14 in a
      cwd with no `.mcp.json` and no `~/.copilot/mcp-config.json` entry,
      so the only known source is the installed plugin — this supersedes
      the earlier claim that plugin-sourced servers never appear). The
      package still ships `.mcp.json` (Copilot's native MCP convention,
      byte-identical to `mcp.json`, build-synced and committed) as the
      spec-native discovery file.
- [ ] **Session-level check**: on a Copilot-enabled account, in a Copilot
      session ask for a screenshot description and confirm `describe_image`
      is available and performs a REAL vision call. Open as a todo: the
      2026-08-14 box IS signed in, but every headless `copilot -p` prompt
      fails with `CAPIError: 400 The requested model is not supported`
      (account-side model config, baseline `"say hi"` fails identically).
- [ ] Uninstall: `npx deepseek-vl-support uninstall --target copilot`,
      then `copilot plugin list` no longer lists it

### 9.2 Cursor

- [ ] `~/.cursor/plugins/local/deepseek-vl-support/` exists with
      `plugin.json` + `mcp.json` + `.mcp.json` + `skills/` + the marker file
- [ ] Cursor → Developer: Reload Window, then in a composer ask for a
      screenshot description: the `deepseek-vision` skill / MCP tools are
      discovered and work (real vision call)
- [ ] Uninstall removes only the marked dir (a user-authored plugin dir
      without the marker must survive — reported as skipped)

### 9.3 Kiro (UI-only — no automation surface)

- [ ] Follow the printed guidance: Kiro → Powers panel → Add Custom Power →
      Import power from a folder → select `~/.deepseek-vl/plugin`
- [ ] Ask for a screenshot description in a Kiro power session

### 9.4 OpenClaw

- [ ] `openclaw plugins install ~/.deepseek-vl/plugin` succeeded, then
      `openclaw gateway restart`; install line reports both
- [ ] `openclaw plugins list` lists `deepseek-vl-support`; in a session the
      describe_image tool works against the real endpoint
- [ ] Uninstall command **R2**: confirm `openclaw plugins uninstall
      deepseek-vl-support` is the real command name (implemented from CLI
      conventions, not yet confirmed on a real machine)

### 9.5 Hermes Agent

- [ ] `hermes plugins install limccn/deepseek-vl-support --no-enable` +
      `hermes plugins enable deepseek-vl-support` succeeded
- [ ] `hermes plugins list` shows it enabled; the `deepseek-vision` skill is
      discoverable and describe_image performs a real vision call
- [ ] Uninstall command **R2**: confirm `hermes plugins uninstall
      deepseek-vl-support` is the real command name (same caveat as 9.4)

### 9.6 R3 — stdio subprocess launch (KNOWN RISK: bare `npx` and raw spawns)

Verified 2026-08-14 (Windows Server 2022, Node v24): spawning the command
line `npx -y deepseek-vl-support mcp` with `shell: false` (raw
CreateProcess, what many MCP clients do) fails with **ENOENT** — npm
installs `npx` as `npx`/`npx.cmd`/`npx.ps1` shims with no `npx.exe`, and a
raw spawn does not apply PATHEXT. `shell: true` (cmd.exe PATHEXT
resolution) works, but a client may spawn MCP stdio without a shell.

**Decision (2026-08-14, user)**: keep bare `npx` in `mcp.json`/`.mcp.json`
(`command: "npx"`, `args: ["-y", "deepseek-vl-support", "mcp"]`). The
documented raw-spawn ENOENT finding stays as a KNOWN RISK, and the user
environment is assumed to include npm/npx — the `node` +
`${PLUGIN_ROOT}/vendor/mcp-server.cjs` fallback was REVERTED and no vendor
bundle is shipped. Which of the 10 plugin clients spawn MCP stdio raw vs
shelled is still unknown without their machines.

Record for each client on its real machine that the MCP subprocess resolves
the bare `npx` executable and starts the server:
`<client>: npx launch OK`. If a client cannot resolve bare `npx` (raw
spawn, no PATHEXT), note it here — the documented next step is re-triggering
the R3 fallback (bundled `node` + `${PLUGIN_ROOT}` entry, spec §9.2
expansion is guaranteed) for that client.

### 9.7 VS Code (settings write, no CLI)

- [ ] Install line reports `[vscode] ok` and the user `settings.json` (see
      `chat.pluginLocations`) gained an entry
      `"<abs path to ~/.deepseek-vl/plugin>": true`; the first modify
      backed the original file up as `settings.json.bak`
- [ ] VS Code → Reload Window (Developer), then ask for a screenshot
      description in a chat session: the `deepseek-vision` skill / MCP tools
      are discovered and work (real vision call)
- [ ] Uninstall removes only our `chat.pluginLocations` entry — a
      pre-existing user entry survives untouched

### 9.8 Grok Bot

- [ ] With the `grok` CLI on PATH: install line reports
      `grok plugin install ~/.deepseek-vl/plugin --trust` ran and
      `grok plugin list` lists `deepseek-vl-support`
- [ ] In the Grok UI: Plugins tab → press `r` (refresh) or start a new
      session, then ask for a screenshot description — the
      `deepseek-vision` skill / MCP tools are discovered (real vision call)
- [ ] `grok inspect` verifies the MCP server configuration; record whether
      Grok reads `mcp.json` (spec location) or only `.mcp.json` (its default
      dot-convention file) — the guidance's dot-convention caveat stands
      until confirmed
- [ ] Without the CLI: install prints manual guidance (mentioning
      `~/.grok/plugins/` + the `.mcp.json` caveat) and reports `[grok] manual`
- [ ] Uninstall: `npx deepseek-vl-support uninstall --target grok` runs
      `grok plugin uninstall deepseek-vl-support --confirm`

### 9.9 ChatGPT & Codex (codex plugin mode)

- [ ] With the `codex` CLI on PATH: install line reports the marketplace add
      + plugin add commands; `codex plugin list` shows
      `deepseek-vl-support@deepseek-vl-support`
- [ ] The local marketplace shim exists at `~/.deepseek-vl/marketplace/`
      (`marketplace.json` manifest + `plugin/` copy) — note it is OUTSIDE
      the materialized dir, so `ls ~/.deepseek-vl/plugin/` still shows
      exactly 4 entries
- [ ] A new Codex thread (or ChatGPT session) picks up the plugin: ask for a
      screenshot description and confirm a REAL vision call
- [ ] Without the CLI: install prints manual guidance and reports
      `[chatgpt-codex] manual`
- [ ] Uninstall: `npx deepseek-vl-support uninstall --target chatgpt-codex`
      runs `codex plugin remove deepseek-vl-support@deepseek-vl-support` and
      KEEPS the marketplace registration + shim (documented decision)

### 9.10 NanoClaw

- [ ] With the `ncl` CLI on PATH: install line reports the template copy to
      `~/.deepseek-vl/nanoclaw-templates/` (a real copy, never a symlink —
      NanoClaw rejects symlinks) plus
      `ncl groups create --template deepseek-vl-support --name "DeepSeek Vision"`
      with `NANOCLAW_TEMPLATES_DIR` set
- [ ] `ncl groups list` shows the stamped group; note the stamping does NOT
      wire a channel — run `ncl wirings create` per the guidance, and tasks
      start paused
- [ ] Without the CLI: install prints manual guidance and reports
      `[nanoclaw] manual`
- [ ] Uninstall is manual (NanoClaw has no plugin uninstall) — report-only;
      delete the stamped group to clean up

### 9.11 Generic `other` (Agent Plugins open standard)

- [ ] Install materializes `~/.deepseek-vl/plugin/` and prints the portable
      install guidance (pointing at agent-plugins.org/specification);
      report is `[other] manual`
- [ ] Follow the guidance for any spec-compliant agent you want to test
      (import the plugin dir), then ask for a screenshot description
- [ ] Uninstall is report-only (manual); the materialized dir is kept unless
      `--purge-config`

## Pass criteria

- [ ] Steps 1–4 all match expectations (doctor exit code 0, describe returns a
      real description, cache hit costs 0 API calls)
- [ ] In a Claude Code session, after reading an image the model answers from
      the injected description (output shape consistent with the spike findings)
- [ ] Codex `codex mcp list` shows the server and describe_image works
- [ ] Agent Plugins: section 9 checks pass for every client present on the
      test machine (skill discoverable + a real describe_image call), the
      Copilot session-level R4 check completed on an authenticated machine,
      bare `npx` launch confirmed per client (§9.6, or the risk triggered
      for a client is documented), R2 uninstall command names confirmed,
      and the new-client behaviors recorded (§9.7 VS Code settings entry
      and `.bak` backup; §9.8 Grok `.mcp.json` caveat resolved; §9.9
      chatgpt-codex marketplace shim + uninstall keeps registration;
      §9.10 NanoClaw template copy / no symlinks; §9.11 other guidance)
- [ ] No leftovers in the directory after uninstall
