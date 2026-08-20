# Contributing to deepseek-vl-support

Thanks for considering a contribution! This project gives text-only AI models (like
DeepSeek) vision through external vision services. See [README.md](README.md) for what it
does and how users install it; [CLAUDE.md](CLAUDE.md) is the technical reference.

## Reporting issues

Before opening an issue, run the health check and include its output:

```bash
npx @limccn/deepseek-vl-support@latest doctor
```

Also include:

- Your OS and Node version (`node -v`)
- Which agent(s) you installed for and the exact install command you ran
- The picture that fails (or a description of it) — without an API key, so nothing secret
  leaks into the issue

Known edge cases are listed in [README.md](README.md#troubleshooting) and
[CLAUDE.md](CLAUDE.md) — please check them first.

## Development setup

Requirements: Node.js ≥ 18.

```bash
npm install
npm run build        # esbuild → dist/ + regenerates skills/ + .mcp.json
npm run typecheck    # tsc --noEmit
npm run test         # mock-based tests (run build first)
```

Run all three with `npm run verify`. For one test file:

```bash
node --test tests/install.test.ts
```

The automated tests use a mock vision server — no API key needed. The real-endpoint E2E
manual (now part of [CLAUDE.md](CLAUDE.md#e2e-real-endpoint-manual-was-docse2e-real-endpointmd))
is for release-time validation, not day-to-day development.

## Before submitting

- `npm run verify` is green.
- If you touched install artifacts (skills, mcp files, hook), commit the **regenerated**
  copies — `skills/deepseek-vision/SKILL.md` and `.mcp.json` are committed to git because
  the repository is itself the plugin install source. `dist/` is not committed (except
  `dist/dsh-plugin.js`, which dsh git installs need).
- Keep the docs layered: user-facing changes go to `README.md` and
  `docs/README.zh-CN.md` (both stay in sync); technical details live in `CLAUDE.md`.
- Don't touch user files without a managed marker, and keep the `.bak` backup behavior —
  see [CLAUDE.md](CLAUDE.md#maintenance-conventions).

## Releasing

Releases are manual and maintainer-only; publishing a GitHub release also triggers the
dual-publish workflow (`.github/workflows/publish.yml` → npmjs + GitHub Packages). The
full checklist lives in [CLAUDE.md](CLAUDE.md#release-process-was-docsreleasingmd) — it
covers the four version constants, the pack manifest, publish, and the post-publish smoke
test.
