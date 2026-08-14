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
   Also confirm `VERSION` in `src/cli.ts` and `SERVER_VERSION` in `src/mcp.ts`
   match package.json (both are manual constants today — do not miss either).
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
   Expected contents (`files` whitelist: `dist/ assets/ README.md LICENSE`):
   - `dist/cli.js` (ESM, shebang preserved, bin entry)
   - `dist/hook.cjs` (standalone single-file CJS bundle, zero deps, first-line
     banner carries the identity marker `/*! deepseek-vl-support-hook */`)
   - `assets/` (SKILL.md, vision.md, vision-prompt.md, agents-fragment.md,
     skill-references/)
   - `README.md`, `LICENSE` — the package ships the English README only; the
     Chinese README lives at `docs/README.zh-CN.md` (docs/ is not packaged).
     Note: npm force-includes every root-level README* file regardless of the
     `files` whitelist — localized READMEs must live under docs/ to stay out
     of the tarball.
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

- [ ] mock automated tests all green (client/config/detect/cache/hook/install/mcp/smoke)
- [ ] real-endpoint E2E (`e2e-real-endpoint.md`) passes at least once for describe + doctor
- [ ] spike findings (plan-A block+additionalContext is visible to the model in
      Claude Code) are persisted
- [ ] `npx <pkg>@<ver> version` works on Windows — run it in a separate
      directory OUTSIDE the package (e.g. a new directory under `%TEMP%`);
      running inside the package's own directory matches the local spec, npx
      skips the install and reports `'<pkg>' is not recognized` (run-location
      issue, unrelated to the bin shape)
- [ ] `npm pack --dry-run` manifest matches expectations, no secrets
      (`~/.deepseek-vl` never participates in packing)
