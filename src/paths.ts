import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Package-relative path resolution.
// - In the built ESM CLI (dist/cli.js) import.meta.url points at dist/,
//   so the package root is one level up (dist/ and assets/ are siblings
//   both in the repo and inside the installed npm package).
// - In the standalone CJS hook bundle (dist/hook.cjs) esbuild shims
//   import.meta.url to __filename; the resolved paths then point at the
//   project's .claude/hooks/… which is wrong, but every read that uses
//   these helpers is try/catch'd and falls back to built-in constants,
//   so the hook never depends on the package being on disk.
export function packageRoot(): string {
  const metaUrl: unknown = (import.meta as { url?: string }).url;
  if (typeof metaUrl === "string" && metaUrl) {
    return join(dirname(fileURLToPath(metaUrl)), "..");
  }
  // CJS bundle (dist/hook.cjs): import.meta is empty; the package is not
  // co-located, so return "" and let callers fall back to built-ins.
  return "";
}

export function assetsDir(): string {
  return join(packageRoot(), "assets");
}

/** Path of a template file shipped in assets/ (SKILL.md, vision.md, …). */
export function templatePath(name: string): string {
  return join(assetsDir(), name);
}

/** Packaged default vision prompt (assets/vision-prompt.md). */
export function packagedPromptPath(): string {
  return join(assetsDir(), "vision-prompt.md");
}

/** Built hook bundle that the installer copies into projects. */
export function packagedHookPath(): string {
  return join(packageRoot(), "dist", "hook.cjs");
}
