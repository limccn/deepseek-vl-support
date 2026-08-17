---
# deepseek-vl-support:skill
name: deepseek-vision
description: Describe images (screenshots, error screens, UI mockups, charts) in detail when the current model cannot see images. Trigger words: screenshot, image, UI, mockup, chart, error screenshot
allowed-tools: Bash Read
---

# deepseek-vision — Describe images

The current model (e.g. DeepSeek) is text-only and cannot see images. When the
task requires understanding an image file, use this skill to obtain a precise
text description and reason from it.

## When to use

- error screenshots
- UI mockups and interface screenshots
- charts and diagrams
- any image the model needs to understand

## How to use

Run in the Bash tool:

```bash
npx deepseek-vl-support describe "<image file path>" "<optional question>"
```

or, if the `deepseek-vl-support` bin is on PATH:

```bash
deepseek-vl-support describe "<image file path>"
```

The command is identical in bash, zsh (macOS default), and PowerShell
(Windows): quote paths containing spaces with `"`. No shell-specific
syntax or call operator is needed — `npx` resolves via its `.cmd` shim
under PowerShell.

Read the returned description and use it for reasoning. Large images (over
`maxBytes`, default 10 MB) are rejected with a clear error — compress or crop
first (e.g. under 5 MB, ~2000px long edge).

## Customizing the vision prompt

Default prompt: `references/vision-prompt.md`. Overrides (highest wins):
- project `.deepseek-vl/vision-prompt.md`
- global `~/.deepseek-vl/vision-prompt.md`

## Troubleshooting

Run `npx deepseek-vl-support doctor` to check the vision endpoint and model.
If images are not described automatically, check `VISION_DISABLE` and the hook
registration in `.claude/settings.json`.
