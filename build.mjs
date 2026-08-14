// Build script: bundles the CLI (ESM) and the standalone hook (CJS), and
// copies src/assets templates into the package root `assets/` (shipped in
// the npm package per package.json "files").
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
]);

await rm(join(root, "assets"), { recursive: true, force: true });
await cp(join(root, "src/assets"), join(root, "assets"), { recursive: true });

// Agent Plugins portable package: skills/deepseek-vision/SKILL.md at the
// package root is the plugin copy of the skill (git-installed plugins ship
// it directly). Single source stays src/assets/SKILL.md; this copy is the
// build-time sync point and is committed to git.
await mkdir(join(root, "skills", "deepseek-vision"), { recursive: true });
await cp(join(root, "assets", "SKILL.md"), join(root, "skills", "deepseek-vision", "SKILL.md"));

console.log("build ok: dist/cli.js + dist/hook.cjs + assets/ + skills/deepseek-vision/SKILL.md");
