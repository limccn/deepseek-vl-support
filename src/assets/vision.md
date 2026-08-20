---
description: Run vision server diagnostics
argument-hint: "[url]"
$ARGUMENTS:
  type: object
  properties:
    url:
      type: string
      description: Optional vision endpoint base URL to check
---

<!-- deepseek-vl-support:command -->

Run the vision diagnostics command and report the results:

```bash
npx @limccn/deepseek-vl-support doctor $ARGUMENTS
```

Report: whether the vision endpoint is reachable, whether the configured
model exists in `/models`, and what the user should do next (configure via
`deepseek-vl-support config set`, or fix the endpoint).
