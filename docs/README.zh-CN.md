# deepseek-vl-support

> **English** → [README.md](../README.md)

给 Claude Code 与 Codex 里的 DeepSeek（纯文本）模型补上「眼睛」：把图片文件转发给任意
OpenAI 兼容的视觉端点（OpenRouter、硅基流动、百炼、Ollama、llama.cpp、vLLM、LM Studio…）。
零运行时依赖，MIT 协议。

```
模型(DeepSeek)  Read foo.png
  → PreToolUse hook (node hook.cjs)
      → 识别图片 → 未命中缓存 → POST {baseUrl}/chat/completions (base64)
  → block + additionalContext: "[Vision of foo.png]: <详细描述>"
  → 模型基于描述继续推理（原 Read 被替换为文本描述）
```

## 功能

- **Claude Code**：PreToolUse(Read) hook 自动拦截图片文件，把视觉端点返回的详细描述作为
  `additionalContext` 注入；SessionStart 启动自检；`/vision` 斜杠命令；Agent Skills 技能。
- **Codex**：MCP stdio server（`describe_image` / `vision_status` 两个工具）+ AGENTS.md 指引 +
  自动修复 models.json bug（openai/codex#36382，`supports_search_tool` 会导致 MCP 工具全部不可见）。
- **描述缓存**：`sha256+mtimeMs+size+model` 键，64MB LRU，同一图片同一模型二次读取不重复计费。
- **兜底模型链（fallbacks）**：主模型失败按序降级，共享整体时间预算。
- **一键安装/卸载**：数字菜单向导，幂等，写前 `.bak` 备份，标记校验保护用户自写文件。

## 环境要求

- Node.js ≥ 18（零运行时依赖，仅 devDependencies）
- 一个 OpenAI 兼容的视觉端点（远程或本地）

## 快速开始

```bash
# 在目标项目目录内运行（向导交互式）
npx deepseek-vl-support@latest install
# 或安装到 PATH 后：
deepseek-vl-support install
```

> 两条命令等价：`npx deepseek-vl-support@latest …` 与安装后本地 `deepseek-vl-support …`
> 指向同一个 bin（包内只提供与包名同名的单一 bin 条目 `deepseek-vl-support`）。
> 注意：请在**包目录之外**运行 `npx deepseek-vl-support@latest …`——在包自身目录内运行
> 时本地 package.json 会命中 spec，npx 跳过安装，cmd 报 `'deepseek-vl-support' is not
> recognized`（属运行位置问题，与包内容无关）。

向导按编号菜单逐步确认（每步都有默认值、可回车跳过）：

1. 目标工具：`claude` / `codex` / `both`（默认 both）
2. 视觉端点预设：OpenRouter → 硅基流动 → 百炼 → 自定义 → Ollama → llama.cpp → vLLM → LM Studio
3. 端点地址（base URL，OpenAI 兼容，以 `/v1` 结尾）
4. API key（回车跳过；只写入 `.deepseek-vl/config.json`，`.gitignore` 已自动添加 `.deepseek-vl/`）
5. 视觉模型 id（如 `qwen2.5vl:7b`）
6. 兜底模型（可选，`model@baseUrl, model2` 或 JSON 数组）
7. 安装作用域：项目级（`.claude/` `.codex/`）或全局（`~/.claude` `~/.codex`）

安装完成后按提示重启会话：

- Claude Code：重启会话使 hook 生效，此后 Read 图片文件即自动注入视觉描述；
- Codex：重启会话，用 `codex mcp list` 验证 `deepseek-vl` server 已连接。

CI / 非交互安装（全部参数可 flag 或环境变量传入）：

```bash
npx deepseek-vl-support install --non-interactive \
  --target claude --preset openrouter \
  --base-url https://openrouter.ai/api/v1 --model qwen/qwen2.5-vl-72b-instruct \
  --api-key sk-... --fallbacks "qwen/qwen2.5-vl-72b-instruct@https://api.siliconflow.cn/v1"
# 或导出环境变量：VISION_BASE_URL VISION_MODEL VISION_API_KEY VISION_FALLBACKS DVLS_TARGET DVLS_SCOPE
```

先看效果再动手：

```bash
npx deepseek-vl-support install --non-interactive --dry-run --target both
# 预览将写入哪些文件，不实际写入
```

## 端点配置示例

| 端点 | base URL | 示例模型 |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen2.5-vl-72b-instruct` |
| SiliconFlow 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| DashScope 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5vl:7b`（先 `ollama pull qwen2.5vl:7b`） |
| llama.cpp（本地） | `http://localhost:8080/v1` | `llava`（`llama-server -m llava.gguf`） |
| vLLM（本地） | `http://localhost:8000/v1` | `deepseek-ai/deepseek-vl2` |
| LM Studio（本地） | `http://localhost:1234/v1` | `qwen2.5-vl-7b-instruct` |

## 配置

解析优先级（逐字段覆盖）：环境变量 `VISION_*` > 项目 `.deepseek-vl/config.json` >
全局 `~/.deepseek-vl/config.json` > 默认值（`http://localhost:11434/v1`，timeout 120000ms，
maxBytes 10MB，enabled true）。

```jsonc
// .deepseek-vl/config.json（可由 `deepseek-vl-support config set <key> <value>` 修改）
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen2.5-vl-72b-instruct",
  "apiKey": "sk-...",                    // 可省略；仅存在 .deepseek-vl/config.json
  "timeoutMs": 120000,                   // 单次请求超时（兜底链共享总预算）
  "maxBytes": 10485760,                  // 大图限制：超过直接跳过并提示压缩/裁剪
  "fallbacks": [
    { "model": "Qwen/Qwen2.5-VL-72B-Instruct", "baseUrl": "https://api.siliconflow.cn/v1" },
    { "model": "qwen2.5vl:7b" }          // 缺省字段继承主配置
  ]
}
```

- **大图限制（maxBytes）**：默认 10MB。超过限制的图片不做描述（hook 放行 Read、提示压缩/裁剪；
  >2MB 有软警告）。改小可省流量：`deepseek-vl-support config set maxBytes 5242880`。
- **兜底模型（fallbacks）**：主模型失败（网络/HTTP/超时/空响应）按序降级；`model@baseUrl` 逗号
  语法或 JSON 数组均可。`deepseek-vl-support doctor --all` 逐一诊断。
- **关闭视觉**：`VISION_DISABLE=1` 或 `enabled:false` → hook / MCP 全部 no-op。
- 查看/修改配置：`deepseek-vl-support config get [key]` / `deepseek-vl-support config set <key> <value>` /
  `deepseek-vl-support config path`。

## 用法

### Claude Code（自动）

- 会话中 Read 任何图片（png/jpg/jpeg/gif/webp/bmp）→ 自动注入 `[Vision of <file>]: <描述>`；
- `/vision <图片路径> [问题...]` 斜杠命令手动描述；
- Agent Skills：`deepseek-vision` 技能，提示词可覆盖（项目 `.deepseek-vl/vision-prompt.md` >
  全局 > 内置默认）。

### Codex（MCP 工具）

- `mcp__deepseek-vl__describe_image(path, question?)` — 描述图片（含缓存）；
- `mcp__deepseek-vl__vision_status()` — 配置摘要 + 端点健康检查；
- AGENTS.md 已注入使用指引；DeepSeek 模型看不到图片本身，让它调用上述工具获取文本描述。
- **项目级安装需先信任项目**：codex 只在已信任目录加载项目级 `.codex/config.toml` 的 MCP 段——
  未信任时该段被静默忽略（仅 user 级服务器可见），非交互 `codex exec` 甚至直接拒绝运行
  （"Not inside a trusted directory"）。项目级安装后，请先在交互式 `codex` 会话中信任该项目；
  CI / 非交互 / 未信任场景请改用 `--global` 安装。

## 卸载

```bash
deepseek-vl-support uninstall            # 移除 hook/技能/命令/MCP 注册，保留配置与缓存
deepseek-vl-support uninstall --purge-config   # 连 .deepseek-vl/（配置+缓存）与 .gitignore 条目一起删除
deepseek-vl-support uninstall --global --target codex
```

只删除带本工具标记的文件；用户自写文件（无标记）一律跳过并提示。所有修改前先备份 `.bak`。

## 故障排查

- **Windows 中文乱码 / JSON 损坏**：hook 与 CLI 强制 UTF-8 输出；终端乱码请 `chcp 65001`
  或在 Windows Terminal / VS Code 终端中运行（默认 UTF-8）。
- **hook 超时**：每次 Read 的视觉调用总预算 50 秒（含兜底链）。端点慢或图片大时模型等待更久；
  优先缩短 maxBytes、换更快的端点。
- **Codex 看不到 `mcp__deepseek-vl__*` 工具**：openai/codex#36382 — DeepSeek models.json 的
  `supports_search_tool: true` 会隐藏所有 MCP 工具。安装器已自动修复；手工修复：
  `~/.codex/models.json` 中把 DeepSeek 条目改为 `"supports_search_tool": false`。
- **Codex 首次调用 MCP 工具需批准**：交互会话首次调用 `mcp__deepseek-vl__*` 会弹批准提示，
  点一次 Allow 即可（codex 对所有 MCP server 的标准行为，非本工具特有）；非交互
  `codex exec`（approval_policy=never）下 MCP 调用会被自动取消（"user cancelled MCP tool
  call"），该场景请改用 CLI 命令 `deepseek-vl-support describe <file>`。
- **推理模型不可用**：DeepSeek v4-r1 / reasoning 模型不支持函数调用（tool use）。Codex 配置需
  `[model_providers.deepseek] wire_api = "chat"` 并使用非推理模型；视觉侧也建议用非推理视觉模型。
- **粘贴图片的局限**：Claude Code 里 Ctrl+V 粘贴的图片走编辑/粘贴通道，不走 Read hook，无法自动
  描述。保存为文件后用 Read（或 `/vision` 命令、Codex 的 describe_image 工具）。
- **`[Unsupported Image]` 兜底文案**：视觉关闭（VISION_DISABLE / enabled:false）时模型 Read
  图片只看到占位文案 `[Unsupported Image]`（不会崩溃），且通常会主动发现并建议调用
  `deepseek-vision` skill——按提示操作即可。
- **图片过大**：超过 maxBytes 被跳过——先压缩/裁剪（如 5MB 以内、长边约 2000px）。
- **端点不可达**：`deepseek-vl-support doctor` 输出详细诊断；确认 base URL 以 `/v1` 结尾、模型 id 与
  `/v1/models` 列表一致（ollama 可用 `./qwen2.5vl:7b` 形式，内部已归一化比较）。

## 开发

```bash
npm install            # devDeps: typescript esbuild @types/node
npm run build          # esbuild → dist/cli.js + dist/hook.cjs + assets/
npx tsc --noEmit       # typecheck
node --test tests/     # mock 自动化测试（需先 build）
```

真实端点端到端手册见 `e2e-real-endpoint.md`；发布流程见 `releasing.md`。

## 致谢

本项目灵感来自 [pi-deepseek-vision](https://github.com/psychobarge/pi-deepseek-vision)，
感谢原作者 psychobarge 的开源工作。

## 协议

[MIT](../LICENSE)
