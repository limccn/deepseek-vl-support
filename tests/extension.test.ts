// pi/omp extension module assertions: the file exists, its default export is
// a factory function (pi loads it with jiti at runtime), and package.json
// ships it — pi.extensions glob resolves to an existing dir, files whitelist
// carries extensions/. Hook BEHAVIOR needs a real pi/omp runtime (no sandbox
// here) — that is the user's real-machine e2e checklist in docs/releasing.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_FILE = join(ROOT, "extensions", "deepseek-vision.ts");

test("extension file exists and default-exports a factory function", async () => {
  assert.ok(existsSync(EXT_FILE), "extensions/deepseek-vision.ts present");
  const mod = await import("../extensions/deepseek-vision.ts");
  assert.equal(typeof mod.default, "function", "default export is the extension factory");
});

test("package.json pi manifest: extensions + skills globs both resolve to existing dirs, files ships both", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    pi?: { extensions?: string[]; skills?: string[] };
    keywords?: string[];
    files?: string[];
  };
  assert.ok(
    Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0,
    "pi.extensions present and non-empty (pi: {} would load nothing)",
  );
  for (const glob of pkg.pi!.extensions!) {
    const dir = join(ROOT, glob.replace(/^\.\//, ""));
    assert.ok(existsSync(dir), `pi.extensions glob "${glob}" resolves to an existing directory`);
  }
  assert.ok(Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0, "pi.skills still present alongside extensions");
  assert.ok(pkg.keywords?.includes("pi-package"), "pi-package keyword for the pi.dev gallery");
  assert.ok(pkg.files?.includes("extensions/"), "files whitelist ships extensions/");
  assert.ok(pkg.files?.includes("skills/"), "files whitelist ships skills/");
});
