---
description: 运行视觉服务诊断（deepseek-vl-support doctor）| Run vision server diagnostics
argument-hint: "[url]"
$ARGUMENTS:
  type: object
  properties:
    url:
      type: string
      description: 可选的视觉端点 base URL（用于覆盖配置检查）| Optional vision endpoint base URL to check
---

<!-- deepseek-vl-support:command -->

Run the vision diagnostics command and report the results:

```bash
npx deepseek-vl-support doctor $ARGUMENTS
```

Report: whether the vision endpoint is reachable, whether the configured
model exists in `/models`, and what the user should do next (configure via
`deepseek-vl-support config set`, or fix the endpoint). | 报告：视觉端点是否可达、配置的模型是否在 /models 列表中，以及下一步建议。
