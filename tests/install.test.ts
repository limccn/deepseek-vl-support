// Installer tests (programmatic runInstall/runUninstall, non-interactive):
// artifact layout, settings.json deep-merge + preservation of user entries,
// idempotency, --update, user-authored file protection, global scope with
// JSON-escaped backslash commands, codex config.toml / AGENTS.md / models.json
// fix, uninstall removal matrix, --purge-config, dry-run.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInstall, runUninstall } from "../src/install.ts";
import {
  AGENTS_END_MARKER,
  AGENTS_START_MARKER,
  GITIGNORE_ENTRY,
  HOOK_COMMAND_IDENT,
  HOOK_FILENAME,
  HOOK_MARKER,
  MCP_SERVER_NAME,
  SKILL_MARKER,
} from "../src/identity.ts";
import { startMockVisionServer } from "./mock-vision-server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

let tmp: { base: string; project: string; home: string } | null = null;
const savedEnv = { ...process.env };

async function makeEnv(): Promise<{ base: string; project: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "dvls-install-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  tmp = { base, project, home };
  return { base, project, home };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_") || k.startsWith("DVLS_")) delete process.env[k];
  }
});

afterEach(async () => {
  process.env = { ...savedEnv };
  if (tmp) {
    await rm(tmp.base, { recursive: true, force: true });
    tmp = null;
  }
});

function text(p: string): string {
  return readFileSync(p, "utf8");
}

function json(p: string): Record<string, unknown> {
  return JSON.parse(text(p)) as Record<string, unknown>;
}

async function installBoth(project: string, home: string, mockUrl: string, extra: Record<string, unknown> = {}) {
  return runInstall({
    cwd: project,
    home,
    nonInteractive: true,
    target: "both",
    baseUrl: mockUrl,
    model: "qwen2.5vl:7b",
    apiKey: "",
    ...extra,
  });
}

// ---------------------------------------------------------------- install

test("claude install: artifacts + settings deep-merge preserves user entries", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    // pre-seed user settings: custom top-level key + a foreign PreToolUse entry
    const claudeDir = join(project, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          env: { FOO: "bar" },
          hooks: {
            PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "node my-edit-hook.cjs", timeout: 10 }] }],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    try {
      const report = await installBoth(project, home, mock.url);

      // config.json
      const cfg = json(join(project, ".deepseek-vl", "config.json"));
      assert.equal(cfg.baseUrl, mock.url);
      assert.equal(cfg.model, "qwen2.5vl:7b");

      // .gitignore
      assert.ok(text(join(project, ".gitignore")).includes(GITIGNORE_ENTRY));

      // hook bundle copied with identity marker
      const hook = text(join(project, ".claude", "hooks", HOOK_FILENAME));
      assert.ok(hook.includes(HOOK_MARKER), "hook bundle must carry the identity marker");

      // skill + references + slash command
      assert.ok(text(join(project, ".claude", "skills", "deepseek-vision", "SKILL.md")).includes(SKILL_MARKER));
      assert.ok(text(join(project, ".claude", "skills", "deepseek-vision", "references", "vision-prompt.md")).includes(SKILL_MARKER));
      assert.ok(existsSync(join(project, ".claude", "commands", "vision.md")));

      // settings.json: user entries preserved + our entries appended
      const settings = json(join(claudeDir, "settings.json"));
      assert.equal((settings.env as Record<string, string>).FOO, "bar");
      const pre = (settings.hooks as Record<string, unknown[]>).PreToolUse as Array<{ matcher: string }>;
      assert.ok(pre.some((e) => e.matcher === "Edit"), "user hook entry preserved");
      const ours = pre.filter((e) => JSON.stringify(e).includes(HOOK_COMMAND_IDENT));
      assert.equal(ours.length, 1);
      assert.equal((ours[0] as { matcher: string }).matcher, "Read");
      const start = (settings.hooks as Record<string, unknown[]>).SessionStart as Array<{ hooks: Array<{ command: string }> }>;
      assert.match(start[0].hooks[0].command, /start$/);

      // settings backed up before modification
      assert.ok(existsSync(join(claudeDir, "settings.json.bak")), "backup must exist");

      // doctor self-check ran and passed
      assert.equal(report.doctor?.ok, true);
      assert.ok(report.output.some((l) => l.includes("config written")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("re-install is idempotent: no duplicate entries, no change, hook kept", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      await installBoth(project, home, mock.url);
      const settingsBefore = text(join(project, ".claude", "settings.json"));
      const hookBefore = text(join(project, ".claude", "hooks", HOOK_FILENAME));

      const report2 = await installBoth(project, home, mock.url);
      const settings = json(join(project, ".claude", "settings.json"));
      const pre = (settings.hooks as Record<string, unknown[]>).PreToolUse as unknown[];
      const ours = pre.filter((e) => JSON.stringify(e).includes(HOOK_COMMAND_IDENT));
      assert.equal(ours.length, 1, "no duplicate hook entries");
      assert.equal(text(join(project, ".claude", "settings.json")), settingsBefore, "settings.json unchanged on re-install");
      assert.equal(text(join(project, ".claude", "hooks", HOOK_FILENAME)), hookBefore, "hook not rewritten without --update");
      assert.ok(report2.output.some((l) => l.includes("idempotent")), `expected no-change log, got: ${report2.output.join("|")}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("--update refreshes managed files; user-authored files are never overwritten", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    // a user-authored SKILL.md at OUR target path (no marker) blocks install
    const userSkill = join(project, ".claude", "skills", "deepseek-vision", "SKILL.md");
    mkdirSync(join(userSkill, ".."), { recursive: true });
    writeFileSync(userSkill, "# My hand-written skill\n", "utf8");
    try {
      const report = await installBoth(project, home, mock.url, { update: true });
      assert.equal(text(userSkill), "# My hand-written skill\n", "user-authored SKILL.md untouched");
      assert.ok(
        report.warnings.some((w) => w.includes("user-authored")),
        `expected skip warning, got: ${report.warnings.join("|")}`,
      );

      // install elsewhere (no pre-existing SKILL.md) → our managed files written
      const project2 = join(base, "project2");
      mkdirSync(project2, { recursive: true });
      await installBoth(project2, home, mock.url);
      const visionCmd = join(project2, ".claude", "commands", "vision.md");
      writeFileSync(visionCmd, text(visionCmd) + "\nTAMPERED\n", "utf8");
      await installBoth(project2, home, mock.url, { update: true });
      assert.ok(!text(visionCmd).includes("TAMPERED"), "--update must refresh managed files");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("global scope: settings under ~/.claude with JSON-escaped absolute hook command", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "claude",
        global: true,
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });
      const settingsFile = join(home, ".claude", "settings.json");
      assert.ok(existsSync(settingsFile), "global settings written to ~/.claude");
      assert.ok(!existsSync(join(project, ".claude")), "no project .claude in global scope");

      const raw = text(settingsFile);
      const settings = json(settingsFile);
      const pre = (settings.hooks as Record<string, unknown[]>).PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
      const command = pre[0].hooks[0].command;
      const hookPath = join(home, ".claude", "hooks", HOOK_FILENAME);
      assert.equal(command, `node "${hookPath}"`);
      // the raw file must contain JSON-escaped backslashes (Windows paths)
      assert.ok(raw.includes(hookPath.replaceAll("\\", "\\\\")), "raw JSON must escape backslashes");
      assert.ok(!raw.includes(`node "${hookPath}"`), "unescaped backslashes in raw JSON would corrupt the path");

      // config.json also global
      assert.ok(existsSync(join(home, ".deepseek-vl", "config.json")));
      // no .gitignore entry for global scope
      assert.ok(!existsSync(join(project, ".gitignore")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("codex install: MCP section + AGENTS.md block + models.json fix, preserving other content", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    const codexDir = join(project, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      '[model_providers.deepseek]\nwire_api = "chat"\nmodel = "deepseek-chat"\n',
      "utf8",
    );
    writeFileSync(
      join(codexDir, "AGENTS.md"),
      "# Project agents\n\nSome existing guidance.\n",
      "utf8",
    );
    writeFileSync(
      join(codexDir, "models.json"),
      JSON.stringify({
        models: [
          { name: "deepseek-chat", supports_search_tool: true },
          { name: "gpt-4o", supports_search_tool: true },
        ],
      }),
      "utf8",
    );
    try {
      const report = await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "codex",
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });

      // config.toml: our section added, provider section preserved
      const toml = text(join(codexDir, "config.toml"));
      assert.match(toml, /\[mcp_servers\.deepseek-vl\]/);
      assert.match(toml, /command = "npx"/);
      assert.match(toml, /deepseek-vl-support@0\.\d+\.\d+/);
      assert.match(toml, /args = \["-y", "[^"]*", "mcp"\]/);
      assert.match(toml, /tool_timeout_sec = 180/);
      assert.ok(toml.includes('wire_api = "chat"'), "user config.toml content preserved");

      // AGENTS.md: managed block added, existing content preserved
      const agents = text(join(codexDir, "AGENTS.md"));
      assert.ok(agents.includes(AGENTS_START_MARKER) && agents.includes(AGENTS_END_MARKER));
      assert.ok(agents.includes("Some existing guidance."));
      assert.ok(agents.includes("mcp__deepseek-vl__describe_image"));

      // models.json: deepseek entry fixed, others untouched, backup created
      const models = json(join(codexDir, "models.json")) as { models: Array<{ name: string; supports_search_tool: boolean }> };
      assert.equal(models.models[0].supports_search_tool, false);
      assert.equal(models.models[1].supports_search_tool, true);
      assert.ok(existsSync(join(codexDir, "models.json.bak")));
      assert.ok(report.output.some((l) => l.includes("supports_search_tool=true -> false")));

      // re-run: fully idempotent (no second backups)
      const beforeToml = text(join(codexDir, "config.toml"));
      const beforeAgents = text(join(codexDir, "AGENTS.md"));
      const report2 = await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "codex",
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });
      assert.equal(text(join(codexDir, "config.toml")), beforeToml);
      assert.equal(text(join(codexDir, "AGENTS.md")), beforeAgents);
      assert.ok(report2.output.some((l) => l.includes("idempotent")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("dry-run install writes nothing", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const report = await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "both",
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
        dryRun: true,
      });
      assert.ok(!existsSync(join(project, ".deepseek-vl")));
      assert.ok(!existsSync(join(project, ".claude")));
      assert.ok(!existsSync(join(project, ".codex")));
      assert.ok(!existsSync(join(project, ".gitignore")));
      assert.ok(report.output.some((l) => l.includes("[dry-run]")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("doctor self-check: ok on healthy endpoint, warning on unreachable endpoint", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      const ok = await installBoth(project, home, mock.url);
      assert.equal(ok.doctor?.ok, true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
  {
    const { base, project, home } = await makeEnv();
    try {
      const bad = await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "claude",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "qwen2.5vl:7b",
      });
      assert.equal(bad.doctor?.ok, false);
      assert.ok(bad.warnings.some((w) => w.includes("doctor found problems")), `expected doctor warning: ${bad.warnings.join("|")}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------- uninstall

test("uninstall removes managed artifacts, keeps config + user entries, preserves other file content", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    const claudeDir = join(project, ".claude");
    const codexDir = join(project, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      '[model_providers.deepseek]\nwire_api = "chat"\nmodel = "deepseek-chat"\n',
      "utf8",
    );
    writeFileSync(join(codexDir, "AGENTS.md"), "# Project agents\n\nSome existing guidance.\n", "utf8");
    try {
      await installBoth(project, home, mock.url);
      // add user content to files we will edit
      const settings = json(join(claudeDir, "settings.json"));
      (settings.hooks as Record<string, unknown[]>)!.PreToolUse!.push({
        matcher: "Edit",
        hooks: [{ type: "command", command: "node my-edit-hook.cjs" }],
      });
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
      const report = await runUninstall({ cwd: project, home, target: "both" });

      // settings: our entries gone, user-added Edit entry kept
      const after = json(join(claudeDir, "settings.json"));
      const pre = (after.hooks as { PreToolUse?: unknown[] }).PreToolUse ?? [];
      assert.equal(pre.length, 1);
      assert.equal((pre[0] as { matcher: string }).matcher, "Edit");
      assert.ok(!JSON.stringify(after).includes(HOOK_COMMAND_IDENT));

      // artifacts removed
      assert.ok(!existsSync(join(claudeDir, "hooks", HOOK_FILENAME)));
      assert.ok(!existsSync(join(claudeDir, "skills", "deepseek-vision")));
      assert.ok(!existsSync(join(claudeDir, "commands", "vision.md")));
      assert.ok(report.removed.some((r) => r.includes("vision.md")));
      assert.ok(report.removed.some((r) => r.includes("deepseek-vision-hook.cjs")));

      // codex: our section + block removed, other content intact
      const tomlAfter = text(join(codexDir, "config.toml"));
      assert.ok(!tomlAfter.includes("[mcp_servers."));
      assert.ok(tomlAfter.includes('wire_api = "chat"'));
      const agentsAfter = text(join(codexDir, "AGENTS.md"));
      assert.ok(!agentsAfter.includes(AGENTS_START_MARKER));
      assert.ok(agentsAfter.includes("Some existing guidance."));

      // config + gitignore kept by default
      assert.ok(existsSync(join(project, ".deepseek-vl", "config.json")));
      assert.ok(text(join(project, ".gitignore")).includes(GITIGNORE_ENTRY));
      assert.ok(report.kept.some((k) => k.includes("config.json + cache kept")));

      // second uninstall: no-op, no crash
      const report2 = await runUninstall({ cwd: project, home, target: "both" });
      assert.equal(report2.removed.length, 0);
      assert.ok(report2.output.some((l) => l.includes("no deepseek-vl-support hook entries")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("uninstall keeps user-authored files without our marker and reports skipped", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    const claudeDir = join(project, ".claude");
    const skillDir = join(claudeDir, "skills", "deepseek-vision");
    const hooksDir = join(claudeDir, "hooks");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# My hand-written skill\n", "utf8");
    writeFileSync(join(hooksDir, HOOK_FILENAME), "// hand-written hook, no marker\nconsole.log('hi');\n", "utf8");
    try {
      const report = await runUninstall({ cwd: project, home, target: "claude" });
      assert.equal(text(join(skillDir, "SKILL.md")), "# My hand-written skill\n");
      assert.equal(text(join(hooksDir, HOOK_FILENAME)), "// hand-written hook, no marker\nconsole.log('hi');\n");
      assert.ok(report.skipped.some((s) => s.includes("SKILL.md")), `expected skip: ${report.skipped.join("|")}`);
      assert.ok(report.skipped.some((s) => s.includes("deepseek-vision-hook.cjs")), `expected skip: ${report.skipped.join("|")}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("--purge-config removes config dir + .gitignore line; dry-run removes nothing", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      await installBoth(project, home, mock.url);
      const gitignore = join(project, ".gitignore");

      const dry = await runUninstall({ cwd: project, home, target: "both", purgeConfig: true, dryRun: true });
      assert.ok(existsSync(join(project, ".deepseek-vl", "config.json")));
      assert.ok(text(gitignore).includes(GITIGNORE_ENTRY));
      assert.ok(dry.output.some((l) => l.includes("[dry-run]")));

      const report = await runUninstall({ cwd: project, home, target: "both", purgeConfig: true });
      assert.ok(!existsSync(join(project, ".deepseek-vl")), "config + cache deleted with --purge-config");
      assert.ok(!text(gitignore).includes(GITIGNORE_ENTRY));
      assert.ok(report.removed.some((r) => r.includes(".gitignore")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});

test("uninstall keeps the global-scope MCP section removal to the managed section only", async () => {
  const mock = await startMockVisionServer({ models: ["qwen2.5vl:7b"] });
  try {
    const { base, project, home } = await makeEnv();
    try {
      await runInstall({
        cwd: project,
        home,
        nonInteractive: true,
        target: "codex",
        global: true,
        baseUrl: mock.url,
        model: "qwen2.5vl:7b",
      });
      const tomlPath = join(home, ".codex", "config.toml");
      // append an unrelated MCP server section
      writeFileSync(tomlPath, text(tomlPath) + '\n[mcp_servers.other]\ncommand = "other"\n', "utf8");

      const report = await runUninstall({ cwd: project, home, target: "codex", global: true });
      const after = text(tomlPath);
      assert.ok(!after.includes(MCP_SERVER_NAME));
      assert.ok(after.includes("[mcp_servers.other]"), "other MCP server section preserved");
      assert.ok(report.removed.some((r) => r.includes(MCP_SERVER_NAME)));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  } finally {
    await mock.close();
  }
});
