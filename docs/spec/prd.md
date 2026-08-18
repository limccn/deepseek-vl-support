# PRD: deepseek-vl-support — Claude Code & Codex 视觉增强

> 让使用 DeepSeek（纯文本模型）的 AI 开发工具（首批：Claude Code、Codex）获得视觉能力：
> Agent 遇到图片时，由第三方 VL 视觉模型（任意 OpenAI 兼容 `/v1/chat/completions` 端点）生成
> 详尽文本描述并注入上下文，使 DeepSeek 可以基于描述进行推理。
> 参考实现：pi-deepseek-vision（MIT，`pi-deepseek-vision-main/`）。

## Goal / 用户价值

DeepSeek 系列模型不支持图片输入，使用 DeepSeek 的 Claude Code / Codex 用户在遇到
截图（报错界面、UI 稿、图表、设计图）时模型"失明"，被迫切换带视觉的模型或人工转述。
本项目提供零侵入式增强：拦截图片 → 第三方 VL 模型描述 → 文本注入，DeepSeek 全程无感知、
按需启用（模型本身支持视觉时通过开关 no-op），并提供一键安装命令降低配置门槛。

## 背景与确认事实

### 参考实现（pi-deepseek-vision）

- 两个拦截点：粘贴图片（input 事件 → 描述替换注入 prompt）、`read` 图片文件
  （tool_result 事件 → 内容替换为 `[Vision: …]`）。
- 配置：`VISION_BASE_URL`（默认 `http://localhost:11434/v1`）、`VISION_MODEL`（必填）、
  `VISION_API_KEY`（可选）、`VISION_TIMEOUT_MS`（默认 120000）。
- 视觉提示词三级覆盖：用户覆盖 → 包内置 → 内置默认。
- 启动自诊断 + `/vision` 诊断命令；模型支持视觉时 no-op；失败只通知不崩溃。

### 本机环境

Windows Server 2022；node v24.14.1、npm 11.11.0、python 3.12.9、git 2.53.0 可用。

### Claude Code 扩展面（研究：`research/claude-code-hooks.md`）

- **图片文件读取可拦截**：PreToolUse hook（matcher `Read`）可返回
  `decision:"block"`+`additionalContext`（官方 hooks 指南的图片描述示例形态）或
  `updatedInput.file_path` 改写（指向临时文本文件）。两种方案实现期 spike 定稿。
- **粘贴图片不可拦截**：UserPromptSubmit 的 stdin 只有 prompt 文本，无图片数据 →
  粘贴场景改由 skill/文档引导"存为文件再 Read"。
- SessionStart hook（startup/clear/compact）可注入启动健康检查警告（本仓库 trellis
  hook 已验证该形态）；hook 必须 exit 0。
- hook 默认超时 60s；Windows 下脚本须强制 UTF-8（cp936 会损坏 JSON）。
- 配置走 settings.json `env` 块可直达 hook 进程；安装器必须深合并现有 JSON（hooks 数组
  追加、env 键保留），`claude config` CLI 管不了 hooks/env。
- skill（`~/.claude/skills/<name>/SKILL.md` 或项目 `.claude/skills/`）由模型按
  description 触发，是"主动使用"补充；slash command（`.claude/commands/<name>.md`）是
  模型执行的 markdown 任务，可运行 bash 代码块。
- hook stdin 不含模型名 → "支持视觉时 no-op" 用 `VISION_DISABLE` 开关实现。

### Codex 扩展面（研究：`research/codex-extension-mechanisms.md`）

- **Codex hooks 实验性且 Windows 不可用** → Codex 侧只能走 MCP + AGENTS.md（Agent
  主动调用），无法自动拦截；内置 `view_image` 无官方路由到外部模型，粘贴图片会丢失。
- MCP 注册：`~/.codex/config.toml`（user）或项目 `.codex/config.toml`（需 trusted）的
  `[mcp_servers.NAME]`（stdio `command`/`args`/`env`）；工具命名 `mcp__<server>__<tool>`。
- AGENTS.md 层级合并（user `~/.codex/AGENTS.md` + 项目根 AGENTS.md），32 KiB 上限。
- `codex mcp add <name> --env K=V -- <command>` 可编程写入 user 级配置。
- `tool_timeout_sec` 默认 60s，视觉推理需调高（120–300s）。

### DeepSeek 接入约束（研究结论，文档与安装器必须覆盖）

- `deepseek-chat`/`deepseek-reasoner` 别名已退役（2026-07-24），现为 v4-flash/v4-pro/v4-r1。
- **推理模型不支持 function calling，在 Codex 中不可用**（需非 reasoning 模型）。
- Codex models.json 已知 bug（#36382：`supports_search_tool:true` 隐藏所有 MCP 工具）
  → 安装器检测/修复；`wire_api = "chat"` 为必需配置。

## 关键决策（访谈结论）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 打包形态 | npm 包，`npx deepseek-vl-support@latest install` 一键安装 |
| D2 | VL 端点 | 远程 API 优先、本地端点殿后，共 13 个预设（顺序即向导顺序）：OpenRouter、Moonshot、MiniMax、Zhipu GLM、StepFun、OpenCode Zen、SiliconFlow 硅基流动、DashScope 百炼、Custom、Ollama、llama.cpp、vLLM、LM Studio |
| D3 | 安装作用域 | **默认项目级**（`.claude/`、`.codex/`、`.deepseek-vl/`），`--global` 可选（`~/.claude`、`~/.codex`） |
| D4 | 文档语言 | 中英双语（README、skill 指令、安装向导文案） |
| D5 | 验收方式 | mock 视觉服务器自动化验收 + 真实端点 E2E 作为 README 可选手册步骤 |
| D6 | 包名与发布 | npm 包 `deepseek-vl-support`（bin 单一条目 `deepseek-vl-support`，与包名同名；0.1.0 曾用别名 `deepseek-vl`，0.1.1 起统一单同名 bin——标准发布形态；npx 在包目录内报错是命中本地 spec、跳过安装的运行位置问题，非 bin 别名所致），公开发布 npm，MIT |

## Requirements

- **R1 核心视觉客户端**（npm 包 `deepseek-vl-support`，bin 单条目 `deepseek-vl-support` 与包名同名，Node ≥18，零运行时依赖）：
  - `describe(filePath, question?) → 文本`：POST `{baseUrl}/chat/completions`，
    `image_url` data URI（base64 + mime）；`doctor`：校验 URL/端口 + `/models` 列表检查；
    `config`：查看/设置配置。
  - 配置解析链：env（VISION_BASE_URL / VISION_MODEL / VISION_API_KEY / VISION_TIMEOUT_MS /
    VISION_MAX_BYTES / VISION_FALLBACKS，与参考实现同名同义）> 项目 `.deepseek-vl/config.json` >
    全局 `~/.deepseek-vl/config.json` > 默认值（baseUrl `http://localhost:11434/v1`，
    timeout 120000，maxBytes 10MB）。
  - **大尺寸对象限制**：超过 `maxBytes` 的图片拒绝发送并给出明确错误（提示压缩/裁剪，
    附推荐尺寸），流程不卡死（hook 放行、CLI 报错退出码非 0）；2MB 以上软警告（费用/延迟提示）。
    首批不做自动缩放/压缩（保持零依赖，后续可作为可选增强）。
  - **模型兜底**：`fallbacks` 链（主模型失败按序降级到备用模型/端点；env `VISION_FALLBACKS`
    JSON 数组），全部失败时报错含链路信息；`doctor` 展示主/备链路状态。
  - 提示词三级覆盖：`.deepseek-vl/vision-prompt.md`（项目）/`~/.deepseek-vl/vision-prompt.md` >
    包内置 `agents/vision.md` > 内置默认；提问与系统提示词分离（同参考实现）。
  - **描述缓存**：key = sha256(文件) + mtimeMs + size + model（换视觉模型不复用旧描述），
    存 `.deepseek-vl/cache/`（gitignored）——远程 API 计费，重复读取同一图片不重复调用；
    兜底链成功时按实际出结果的模型缓存。
- **R2 Claude Code 增强**（默认项目级，`--global` 可选）：
  - PreToolUse hook（matcher `Read`）：识别图片文件（扩展名 + magic bytes）→ 调用视觉
    客户端 → 描述注入（方案 A `block`+`additionalContext` / 方案 B `updatedInput` 临时文件，
    spike 定稿）；非图片 Read 本地快速放行（无网络开销）；失败 exit 0 不阻断。
  - SessionStart hook（startup/clear/compact）：轻量 doctor（5s 超时）→ 警告块注入上下文。
  - hook 以独立零依赖 node 脚本形式由安装器复制进项目（避免 npx 延迟与更新漂移）。
  - skill `.claude/skills/deepseek-vision/`：主动使用场景（截图/UI/设计稿/图表/报错图），
    触发 description 覆盖这些词；提示词模板放 references/。
  - `/vision` slash command：跑 `npx deepseek-vl-support doctor` 并报告结果，`$ARGUMENTS` 可选 URL。
  - `VISION_DISABLE=1`（settings env 块）→ 全部 no-op。
- **R3 Codex 增强**（MCP 方案）：
  - MCP server（stdio）：`describe_image(path, question?)` + `vision_status()` 工具。
  - 安装器写入 `[mcp_servers.deepseek-vl]`（项目 `.codex/config.toml` 默认 / `~/.codex` 全局）；
    **不写 env（视觉配置与 API key 由 server 自读 config.json，防泄漏）**；`tool_timeout_sec`
    调至 120–300。
  - AGENTS.md 注入段（紧凑、bilingual、触发场景列举）；32 KiB 上限内。
  - **项目级安装另写 `.agents/skills/deepseek-vision/SKILL.md`**（标记管理；供遵循 Codex
    skill 契约的工具读取——Cursor、GitHub Copilot、Kimi Code 等；全局级跳过，卸载只删
    自己的目录）。
  - 安装器检测并修复 DeepSeek 接入坑：models.json `supports_search_tool` 隐藏 MCP 工具的
    bug、`wire_api = "chat"`、非 reasoning 模型提示。
  - 局限写入文档：Codex 无自动拦截，粘贴图片会丢失，需保存文件后由 Agent 调用工具。
- **R4 一键安装**（D1/D3）：
  - `npx deepseek-vl-support@latest install`：**简单编号菜单式向导**（每步列出选项按数字选择、
    带默认值回车即可跳过：第一步为**单个多选列表**（claude / codex / opencode / trae /
    pi / omp / dsh / qwen / reasonix / kilo / workbuddy / devin / copilot / cursor / kiro /
    openclaw / hermes / vscode / chatgpt-codex / grok /
    nanoclaw / other 共 22 项，标签为纯名称（无检测/机制标注），选中未检测到的 agent 时
    安装阶段输出"not detected — install it first"提示；`other` 为通用「Other agents that
    support the Agent Plugins open standard」选项；取代旧的 claude/codex/both 单选与单独
    插件客户端步骤）→ 端点预设（13 项：OpenRouter / Moonshot / MiniMax / Zhipu GLM /
    StepFun / OpenCode Zen / 硅基流动 / 百炼 / 自定义 / Ollama / llama.cpp / vLLM /
    LM Studio，外加 "Decide later"：选中则跳过 baseUrl/key/模型/备用模型四步并警告
    不配置模型将无法使用视觉功能，附 `config set` 补配指引）→ baseUrl（预设默认）→
    API key（可跳过）→ 模型 id（预设示例）→ 备用模型（可跳过）→ 作用域（项目标注推荐、
    置首、默认；仅当选中 native agent（claude/codex/opencode/qwen/reasonix/kilo/
    workbuddy/devin）时询问——skill/plugin agent 不触发）→ 写配置 → 安装文件 →
    深合并配置 → 自动 doctor → 下一步提示。
  - 幂等（重复执行不重复追加）；`--update` 覆盖升级；**`uninstall` 一键卸载**：按标记移除
    全部注入产物（hooks 条目、hook 脚本、skill、command、MCP 段、AGENTS.md 段、.gitignore 行），
    用户原配置无损，config.json 与缓存默认保留（`--purge-config` 才删除）；
    `--non-interactive`（flags/env）供 CI。
  - `.gitignore` 追加 `.deepseek-vl/`（含 API key 的 config.json 与缓存不进仓库）。
- **R5 文档**（D4 中英双语）：README（环境要求 Node ≥18、安装、各端点配置示例：
  OpenRouter/硅基流动/百炼/本地四类、大图限制与兜底模型配置、Claude Code 与 Codex 用法、
  故障排查：Windows UTF-8、hook 超时、models.json bug、推理模型不可用）+
  真实端点 E2E 手手册步骤（D5）。
- **R6 测试**（D5）：node:test 单测（视觉客户端 mock 服务器、配置解析链、图片识别、
  安装器合并/幂等/卸载逻辑）；mock 视觉服务器端到端冒烟（describe/doctor/MCP 握手）；
  tsc --noEmit + lint 全绿。

## Acceptance Criteria

1. 全新环境执行 `npx deepseek-vl-support@latest install` → 向导完成配置 → `doctor` 通过（mock 端点）。
2. DeepSeek 模型下，Agent Read 图片文件 → 视觉描述以文本注入上下文（hook 拦截，spike 验证）。
3. 视觉端点不可达 / 模型不存在 / 缺配置 → 明确诊断信息，Agent 流程不崩溃（hook exit 0）。
4. `VISION_DISABLE=1` → 全部增强 no-op；`uninstall` → 注入产物按标记全部移除，
   用户原配置无损，config 与缓存保留（`--purge-config` 才删）。
5. 安装幂等：重复执行不重复追加 hooks/MCP/AGENTS.md 段、不破坏既有配置。
6. 相同图片重复读取命中缓存（不重复调用视觉 API）。
7. mock 自动化测试全绿；README 的真实端点 E2E 手册步骤可执行。
8. Windows 下中文描述输出无乱码（UTF-8 安全）。
9. Codex + DeepSeek 接入后 MCP 工具可见（models.json bug 已处理或已明确提示）。
10. 超过 maxBytes 的图片 → 明确错误信息（含压缩/裁剪建议），hook 场景放行不卡流程。
11. 主视觉模型失败 → 自动降级备用模型；全部失败时错误信息含链路状态，Agent 流程不崩溃。
12. `npm pack --dry-run` 产物包含 dist/assets/README/LICENSE 且不含 tests/.trellis；发布流程
    （版本规范、发布清单）文档化，`npm publish` 动作由用户确认后执行。

## Out of Scope（首批）

- 其他 Agent 工具（pi / OpenCode / Cursor / Gemini CLI 等）→ 后续批次。
- 视频 / PDF / 多模态文档。
- 自建视觉服务托管 / 代理层（纯客户端方案）。
- 缓存管理界面 / 用量统计面板。
- 大图自动缩放/压缩（需原生依赖如 sharp，破坏零依赖约束；先做拒绝+建议，后续可选增强）。
