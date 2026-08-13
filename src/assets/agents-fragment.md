## Vision support (deepseek-vl-support) / 图片描述

The main model is text-only (e.g. DeepSeek) and CANNOT see images. | 当前主模型为纯文本模型，无法直接查看图片。When you need to understand an image — screenshots, error screens, UI mockups, charts, diagrams — do NOT use `view_image` (text-only models cannot process images). Save the image to a file if needed, then call:

- `mcp__deepseek-vl__describe_image` with `{"path": "<image file path>", "question": "<optional focus>"}` → returns a detailed text description of the image (visible text, UI layout, colors, code, errors).
- `mcp__deepseek-vl__vision_status` → checks vision configuration and endpoint health (model visibility).

Notes:
- Pasted/dragged images are lost for text-only models: save the image as a file first, then describe it. | 粘贴/拖入的图片会丢失：请先保存为文件再调用描述工具。
- If vision fails, report the failure and continue working with text. | 视觉失败时报告问题并继续以文本方式工作。
