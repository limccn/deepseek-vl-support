// Wizard rendering tests (pure, non-interactive): the R5 rule that menu
// options show pure labels — no per-option "(default)" markers — while the
// Enter=default hint stays in the prompt line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMenu, formatMultiMenu, type MenuSpec, type MultiMenuSpec } from "../src/wizard.ts";

test("formatMenu: numbered options with pure labels, no per-option (default) markers", () => {
  const spec: MenuSpec = {
    prompt: "Pick one",
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
    default: "b",
  };
  const out = formatMenu(spec);
  assert.ok(out.includes("Pick one"));
  assert.ok(out.includes("  1) Alpha"));
  assert.ok(out.includes("  2) Beta"));
  assert.ok(!out.includes("(default)"), `no per-option (default) marker: ${out}`);
  assert.ok(!out.includes("Alpha (default)") && !out.includes("Beta (default)"));
  // the default lives in the prompt hint only
  assert.ok(out.includes("[b]"), `prompt line carries the Enter=default hint: ${out}`);
});

test("formatMenu without default: no hint suffix", () => {
  const out = formatMenu({ prompt: "Pick", options: [{ value: "a", label: "Alpha" }] });
  assert.ok(!out.includes("[a]") && !out.includes("(default)"));
});

test("formatMultiMenu: pure labels, no per-option (default) markers, Enter=default hint only when defaults exist", () => {
  const spec: MultiMenuSpec = {
    prompt: "Pick any",
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
    default: ["a"],
  };
  const out = formatMultiMenu(spec);
  assert.ok(out.includes("  1) Alpha") && out.includes("  2) Beta"));
  assert.ok(!out.includes("(default)"), `no per-option (default) marker: ${out}`);
  assert.ok(out.includes("Enter=default"), `hint present when defaults exist: ${out}`);
  const noDefault = formatMultiMenu({ prompt: "Pick", options: [{ value: "a", label: "Alpha" }] });
  assert.ok(!noDefault.includes("Enter=default"), "no hint when there is no default");
  assert.ok(!noDefault.includes("(default)"));
});
