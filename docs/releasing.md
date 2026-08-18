# Releasing

How to publish a new version of `deepseek-vl-support` to npm.

> This manual describes the process and validation checklist only; `npm publish`
> is executed manually by the maintainer (never auto-published from automated
> tasks).

## Checklist

1. **version bump**
   ```bash
   npm version <major|minor|patch>   # updates package.json and docs in lockstep
   ```
   Also confirm the manual version constants match package.json (today all
   four are manual — do not miss any):
   - `VERSION` in `src/cli.ts`
   - `SERVER_VERSION` in `src/mcp.ts`
   - `"version"` in root `plugin.json`
   - `"version"` in root `marketplace.json` (top level `metadata.version`
     and the `plugins[0].version` entry)
   Then regenerate the git-committed plugin artifacts and verify the static
   compliance tests still pass:
   ```bash
   npm run build        # copies assets/SKILL.md → skills/deepseek-vision/SKILL.md
                        # and mcp.json → .mcp.json (Copilot's native MCP file)
   node --test "tests/plugin.test.ts"   # asserts all four version fields match
   ```
   Commit the regenerated `skills/deepseek-vision/SKILL.md` and `.mcp.json`
   together with the version bump: the git repo IS the plugin install source
   for Copilot/Hermes, so the skill copy and `.mcp.json` must be in git
   (dist/ is not).
   **Keep the single bin entry named after the package**:
   ```json
   "bin": { "deepseek-vl-support": "dist/cli.js" }
   ```
   A single same-name bin is the standard publishing shape (bin name equals
   package name, easy to discover and invoke) — keep it, do not add aliases.
   ⚠️ Do not confuse this with the npx smoke-test error: running
   `npx -y deepseek-vl-support@<version> …` INSIDE the package's own directory
   makes the local package.json name+version match the spec, npx skips the
   download and looks for a PATH shim by the local metadata's bin name (which
   the local project does not have), so cmd reports `'deepseek-vl-support' is
   not recognized` — a run-location issue, unrelated to the bin shape; the
   post-publish smoke test must run in a separate directory outside the package
   (see §5).

2. **build + typecheck + tests all green**
   ```bash
   npm run build && npx tsc --noEmit && node --test "tests/*.test.ts"
   ```
   Continue only after everything passes.

3. **pack — validate the artifact manifest**
   ```bash
   npm pack --dry-run
   ```
   Expected contents (`files` whitelist: `dist/ assets/ skills/ plugin.json
   mcp.json .mcp.json README.md LICENSE`):
   - `dist/cli.js` (ESM, shebang preserved, bin entry)
   - `dist/hook.cjs` (standalone single-file CJS bundle, zero deps, first-line
     banner carries the identity marker `/*! deepseek-vl-support-hook */`)
   - `assets/` (SKILL.md, vision.md, vision-prompt.md, agents-fragment.md,
     skill-references/)
   - `skills/deepseek-vision/SKILL.md` (the Agent Plugins skill copy; kept in
     sync with assets/SKILL.md by `npm run build`, committed to git so
     git-based plugin installs ship it)
   - `plugin.json`, `mcp.json` (the Agent Plugins v1.0.0 package manifest and
     its MCP server config — the portable-plugin payload)
   - `.mcp.json` (byte-identical to `mcp.json`; Copilot's native MCP
     convention — R4 real-machine finding)
   - `README.md`, `LICENSE` — the package ships the English README only; the
     Chinese README lives at `docs/README.zh-CN.md` (docs/ is not packaged).
     Note: npm force-includes every root-level README* file regardless of the
     `files` whitelist — localized READMEs must live under docs/ to stay out
     of the tarball.
   - `marketplace.json` is intentionally NOT packaged: it is only meaningful
     in the git repository, where Copilot's `copilot plugin marketplace add`
     and `copilot plugin install <repo>` read it from the repo root.
   - **pi/omp native plugin** (since 0.2.4): confirm `"pi": { "skills":
     ["./skills"] }` and the `pi-package` keyword are in the tarball's
     package.json, and that `skills/deepseek-vision/SKILL.md` + `mcp.json` +
     `.mcp.json` are present — pi loads only what its `pi` manifest lists,
     omp (pi-key fallback) auto-registers the package's `.mcp.json`.
   - Must NOT contain: `tests/`, `.trellis/`, `node_modules/`, the source
     `src/` (artifacts already include it), `docs/`, temporary files.

   Verify the hook artifact is self-contained (no external deps):
   ```bash
   node dist/hook.cjs </dev/null   # should print {} and exit 0 (Linux/macOS)
   ```

4. **publish**
   ```bash
   npm publish
   ```
   - First publish: `npm publish --access public` (unscoped package name,
     public by default).
   - Confirm the tarball matches dry-run: run `npm publish --dry-run` first.
   - **2FA accounts**: on `E403 Two-factor authentication ... is required to
     publish`, the terminal prompts for an OTP (6-digit authenticator code) and
     retries automatically; if it still fails, switch to a granular access
     token (npmjs.com → Access Tokens → Granular, grant this package Read+write
     and "Bypass two-factor authentication in automated environments"), then
     `npm config set //registry.npmjs.org/:_authToken <token>` and publish again.

5. **post-publish smoke** (run in a separate directory OUTSIDE the package,
   e.g. a new directory under `%TEMP%`)
   ```bash
   cd %TEMP% && mkdir -p dvs-smoke && cd dvs-smoke
   npx -y deepseek-vl-support@<version> version
   cd <configured project> && npx -y deepseek-vl-support@<version> doctor
   ```
   ⚠️ Running inside the package's own project directory matches the local
   package.json, npx skips the install and cmd reports `'deepseek-vl-support'
   is not recognized` — a test-environment artifact, not a package problem.
   ⚠️ A stale GLOBAL install of the same name (`npm ls -g deepseek-vl-support`)
   can shadow npx inside the package dir and silently run an OLD version —
   output looks plausible but version/preset checks fail (seen with 0.1.2
   shadowing 0.1.3 in smoke 0.1.3). Refresh it (`npm i -g …@latest`), run every
   smoke command in the clean dir, and verify version-specific output (e.g. a
   new install preset) instead of trusting that "something ran".

## Rollback

- npm does not support deleting published versions; to deprecate one:
  ```bash
  npm deprecate deepseek-vl-support@<version> "broken — use <new-version> instead"
  ```
- User-side rollback: the installer writes `.bak` backups before every write;
  `uninstall` reverses by marker. Config/cache are kept — reinstalling restores.
- Codex side: the `config.toml` MCP section pins `deepseek-vl-support@<version>`;
  after upgrading the package, re-run `install --update` to refresh the MCP
  section and the hook copy.

## Pre-release self-check (incl. spike findings)

- [ ] mock automated tests all green (client/config/detect/cache/hook/install/mcp/plugin/smoke)
- [ ] version sync: `VERSION` (src/cli.ts), `SERVER_VERSION` (src/mcp.ts),
      `plugin.json`, `marketplace.json` all equal package.json (plugin.test.ts
      asserts the static files; the two src constants are manual)
- [ ] `skills/deepseek-vision/SKILL.md` regenerated via `npm run build` and
      committed (git plugin installs ship it; the test asserts it equals
      assets/SKILL.md)
- [ ] `.mcp.json` regenerated via `npm run build` and committed (git plugin
      installs ship Copilot's native MCP file; the test asserts byte-identity
      with mcp.json)
- [ ] real-endpoint E2E (`e2e-real-endpoint.md`) passes at least once for describe + doctor
- [ ] pi/omp real-machine e2e (user-owned): `pi install npm:deepseek-vl-support`
      loads the deepseek-vision skill (restart pi, then `/skill:deepseek-vision`);
      `pi install git:github.com/limccn/deepseek-vl-support@<tag>` same; `omp
      install npm:deepseek-vl-support` loads skill + registers the deepseek-vl
      MCP server (`/reload-plugins`, then call describe_image). Observation
      items: whether pi requires a restart; behavior of a package skill
      coexisting with a wizard-installed project skill; and whether the
      CURRENT omp version still accepts the `pi` key fallback (omp iterates
      fast — re-check before relying on it)
- [ ] spike findings (plan-A block+additionalContext is visible to the model in
      Claude Code) are persisted
- [ ] `npx <pkg>@<ver> version` works on Windows — run it in a separate
      directory OUTSIDE the package (e.g. a new directory under `%TEMP%`);
      running inside the package's own directory matches the local spec, npx
      skips the install and reports `'<pkg>' is not recognized` (run-location
      issue, unrelated to the bin shape)
- [ ] `npm pack --dry-run` manifest matches expectations, no secrets
      (`~/.deepseek-vl` never participates in packing)
