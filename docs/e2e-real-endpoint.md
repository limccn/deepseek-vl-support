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
  --target both --preset openrouter \
  --api-key $OPENROUTER_API_KEY
```

Verify (dry-run first, predictable results):

```bash
npx deepseek-vl-support install --dry-run --non-interactive --target both --preset openrouter
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

## 9. Agent Plugins (Copilot / Cursor / Kiro / OpenClaw / Hermes)

Run once per release on machines that actually have the client installed.
Prerequisite: the real endpoint configured (see step 0) and `npm run build`.

```bash
npx deepseek-vl-support install --target plugin --preset openrouter --api-key $OPENROUTER_API_KEY
# menu: pick the clients present on this machine; scope is skipped (always global)
ls ~/.deepseek-vl/plugin/            # plugin.json + mcp.json + skills/
```

### 9.1 GitHub Copilot

- [ ] Install line shows `installed via <path>` (CLI present) or
      `wrote ~/.copilot/settings.json` (fallback when the CLI is missing)
- [ ] `copilot plugin list` lists `deepseek-vl-support`
- [ ] **R4 — mcp.json reading behavior**: in a Copilot session ask for a
      screenshot description and confirm the `describe_image` MCP tool is
      available and performs a REAL vision call. If tools never appear,
      Copilot may only read its native `.mcp.json` (research gap R4) — copy
      root `mcp.json` as `.mcp.json` in the plugin dir (harmless for the
      other clients, they read the spec `mcp.json`).
- [ ] Uninstall: `npx deepseek-vl-support uninstall --target plugin --clients copilot`,
      then `copilot plugin list` no longer lists it

### 9.2 Cursor

- [ ] `~/.cursor/plugins/local/deepseek-vl-support/` exists with
      `plugin.json` + `mcp.json` + `skills/` + the marker file
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

### 9.6 R3 — bare `npx` resolution per client

Record for each client above whether the MCP stdio subprocess resolves the
bare `npx` from `mcp.json` (design gap R3). The package's `mcp` entry is the
same `npx -y deepseek-vl-support mcp` shape already verified for Codex, and
`npx` is the de-facto stdio convention, but a client whose MCP subprocess
does NOT inherit the user PATH needs the fallback plan (design §2):
`command: "node"` + `args: ["${PLUGIN_ROOT}/vendor/mcp-server.cjs"]` with a
bundled single-file server committed to the repo. Record one line per client:
`<client>: npx OK` or `<client>: needs node fallback`.

## Pass criteria

- [ ] Steps 1–4 all match expectations (doctor exit code 0, describe returns a
      real description, cache hit costs 0 API calls)
- [ ] In a Claude Code session, after reading an image the model answers from
      the injected description (output shape consistent with the spike findings)
- [ ] Codex `codex mcp list` shows the server and describe_image works
- [ ] Agent Plugins: section 9 checks pass for every client present on the
      test machine (skill discoverable + a real describe_image call), R3/R4
      findings recorded, and R2 uninstall command names confirmed
- [ ] No leftovers in the directory after uninstall
