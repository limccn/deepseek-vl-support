// Build script: bundles the CLI (ESM) and the standalone hook (CJS); copies
// src/assets templates into the package root `assets/` (shipped in the npm
// package per package.json "files") and syncs the plugin-package copies that
// git install sources must carry (skills/deepseek-vision/SKILL.md, .mcp.json).
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

await mkdir(join(root, "dist"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(root, "src/cli.ts")],
    outfile: join(root, "dist/cli.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    logLevel: "info",
  }),
  build({
    entryPoints: [join(root, "src/hook.ts")],
    outfile: join(root, "dist/hook.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    // Legal comment banner: preserved by esbuild; also serves as the
    // identity marker that the installer/uninstaller check.
    banner: { js: "/*! deepseek-vl-support-hook */" },
    logLevel: "info",
  }),
  // DeepSeek Harness cordis plugin. @deepseek-ai/* stay external: the dsh
  // profile pnpm closure injects them at runtime (they are devDependencies
  // here for types only — the bundle must keep bare imports). dist/dsh-plugin.js
  // is committed to git (.gitignore exception) so `dsh plugin add
  // github:limccn/deepseek-vl-support` works without a build step.
  build({
    entryPoints: [join(root, "src/dsh-plugin.ts")],
    outfile: join(root, "dist/dsh-plugin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    external: ["@deepseek-ai/*"],
    logLevel: "info",
  }),
]);

await rm(join(root, "assets"), { recursive: true, force: true });
await cp(join(root, "src/assets"), join(root, "assets"), { recursive: true });

// Agent Plugins portable package: skills/deepseek-vision/SKILL.md at the
// package root is the plugin copy of the skill (git-installed plugins ship
// it directly). Single source stays src/assets/SKILL.md; this copy is the
// build-time sync point and is committed to git.
await mkdir(join(root, "skills", "deepseek-vision"), { recursive: true });
await cp(join(root, "assets", "SKILL.md"), join(root, "skills", "deepseek-vision", "SKILL.md"));

// Progressive disclosure (Agent Skills spec): the SKILL.md body references
// references/vision-prompt.md, so the packaged skill dir must be
// self-contained. Same source as the Claude install template reference
// (assets/skill-references/vision-prompt.md).
await mkdir(join(root, "skills", "deepseek-vision", "references"), { recursive: true });
await cp(join(root, "assets", "skill-references", "vision-prompt.md"), join(root, "skills", "deepseek-vision", "references", "vision-prompt.md"));

// Copilot's native MCP convention reads .mcp.json, not the spec mcp.json
// (real-machine finding R4). Ship a byte-identical copy at the repo root,
// synced here and committed to git (the repo is a Copilot install source).
// Spec clients ignore it; Copilot gets its native file.
await cp(join(root, "mcp.json"), join(root, ".mcp.json"));

console.log("build ok: dist/cli.js + dist/hook.cjs + dist/dsh-plugin.js + assets/ + skills/deepseek-vision/{SKILL.md,references/vision-prompt.md} + .mcp.json");
