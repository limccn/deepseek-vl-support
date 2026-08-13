---
# deepseek-vl-support:skill
name: deepseek-vision
description: 描述图片内容（截图/报错/UI 设计稿/图表），当前模型看不到图片时使用 | Describe images (screenshots, error screens, UI mockups, charts) in detail when the current model cannot see images. Trigger words: 截图, screenshot, 图片, image, UI, 设计稿, mockup, 图表, chart, 报错截图, error screenshot
allowed-tools: Bash, Read
---

# deepseek-vision — 图片描述 | Describe images

The current model (e.g. DeepSeek) is text-only and cannot see images. When the
task requires understanding an image file, use this skill to obtain a precise
text description and reason from it. | 当前模型（如 DeepSeek）为纯文本模型，无法直接查看图片。当任务需要理解图片内容时，用本技能获取精确的文本描述并基于描述推理。

## When to use | 使用时机

- 报错截图 / error screenshots
- UI 设计稿与界面截图 / UI mockups and interface screenshots
- 图表与示意图 / charts and diagrams
- 任何需要模型理解内容的图片 / any image the model needs to understand

## How to use | 使用方法

Run in the Bash tool:

```bash
npx deepseek-vl-support describe "<image file path>" "<optional question>"
```

or, if the `deepseek-vl-support` bin is on PATH:

```bash
deepseek-vl-support describe "<image file path>"
```

Read the returned description and use it for reasoning. Large images (over
`maxBytes`, default 10 MB) are rejected with a clear error — compress or crop
first (e.g. under 5 MB, ~2000px long edge). | 超过 maxBytes（默认 10MB）的图片会被拒绝，请先压缩或裁剪。

## Customizing the vision prompt | 定制视觉提示词

Default prompt: `references/vision-prompt.md`. Overrides (highest wins):
- project `.deepseek-vl/vision-prompt.md`
- global `~/.deepseek-vl/vision-prompt.md`

## Troubleshooting | 故障排查

Run `npx deepseek-vl-support doctor` to check the vision endpoint and model.
If images are not described automatically, check `VISION_DISABLE` and the hook
registration in `.claude/settings.json`. | 如果图片未被自动描述，检查 VISION_DISABLE 与 .claude/settings.json 中的 hook 注册。
