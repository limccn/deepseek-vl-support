# Design: deepseek-vl-support

## 1. 总体架构

npm 包 `deepseek-vl-support`（D6：公开发布 npm，MIT；bin 单一条目 `deepseek-vl-support`，
与包名同名；0.1.0 曾用别名 `deepseek-vl`，0.1.1 起统一单同名 bin——标准发布形态；
npx 在包目录内报 `is not recognized` 是命中本地 spec、跳过安装的运行位置问题，非 bin 别名所致；
Node ≥18，**零运行时依赖**，devDeps 仅 typescript/esbuild/@types/node）：

- 核心：视觉客户端 + 配置解析 + 图片识别 + 描述缓存（普通 TS 模块）。
- 分发载体三合一：CLI（describe/doctor/config/install/uninstall/mcp）、
  Claude Code hook 脚本（esbuild 打包成独立单文件 `dist/hook.cjs`，零依赖）、Codex MCP server（stdio）。
- 独立 hook 脚本的意义：hook 每次 Read 都会执行，必须本地直连（避免 npx 解析延迟）；
  安装器把 `dist/hook.cjs` 复制进项目 `.claude/hooks/`，`--update` 时覆盖。

```
deepseek-vl-support/
├── package.json            name: deepseek-vl-support, bin: {deepseek-vl-support}, files: dist/ assets/ README.md LICENSE
├── tsconfig.json
├── src/
│   ├── cli.ts              # 子命令分发（手写参数解析，零依赖）
│   ├── config.ts           # 配置模型 + 解析链 + 读写
│   ├── client.ts           # OpenAI 兼容视觉客户端（describe / listModels）
│   ├── prompt.ts           # 视觉提示词三级覆盖
│   ├── detect.ts           # 图片识别（扩展名 + magic bytes）
│   ├── cache.ts            # 描述缓存（hash+mtime 键，大小上限）
│   ├── hook.ts             # hook 入口（hook-read / hook-start）→ esbuild 打为 dist/hook.cjs
│   ├── mcp.ts              # 手写 MCP stdio server（initialize/tools/list/tools/call）
│   ├── install.ts          # 安装器：向导 + 文件安装 + 深合并 + 幂等 + 卸载
│   ├── codex.ts            # config.toml / AGENTS.md / models.json 修复
│   └── assets/             # 模板：SKILL.md、commands/vision.md、AGENTS.md 片段
├── tests/                  # node:test 单测 + mock 视觉服务器 + 冒烟
├── dist/                   # 编译产物（含独立 hook.cjs）
├── docs/                   # 端点示例、故障排查、真实端点 E2E 手册
├── README.md               # 中英双语
├── .trellis/ .claude/      # 本仓库自身工具链（trellis）
└── pi-deepseek-vision-main/  # 参考实现（.gitignore 排除，不打包）
```

> 本仓库当前不是 git 仓库 → 实现第 0 步 `git init`。

## 2. 配置模型与解析链

```ts
interface FallbackConfig { model: string; baseUrl?: string; apiKey?: string; }  // 缺省继承主配置
interface VisionConfig {
  baseUrl: string; model: string; apiKey: string;
  timeoutMs: number; maxBytes: number; enabled: boolean;
  fallbacks: FallbackConfig[];   // 主模型失败按序降级（可空）
}
```

解析优先级（逐字段覆盖，非整体替换）：
env（`VISION_BASE_URL`/`VISION_MODEL`/`VISION_API_KEY`/`VISION_TIMEOUT_MS`/`VISION_MAX_BYTES`/
`VISION_FALLBACKS`（JSON 数组）/`VISION_DISABLE`，与 pi 参考实现同名同义）>
项目 `.deepseek-vl/config.json` > 全局 `~/.deepseek-vl/config.json` >
默认值（baseUrl `http://localhost:11434/v1`、timeoutMs 120000、maxBytes 10MB、enabled true）。

- `VISION_DISABLE=1` 或 config `enabled:false` → hook/MCP 全部 no-op（等价 pi 的"模型支持视觉时
  no-op"开关；hook stdin 拿不到模型名，只能人工/配置开关）。
- **API key 不进 settings.json / config.toml**（项目级会随 git 泄漏）。hook 与 MCP server 都直接
  读 `.deepseek-vl/config.json`（安装器确保 `.gitignore` 含 `.deepseek-vl/`）。settings.json 的
  env 块仅用于 `VISION_DISABLE` 开关。
- Windows 无 chmod：config.json 权限问题在文档中说明（可 icacls 加固，非默认）。

## 3. 视觉客户端（client.ts）

- `describe(file, question)`：POST `{baseUrl}/chat/completions`；messages = system（提示词）+
  user[text=question, image_url=data URI(base64+mime)]；返回 `choices[0].message.content`。
- **尺寸守卫（读文件后、base64 前）**：文件大小 > `maxBytes` → 抛 `VisionSizeError`（含
  实际大小/上限/压缩裁剪建议与推荐尺寸），不发请求。> 2MB → stderr 软警告（远程 API
  费用与延迟提示）。不做自动缩放（保持零依赖，见 PRD Out of Scope）。
- **兜底链**：primary 尝试失败（网络/超时/非 2xx/空 content/SizeError 之外的一切错误）→
  按序尝试 `fallbacks[]`；成功即返回（结果标注来自哪个模型，便于 doctor 与调试）；
  全部失败 → 抛出含整条链路失败摘要的错误。超时预算沿链共享：
  `min(timeoutMs, 剩余预算)`；hook 场景总预算 50s（hook 自身 timeout 60s 留缓冲）。
- 错误语义：非 2xx → 带 status + body 前 300 字的错误；空 content → 明确报错（非视觉模型）。
- `listModels()`：GET `{baseUrl}/models`，5s 超时；404/405（端点未实现该接口）→ 返回 null
  （doctor 降级为"无法列出模型"警告而非失败）。
- `doctor`：探测主模型可达性与模型存在；`--all` 时逐项探测兜底链并展示链路状态。

## 4. 提示词三级覆盖（prompt.ts）

`.deepseek-vl/vision-prompt.md`（项目）→ `~/.deepseek-vl/vision-prompt.md` → 包内置默认
（同 pi 的 `agents/vision.md`：穷尽描述可见文本、UI 布局、颜色、代码、报错、图标，先答问题再补细节）。
支持 frontmatter（`---` 分隔，取 body）。

## 5. 描述缓存（cache.ts）

- key = sha256(整文件) + mtimeMs + size + model；兜底链场景按**实际出结果的模型**写缓存
  （换模型/文件变化自然失效，不跨模型复用描述）。
- 存储：`.deepseek-vl/cache/<sha256>.json`（项目级）或 `~/.deepseek-vl/cache/`（全局）。
- 读取顺序：缓存命中 → 直接返回，不调 API（远程 API 计费，D2 场景的关键省钱点）。
- 上限：总大小 > 64MB 时按 mtime 淘汰最旧。缓存文件同时兼作"方案 B 临时描述文件"：
  内容为 `[Vision of <原路径>]:\n<描述>`，`updatedInput.file_path` 直接指向它（无额外生命周期）。

## 6. Claude Code hook 设计

### 6.1 PreToolUse（matcher `Read`，`hook-read` 入口）

输入 stdin JSON（UTF-8），输出 hook JSON 或 `{}`（空输出 = no-op，放行）：

1. 非 `PreToolUse`/`Read` → `{}` exit 0（防御）。
2. `tool_input.file_path` 相对路径 → 以 stdin `cwd` 解析为绝对路径。
3. **快速路径**（每次 Read 都走，必须 <5ms 级）：扩展名 ∈ {png,jpg,jpeg,gif,webp,bmp} 且
   magic bytes 匹配 → 图片；否则 `{}` exit 0，无任何网络/磁盘开销。
4. 配置 disabled / 未配 model → `{}` exit 0（不阻断模型正常工作）+ stderr 一行提示。
5. 尺寸守卫：> maxBytes → stderr 明确错误（压缩/裁剪建议）+ `{}` exit 0（Read 放行）。
6. 缓存命中 → 直接用缓存描述。
7. 调视觉 API（预算 50s，含兜底链）。成功 → 输出（方案 A 主选）：

```json
{
  "decision": "block",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "[Vision of foo.png]:\n<描述>"
  }
}
```

   方案 B（备选，spike 验证 A 的模型可见性后再定）：
   `permissionDecision:"allow"` + `updatedInput: { "file_path": "<缓存描述文件>" }` →
   模型 Read 到的是 `[Vision of …]` 文本文件，流程最自然；风险是 [UNK] 改写后的二次校验。

8. API 失败（含兜底链全部失败）→ stderr 通知 + `{}` exit 0（Read 照常执行，模型得到其原生
   省略提示）。
9. Windows 稳健性：node 脚本显式 `stdin.setEncoding("utf8")`；JSON 输出用 `process.stdout.write`
   单次写；绝不向 stdout 打印日志（日志全走 stderr）。

### 6.2 SessionStart（`hook-start` 入口，注册一条、不设 matcher = 覆盖 startup/clear/compact）

- 加载配置；disabled → `{}`。缺 model / baseUrl 不可达 / 模型不在列表（`/models`，5s）→
  `additionalContext` 注入 bilingual 警告块（引用 trellis session-start.py 的已验证形态）。
- **永远 exit 0**（非 0 会杀掉启动上下文注入）。

### 6.3 注册形态（installer 深合并进 settings.json）

```json
"hooks": {
  "PreToolUse": [ { "matcher": "Read",
      "hooks": [ { "type": "command", "command": "node .claude/hooks/deepseek-vision-hook.cjs", "timeout": 60 } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "node .claude/hooks/deepseek-vision-hook.cjs start", "timeout": 30 } ] } ]
}
```

（`--global` 时 command 为 `node "<展开后的绝对路径>\deepseek-vl\hooks\deepseek-vision-hook.cjs"`
——安装器写死展开的绝对路径并做 JSON 转义，不依赖 `~` 展开。）
用户已有的 Read/其他 hooks 全部保留（追加数组、不替换）。

### 6.4 skill 与 slash command

- `.claude/skills/deepseek-vision/SKILL.md`：frontmatter `name` + `description`（bilingual，
  触发词：截图/screenshot、UI、设计稿/mockup、图表/chart、报错截图、图片/描述）。
  正文：何时用（模型需要理解图片但看不到/读图结果被拦截时主动调用）、怎么用
  （Bash 跑 `npx deepseek-vl-support describe <file> "<问题>"`）、视觉提示词定制入口
  （references/vision-prompt.md）、失败指引（doctor）。`allowed-tools: Bash Read`（空格分隔，
  对齐 Agent Skills 开放规范 https://agentskills.io/specification；CC 官方文档明确接受
  空格/逗号/YAML 列表三种形式，空格形式对规范跟随实现可移植，详见
  docs/spec/agentskills-conformance.md）。
- `.claude/commands/vision.md`：命令体让模型跑 `npx deepseek-vl-support doctor`（可选 URL 参数）并报告。

## 7. Codex 设计

### 7.1 MCP server（stdio，手写 JSON-RPC）

- 实现 MCP 最小面：`initialize`（含 capabilities.tools）、`notifications/initialized` 忽略、
  `tools/list`（2 工具）、`tools/call`。协议消息 JSON-RPC 2.0；stdout 只走协议、stderr 走日志。
- 工具：`describe_image(path, question?)` → client.describe（含缓存）；`vision_status()` →
  配置摘要 + `/models` 列表 + 可达性诊断（模型可见即"自我诊断"）。
- 配置读取与 hook 同一解析链（cwd 起找 `.deepseek-vl/config.json` → 全局 → env）。

### 7.2 注册（codex.ts 写入项目 `.codex/config.toml` / 全局 `~/.codex/config.toml`）

```toml
[mcp_servers.deepseek-vl]
command = "npx"
args = ["-y", "deepseek-vl-support@<安装时锁定版本>", "mcp"]
tool_timeout_sec = 180
```

- 不写 env（secrets 由 server 自读 config.json，见 §2）；重复安装时整段替换（幂等），
  卸载删除该段；写前备份原文件。
- AGENTS.md 注入：`<!-- deepseek-vl:start -->` … `<!-- deepseek-vl:end -->` 标记段
  （bilingual、≤2KB：触发场景列表 + 工具用法 + "粘贴图片会丢失，保存为文件后调用
  mcp__deepseek-vl__describe_image" + 视觉失败时继续以文本工作）；项目 AGENTS.md 不存在则创建。
- **项目级另写 `.agents/skills/deepseek-vision/SKILL.md`**（2026-08-14 用户决定）：
  遵循 Codex skill 契约的工具（Cursor、GitHub Copilot、Kimi Code 等）读取该目录；内容 =
  打包的 `skills/deepseek-vision/SKILL.md`（`paths.ts#packagedSkillPath`），标记文件管理、
  幂等；全局级跳过并在报告注明。

### 7.3 DeepSeek 接入修复（research/codex-extension-mechanisms.md §7 详参）

- models.json bug（#36382：`supports_search_tool:true` 隐藏所有 MCP 工具）：安装器检测
  `~/.codex/models.json` 中 DeepSeek 条目 → 备份后改写该字段为 false，并提示；未找到文件则
  在 doctor 输出中给出修复提示。
- `wire_api = "chat"`：config.toml 缺失时提示（不擅自改用户模型配置——只在文档与向导中提示）。
- reasoning 模型（v4-r1 等）不支持 function calling → 向导选择 DeepSeek 模型时警告。
- `codex mcp add` CLI 可用但仅写 user 级；本项目自写 config.toml（项目级默认，D3），
  `codex mcp add` 作为备选路径保留说明。

## 8. 安装器（install.ts）

流程：`install [--global] [--target <agent,...>] [--non-interactive …]`，
`--target` 为逗号分隔的 agent 列表（claude / codex / opencode / trae / pi / omp /
dsh / qwen / reasonix / kilo / workbuddy / devin / copilot / cursor / kiro /
openclaw / hermes / vscode / chatgpt-codex / grok / nanoclaw / other 共 22 项；
默认 claude,codex；不再支持 both/plugin 取值）：
1. **简单编号菜单式向导**（bilingual；基于 `node:readline/promises`，零依赖；非交互模式走
   flags/env）：每步打印编号选项 + 默认值，输入数字选择、回车取默认、可跳过：
   ① 目标——**单个多选列表**（共 22 项，标签为纯名称（无检测/机制标注、无 `(default)`
   标记）；默认 claude,codex + 检测到的 agent；选中未检测到的 agent 时安装阶段输出
   "not detected — install it first" 提示，手动指引照常输出，不阻断其余）
   → ② 端点预设（顺序 D2，13 项 + "Decide later"：选后者跳过 baseUrl/key/模型/备用模型
   四步并输出警告——不配置模型将无法使用视觉功能，附 `config set` 补配指引；
   非交互等价 `--preset later`）→ ③ baseUrl（回车=预设默认）→ ④ API key（隐藏输入，
   回车跳过）→ ⑤ model id（回车=预设示例）→ ⑥ 备用模型（回车跳过，格式 `model@baseUrl`，
   可多个；**备用端点需要独立 API key 时**，向导提示安装后用 `config set fallbacks <json>`
   或直接编辑 config.json）→ ⑦ 作用域确认（项目/全局；项目标注推荐、置首、默认；
   **仅当选中 native agent（claude/codex/opencode/qwen/reasonix/kilo/workbuddy/devin）
   时询问**——skill/plugin agent 不触发）。
2. 写 config.json（**选中任一插件 agent 时写全局** `~/.deepseek-vl/`——插件 MCP 子进程
   只解析 env > 全局；否则按作用域项目 `.deepseek-vl/`；目录自动创建）→
   `.gitignore` 追加 `.deepseek-vl/`（仅项目作用域）。
3. 按 agent 逐项安装（任一失败不阻塞其余，结果聚合进统一 per-agent 报告）：
   claude → hook.cjs + skill + command + settings.json 深合并（备份 + 标记识别）；
   codex → config.toml 段 + AGENTS.md 段 + models.json 修复 + **项目级时写共享
   `.agents/skills/deepseek-vision/`**（全局级跳过并在报告注明）；
   opencode（native）→ `opencode.json` `mcp["deepseek-vl"]` type:"local" 深合并
   （项目/全局随作用域；备份 + 幂等）+ 共享技能；
   skill 型 agent——trae → 复制技能到 `.trae/skills/deepseek-vision/`（标记管理）+
   手动导入指引（MCP 不自动化）；pi → 共享技能 + 指引首选原生包
   `pi install npm:deepseek-vl-support`（用户级技能一条命令；0.2.4 起 package.json
   `pi.skills` 清单显式列出 ./skills + `pi-package` keyword，git 安装源同包根），
   检测到 pi-mcp-adapter 时才写 `~/.pi/agent/mcp.json`（工具面补充）；omp → 共享技能
   （omp 读 `.agents/skills/` priority 70）+ 指引 `omp install npm:deepseek-vl-support`
   （技能 + 包内 .mcp.json 自动注册 MCP，/reload-plugins 生效；回退读 pi 键；无配置
   文件可写——不写未验证路径）；dsh → 共享技能 + 仅指引（dev preview 不自动写配置）；
   native CLI agent（0.2.3 新增，项目/全局随作用域，检测 = PATH 多 bin + 配置目录回退）——
   qwen → `.qwen/skills/` 复制技能 + `settings.json` 深合并 `mcpServers` + `PreToolUse`
   (matcher Read) 钩子（`node "<abs hook.cjs>"`，JSONC → manual 不重写）；reasonix →
   共享技能 + 项目 `.mcp.json` / 全局 `config.toml` `[[plugins]]` 托管块（start/end 标记，
   追加/原位更新/移除三态，无标记外部块 → manual）+ `.reasonix/settings.json` 钩子；
   kilo → 共享技能 + `kilo.json` `mcp` 数组命令 + `enabled:true`（全局探测 kilo.json →
   kilo.jsonc，写已存在者）；workbuddy → `.codebuddy/skills/` 复制技能 + `.mcp.json`
   `type:stdio`（与 reasonix 共享项目 `.mcp.json`，互认幂等，JSONC → manual）；devin →
   共享技能 + `.devin/mcp_config.json` / 全局 `mcp_config.json`；
   **共享技能卸载归属**：`.agents/skills/deepseek-vision/` 由 codex 独占删除（标记校验），
   opencode/pi/omp/dsh 与新 CLI agent 卸载保留并输出说明（qwen/workbuddy 额外移除各自的
   技能副本与钩子文件）；
   插件 agent（copilot/cursor/kiro/openclaw/hermes/vscode/chatgpt-codex/grok/nanoclaw/other）
   → 物化 `~/.deepseek-vl/plugin/` 一次（恒 4 项）+ 逐客户端注册（生效集合 =
   `--target ∩ --clients`，`--clients` 为向后兼容过滤器；无 CLI → manual 指引；
   `other` 仅物化 + 通用契约指引）。
4. `doctor` 自检 → 成功/警告摘要 → 下一步提示（重启会话生效）。

幂等：每个产物先检测再写入（hook 条目按 command 字符串识别、AGENTS.md 按标记识别、toml 按
section 名识别）。**冲突保护**：skill 目录 / `commands/vision.md` 已存在且不含本工具标记 →
跳过并警告，绝不覆盖用户自写文件（settings.json 是合并追加，天然无冲突）。`--update` =
重新执行安装并覆盖 hook.cjs/模板文件。

**`uninstall` 移除矩阵**（按标记逆操作，操作前检测存在性；用户自写的同路径文件若不含
我们的标记 → 跳过并警告，绝不删除）：

| 产物 | 移除方式 |
|---|---|
| settings.json 中本工具 hook 条目（PreToolUse Read / SessionStart） | 按 command 字符串含 `deepseek-vision-hook` 识别删除；空数组清理 |
| `.claude/hooks/deepseek-vision-hook.cjs` | 删除文件（内容指纹校验后才删） |
| `.claude/skills/deepseek-vision/` | 删除目录（仅当 SKILL.md 首行含我们的标记） |
| `.claude/commands/vision.md` | 同上标记校验后删除 |
| `.codex/config.toml` 的 `[mcp_servers.deepseek-vl]` 段 | 整段删除（保留其余内容） |
| `.agents/skills/deepseek-vision/` | 项目级 codex 卸载时删除（标记校验；同目录其他 skill 保留，修剪空父目录） |
| AGENTS.md 中 `<!-- deepseek-vl:start/end -->` 段 | 移除标记段（其余内容无损） |
| `.gitignore` 的 `.deepseek-vl/` 行 | 仅 `--purge-config` 时移除 |
| config.json / 缓存 | 默认保留；`--purge-config` 删除整个 `.deepseek-vl/` |

卸载后输出摘要（移除了什么、保留了什么）；全程基于安装时留下的备份文件（`.bak`）可人工兜底。

## 9. 数据流（Claude Code 主路径）

```
模型(DeepSeek) Read foo.png
  → PreToolUse hook (node hook.cjs)  ← stdin: tool_name=Read, tool_input.file_path
    → 快速路径识别图片 → 缓存？→ 未命中: POST {baseUrl}/chat/completions (base64)
  → 成功: { decision:"block", additionalContext:"[Vision of foo.png]: …" }
  → 模型看到描述文本，基于它推理（原 Read 被 block）
失败路径: stderr 提示 + {} → Read 正常执行 → 模型得到原生省略提示
```

Codex 主路径：模型收到 AGENTS.md 指引 → 遇到图片任务主动调用
`mcp__deepseek-vl__describe_image` → 拿到描述 → 推理。

## 10. 风险与 spike 清单（实现期实证，结果写 research/spike-results.md）

1. 方案 A `block`+`additionalContext` 的描述是否确实到达模型（本机 Claude Code + DeepSeek 实测）。
2. 方案 B `updatedInput.file_path` 改写是否端到端生效（备选）。
3. 文本模型下 Read 图片的原生省略文案（决定"失败时放行"的体验下限）。
4. UserPromptSubmit 是否含图片数据（复核粘贴拦截可行性；预期不可行）。
5. Codex MCP 在 Windows 的网络访问是否受限（研究标注 must-test）。
6. Windows 路径/引号在 settings.json command 与 config.toml 中的正确转义。

## 11. 回滚与兼容性

- 卸载 = 按标记逆操作 + 备份文件（`.bak`）保留；安装器只追加/替换自己的条目。
- 版本兼容：Node ≥18（global fetch）；hook 脚本独立于 npm 包（升级 = `--update` 覆盖单文件）。
- 与用户已有 hooks 共存（同 matcher 全部执行，hook 快速路径保证零干扰）。

## 12. 发布形态（D6）

- npm 包 `deepseek-vl-support`，license MIT，bin 仅单一条目 `deepseek-vl-support`（与包名
  同名——标准发布形态，勿再添加别名；npx 冒烟须在包目录之外的独立目录执行，包目录内
  运行会命中本地 spec、npx 跳过安装而报 `'deepseek-vl-support' is not recognized`，
  与 bin 形态无关）。
- `files: dist/ assets/ README.md LICENSE`——tests/、.trellis/、pi-deepseek-vision-main/、
  research 均不进包；发布前 `npm pack --dry-run` 校验内容清单（AC12）。
- 版本规范：语义化版本，0.1.0 起；README 的 install 示例用 `@latest`，Codex config.toml
  与 hook 安装时锁定具体版本（防漂移）。
- 发布流程文档化（docs/releasing.md：version bump → pack 校验 → npm publish 清单）；
  `npm publish` 动作由用户确认后执行，不在本次自动执行。
