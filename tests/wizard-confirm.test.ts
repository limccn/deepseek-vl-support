// Wizard keep/overwrite confirmation — pure-function tests (no readline):
// the config.json and skill menu specs (R5 pure labels, default keep), the
// shouldAskConfig decision matrix (R1/R2/R7), and the 22-agent
// existingSkillTargets candidate map (R4, mirrors what each driver writes).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configKeepMenuSpec,
  existingSkillTargets,
  shouldAskConfig,
  skillKeepMenuSpec,
} from "../src/install.ts";
import { formatMenu } from "../src/wizard.ts";

const SKILL_DIR = "deepseek-vision";

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeDirs(...rel: string[]): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), "dvls-confirm-"));
  }
  const dir = join(tmpDir, ...rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Touch a skill SKILL.md at <base>/<rel>/deepseek-vision/SKILL.md and return
 *  its path. */
function touchSkill(base: string, ...rel: string[]): string {
  const file = join(base, ...rel, SKILL_DIR, "SKILL.md");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "# user skill\n", "utf8");
  return file;
}

// ---------------------------------------------------------------- menu specs

test("configKeepMenuSpec: R5 pure labels, keep is the default", () => {
  const out = formatMenu(configKeepMenuSpec("/proj/.deepseek-vl/config.json"));
  assert.ok(out.includes("Existing config found: /proj/.deepseek-vl/config.json"));
  assert.ok(out.includes("  1) Keep existing (skip config write)"));
  assert.ok(out.includes("  2) Overwrite (merge new answers in)"));
  assert.ok(!out.includes("(default)"), `no per-option (default) marker: ${out}`);
  assert.ok(out.includes("[keep]"), "prompt hint carries the keep default");
});

test("skillKeepMenuSpec: lists every existing target, keep is the default", () => {
  const paths = ["/p/.claude/skills/deepseek-vision/SKILL.md", "/p/.agents/skills/deepseek-vision/SKILL.md"];
  const spec = skillKeepMenuSpec(paths);
  const out = formatMenu(spec);
  assert.ok(out.includes("Existing skill found:"));
  assert.ok(out.includes("  - " + paths[0]) && out.includes("  - " + paths[1]), "every path listed");
  assert.ok(out.includes("  1) Keep existing skills"));
  assert.ok(out.includes("  2) Overwrite with packaged version"));
  assert.ok(!out.includes("(default)"), `no per-option (default) marker: ${out}`);
  assert.ok(out.includes("[keep]"), "prompt hint carries the keep default");
  assert.equal(spec.default, "keep");
});

// ---------------------------------------------------------------- shouldAskConfig

test("shouldAskConfig decision matrix (R1/R2/R7)", () => {
  // R1: real preset + existing file + not --update → ask
  assert.equal(shouldAskConfig("openrouter", true, false), true);
  // no existing file → never ask
  assert.equal(shouldAskConfig("openrouter", false, false), false);
  assert.equal(shouldAskConfig("openrouter", false, true), false);
  // R2: "Decide later" keeps silently, never asks
  assert.equal(shouldAskConfig("later", true, false), false);
  assert.equal(shouldAskConfig("later", false, false), false);
  // R7: --update never asks
  assert.equal(shouldAskConfig("openrouter", true, true), false);
  assert.equal(shouldAskConfig("later", true, true), false);
});

// ---------------------------------------------------------------- existingSkillTargets

test("existingSkillTargets: 22-agent write map mirrors each driver (project scope)", () => {
  const project = makeDirs("project");
  const home = makeDirs("home");
  const cwd = join(project, "work");
  mkdirSync(cwd, { recursive: true });

  // a claude project-scope install reads .claude/ + writes the shared tree
  const targets = ["claude", "codex", "opencode", "pi", "dsh", "omp", "trae", "qwen", "workbuddy", "reasonix", "kilo", "devin"] as const;
  const found = existingSkillTargets([...targets], cwd, home, false);
  assert.deepEqual(found, [], "no targets exist yet");

  // create the skill files each driver would have written
  const claudeSkill = touchSkill(cwd, ".claude", "skills");
  const sharedSkill = touchSkill(cwd, ".agents", "skills");
  const traeSkill = touchSkill(cwd, ".trae", "skills");
  const qwenSkill = touchSkill(cwd, ".qwen", "skills");
  const buddySkill = touchSkill(cwd, ".codebuddy", "skills");
  touchSkill(cwd, ".reasonix", "skills"); // reasonix project scope also writes .agents (shared)
  // NOTE: reasonix/kilo/devin project-scope skill lives in the shared tree —
  // the .reasonix one above is NOT a candidate (devin/kilo do not write it).

  const found2 = existingSkillTargets([...targets], cwd, home, false);
  // claude: .claude; codex/opencode/pi/dsh/omp/reasonix/kilo/devin: shared
  // tree (deduped); trae: .trae; qwen: .qwen; workbuddy: .codebuddy
  assert.deepEqual(
    [...found2].sort(),
    [claudeSkill, sharedSkill, traeSkill, qwenSkill, buddySkill].sort(),
    "one candidate per distinct skill location, deduped",
  );
});

test("existingSkillTargets: global scope — shared tree skipped, scope dirs move to home", () => {
  const project = makeDirs("project2");
  const home = makeDirs("home2");
  const cwd = join(project, "work");
  mkdirSync(cwd, { recursive: true });

  // global-scope writes: claude → ~/.claude, qwen → ~/.qwen,
  // workbuddy → ~/.codebuddy, reasonix/kilo/devin → ~/.agents; trae is
  // ALWAYS project-level (it is not scope-aware) — its .trae tree stays a
  // candidate even in a global install
  const homeClaude = touchSkill(home, ".claude", "skills");
  const homeQwen = touchSkill(home, ".qwen", "skills");
  const homeBuddy = touchSkill(home, ".codebuddy", "skills");
  const homeAgents = touchSkill(home, ".agents", "skills");
  // a stale project-level shared tree must NOT be a candidate in global scope
  // (codex/opencode/reasonix/kilo/devin skip the shared write when global)
  touchSkill(cwd, ".agents", "skills");
  const projectTrae = touchSkill(cwd, ".trae", "skills");

  const targets = ["claude", "codex", "opencode", "trae", "qwen", "workbuddy", "reasonix", "kilo", "devin"] as const;
  const found = existingSkillTargets([...targets], cwd, home, true);
  assert.deepEqual(
    [...found].sort(),
    [homeClaude, homeQwen, homeBuddy, homeAgents, projectTrae].sort(),
    "global scope: home dirs + the always-project trae tree; project .agents is not a candidate",
  );

  // codex global scope never writes .agents — same candidate set without it
  const noCodex = existingSkillTargets(["claude"], cwd, home, true);
  assert.deepEqual(noCodex, [homeClaude]);
});

test("existingSkillTargets: plugin clients never produce skill candidates", () => {
  const project = makeDirs("project3");
  const home = makeDirs("home3");
  const cwd = join(project, "work");
  mkdirSync(cwd, { recursive: true });
  // even when a plugin-like path exists, no plugin agent maps to a skill write
  touchSkill(cwd, ".agents", "skills");
  const found = existingSkillTargets(["copilot", "cursor", "other"], cwd, home, false);
  assert.deepEqual(found, [], "plugin clients write no skill files");
});

test("existingSkillTargets: opencode/trae/pi/omp/dsh project scope candidates", () => {
  const project = makeDirs("project4");
  const home = makeDirs("home4");
  const cwd = join(project, "work");
  mkdirSync(cwd, { recursive: true });

  // trae always writes .trae (project-level); opencode/pi/omp/dsh write the
  // shared tree (project scope only)
  const traeSkill = touchSkill(cwd, ".trae", "skills");
  const sharedSkill = touchSkill(cwd, ".agents", "skills");

  const found = existingSkillTargets(["trae", "opencode", "pi", "omp", "dsh"], cwd, home, false);
  assert.deepEqual([...found].sort(), [traeSkill, sharedSkill].sort());
});
