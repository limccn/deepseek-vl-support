# deepseek-vl-support

> **English** → [README.md](../README.md)

## 它能做什么

有些 AI 模型（比如 DeepSeek）只能读文字：它们能看你的文件，却看不了图片。报错截图、
界面草图、图表、手写笔记照片——这些对它们来说都是"看不见"的。

这个小工具就是给它们装上"眼睛"。装好之后，每当模型想读一张图片，工具会把图片发给一家
你选的"看图服务"（Moonshot、MiniMax、智谱、OpenRouter、Ollama……），拿回一段详细的文字
描述，再把描述交给模型。模型拿着这段描述继续干活，就像真的看见了图片一样。

```
模型(DeepSeek)  Read screenshot.png
  → 本工具在读取时拦截
  → 图片 → 你的看图服务 → 返回详细的文字描述
  → 模型收到："[Vision of screenshot.png]: <详细描述>"
  → 模型继续基于描述推理
```

不用改模型设置，不用写配置文件——一次性设置后全自动运行。一条命令安装，一条命令卸载。
MIT 开源协议。

## 适合谁用

- 你在用 **Claude Code** 或 **Codex**，接的是 DeepSeek（或其他纯文字）模型。
- 你想让模型看懂图片：报错截图、界面草图、图表、手写笔记照片。

## 开始之前（需要准备什么）

1. **Node.js 18 或更高版本。** 在终端运行 `node -v`——能打印出版本号就说明可以了。
   没有的话去 <https://nodejs.org> 安装。
2. **一家看图服务的账号，以及它的 API key。** 看图服务就是帮你"看图片"的网站。可以注册的
   云端服务：**Moonshot**、**OpenRouter**、**MiniMax**、**智谱 GLM**、**StepFun**、
   **OpenCode Zen**、**SiliconFlow（硅基流动）**、**DashScope（阿里云百炼）**。免费的本地
   方案：**Ollama**、**llama.cpp**、**vLLM**、**LM Studio**（这些跑在你自己的电脑上）。
   **API key** 是这家服务发给你的密钥（一般在它网站的"API 密钥"页面里）。安装时问一次，
   只存在你自己的电脑上。
3. 已安装 Claude Code 或 Codex。

## 安装（大约 2 分钟）

在**你的项目文件夹**里打开终端：

```bash
cd path/to/your/project
npx deepseek-vl-support@latest install
```

会出现一个带编号的菜单，共 7 个问题。**大部分都有合适的默认值——直接按回车即可。**

| # | 问题 | 什么意思 | 默认值 |
|---|---|---|---|
| 1 | 增强哪个工具？ | 你用的 AI 工具：`claude` / `codex` / `both`（两个都装） | both |
| 2 | 视觉端点预设 | 用哪家"看图服务"——选你注册了账号的那家（见下方端点表） | openrouter |
| 3 | 端点地址（Base URL） | 那家服务的地址（预设已帮你填好） | 来自预设 |
| 4 | API key | 那家服务的密钥；只存在你自己的电脑上 | 回车跳过 |
| 5 | 视觉模型 id | 用哪双"眼睛"（预设已帮你填好） | 来自预设 |
| 6 | 兜底模型 | 主服务失灵时的备用"眼睛"（可不填） | 回车跳过 |
| 7 | 安装范围 | 只装这个项目，还是所有项目 | project |

装完之后：

1. **重启会话**——安装器会打印这条提醒，必须重启才能生效。
2. 可选检查——运行健康检查，看到 `[OK]` 就说明一切正常：

```bash
npx deepseek-vl-support@latest doctor
```

动手前先预览（只打印将要写入的内容，不真正写文件）：

```bash
npx deepseek-vl-support@latest install --dry-run
```

> 提示：请在**你自己的项目文件夹**里运行 `npx deepseek-vl-support@latest …`。在这个工具
> 自己的源码目录里运行会踩到一个已知的 npx 怪癖（`'deepseek-vl-support' is not
> recognized`）——这是运行位置的问题，不是包的问题。

## 试一试

最快的验证方式——直接在终端里描述一张图片：

```bash
npx deepseek-vl-support@latest describe path/to/a/picture.png
```

返回一段像样的文字描述 → 说明一切接线正确。

从此以后：

- **Claude Code**：在会话里 Read 任何图片（png / jpg / jpeg / gif / webp / bmp）——模型会
  自动收到描述。手动方式：`/vision path/to/picture.png "你的问题"`。
- **Codex**：让模型调用 `mcp__deepseek-vl__describe_image(path)`；
  `mcp__deepseek-vl__vision_status()` 显示当前设置和健康检查结果。

## 端点参考

| 端点 | base URL | 示例模型 |
|---|---|---|
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-32k-vision-preview` |
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen2.5-vl-72b-instruct` |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-VL-01` |
| Zhipu GLM 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| StepFun | `https://api.stepfun.com/v1` | `step-1o-turbo-vision` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `mimo-v2.5-free` |
| SiliconFlow 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| DashScope 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5vl:7b`（先 `ollama pull qwen2.5vl:7b`） |
| llama.cpp（本地） | `http://localhost:8080/v1` | `llava`（`llama-server -m llava.gguf`） |
| vLLM（本地） | `http://localhost:8000/v1` | `deepseek-ai/deepseek-vl2` |
| LM Studio（本地） | `http://localhost:1234/v1` | `qwen2.5-vl-7b-instruct` |

## 常用命令速查

| 想做什么 | 命令 |
|---|---|
| 安装 | `npx deepseek-vl-support@latest install` |
| 健康检查 | `npx deepseek-vl-support@latest doctor`（加 `--all` 连兜底模型一起检查） |
| 现在就描述一张图片 | `npx deepseek-vl-support@latest describe picture.png` |
| 查看当前设置 | `npx deepseek-vl-support@latest config get` |
| 修改一项设置 | `npx deepseek-vl-support@latest config set maxBytes 5242880` |
| 卸载 | `npx deepseek-vl-support@latest uninstall` |
| 卸载并删除设置 | `npx deepseek-vl-support@latest uninstall --purge-config` |

## 修改设置

你的回答保存在项目文件夹里的 `.deepseek-vl/config.json`。一般永远不用动它。值得知道的
两项设置：

| 设置 | 含义 | 默认值 |
|---|---|---|
| `maxBytes` | 超过这个大小的图片会被跳过（省时省钱） | 10485760（10 MB） |
| `timeoutMs` | 等一次描述要多久 | 120000（2 分钟） |

示例——跳过超过 5 MB 的图片：

```bash
npx deepseek-vl-support@latest config set maxBytes 5242880
```

同一张图片描述两次是免费的：结果缓存在你的电脑上（上限 64 MB）。图片变了才会重新描述。

## 故障排查

| 现象 | 怎么办 |
|---|---|
| 模型还是不描述图片 | 1) 重启会话（安装后必须重启）。2) 运行 `… doctor`，看有没有 `[OK]`。 |
| `doctor` 显示 "unreachable" 或没有 `[OK]` | 服务地址或密钥不对：确认 base URL 以 `/v1` 结尾、API key 正确。（如果服务不公开模型列表，`doctor` 会改为显示警告——只要说 reachable 就没问题。） |
| 提示 "image too large" | 图片超限了——先压缩或裁剪（比如 5 MB 以内、长边约 2000 像素），或者用 `config set maxBytes …` 调大限制。 |
| 描述很慢 | 调低限制（`config set maxBytes 5242880`），或换一个更快的端点。 |
| 粘贴（Ctrl+V）的图片不被描述 | 粘贴的图片不走 Read 通道——先把图片存成文件再 Read（或用 `/vision` / `describe_image`）。 |
| Codex 里看不到 `mcp__deepseek-vl__*` 工具 | Codex 的一个已知 bug 会隐藏它们。安装器会自动修复；手动修复：在 `~/.codex/models.json` 里把 DeepSeek 条目的 `"supports_search_tool"` 设为 `false`。 |
| Codex 第一次调用工具要批准 | 任何 MCP server 都会这样——点一次 Allow 即可。非交互 `codex exec` 场景请改用 `deepseek-vl-support describe <file>`。 |
| Windows 终端显示乱码 | 运行 `chcp 65001`，或改用 Windows Terminal / VS Code 终端。 |
| DeepSeek v4-r1 / 推理模型用不了 | 推理模型不支持调用工具。Codex 里使用 `[model_providers.deepseek] wire_api = "chat"` 并搭配非推理模型；视觉端也建议用非推理视觉模型。 |
| 没反应，模型只看到 `[Unsupported Image]` | 视觉被关掉了（`VISION_DISABLE=1` 或配置里 `enabled: false`）——打开开关即可恢复。 |

## 进阶用法（可选）

完整设置示例（`.deepseek-vl/config.json`，可用 `deepseek-vl-support config set <key> <value>`
修改）：

```jsonc
{
  "baseUrl": "https://api.moonshot.cn/v1",
  "model": "moonshot-v1-32k-vision-preview",
  "apiKey": "sk-...",                    // 可省略；只存在 .deepseek-vl/config.json
  "timeoutMs": 120000,                   // 单次请求超时（兜底链共享总预算）
  "maxBytes": 10485760,                  // 超过此大小的图片会被跳过
  "fallbacks": [
    { "model": "Qwen/Qwen2.5-VL-72B-Instruct", "baseUrl": "https://api.siliconflow.cn/v1" },
    { "model": "qwen2.5vl:7b" }          // 缺省字段继承主配置
  ]
}
```

- **兜底模型**：主服务失败（网络错误 / 超时 / 空回答）时按顺序换下一个，共享一个时间预算。
  `doctor --all` 逐个检查。
- **环境变量**逐字段覆盖配置文件：`VISION_BASE_URL`、`VISION_MODEL`、`VISION_API_KEY`、
  `VISION_FALLBACKS`、`DVLS_TARGET`、`DVLS_SCOPE`；`VISION_DISABLE=1` 或配置 `enabled:false`
  可整体关闭视觉（hook / MCP 全部 no-op）。
- **查看 / 修改配置**：`config get [key]` / `config set <key> <value>` / `config path`。
- **自定义提示词（Claude Code 技能）**：项目 `.deepseek-vl/vision-prompt.md` > 全局 > 内置默认。
- **Codex 项目级安装需先信任项目**：codex 只在已信任目录加载项目级 MCP 配置；项目级安装后
  请先在交互式会话中信任该项目，CI / 非交互场景请改用 `--global` 安装。
- **非交互 / CI 安装**（无菜单，全部用参数）：

```bash
npx deepseek-vl-support@latest install --non-interactive \
  --target both --preset custom \
  --base-url https://api.moonshot.cn/v1 --model moonshot-v1-32k-vision-preview \
  --api-key sk-... --fallbacks "qwen/qwen2.5-vl-72b-instruct@https://openrouter.ai/api/v1"
```

## Agent Plugins 模式（Copilot / Cursor / Kiro / OpenClaw / Hermes）

除了 Claude Code 和 Codex，本包还以 [Agent Plugins v1.0.0](https://agent-plugins.org)
可移植插件的形式发布（仓库根目录 `plugin.json` + `mcp.json` +
`skills/deepseek-vision/SKILL.md`）。
支持插件的智能体也可以获得视觉能力：
`deepseek-vision` 技能 + `describe_image` / `vision_status` 两个 MCP 工具，
共用同一套端点配置。MCP 服务器以 `npx -y deepseek-vl-support mcp` 启动
（环境需包含 npm/npx），并附带与 `mcp.json` 逐字节一致的 `.mcp.json`
以适配 Copilot 的原生 MCP 约定。

```bash
# 一键安装：把插件目录复制到 ~/.deepseek-vl/plugin/ 并注册到所选客户端
#（菜单默认勾选检测到的客户端）
npx deepseek-vl-support@latest install --target plugin

# 非交互：用 --clients 明确指定客户端（默认全部）
npx deepseek-vl-support@latest install --target plugin --clients copilot,cursor
```

各客户端行为：

| 客户端 | 安装 | 验证 | 卸载 |
|---|---|---|---|
| GitHub Copilot | `copilot plugin install` + marketplace add（CLI 缺失时回退为写 `~/.copilot/settings.json` 的 `enabledPlugins`） | `copilot plugin list`，然后在会话里让它描述截图 | `copilot plugin uninstall deepseek-vl-support` |
| Cursor | 复制插件目录到 `~/.cursor/plugins/local/deepseek-vl-support/`（带标记） | Developer → Reload Window 后技能 / MCP 服务器出现 | 重跑安装器的卸载（只删带标记的目录） |
| Kiro | 手动——Kiro 没有命令行自动化入口 | Kiro → Powers 面板 → Add Custom Power → Import power from a folder → 选择 `~/.deepseek-vl/plugin` | 同一面板移除该 power |
| OpenClaw | `openclaw plugins install ~/.deepseek-vl/plugin` + `openclaw gateway restart` | `openclaw plugins list`，然后让它描述截图 | `openclaw plugins uninstall deepseek-vl-support` |
| Hermes Agent | `hermes plugins install limccn/deepseek-vl-support --no-enable` + `hermes plugins enable deepseek-vl-support` | `hermes plugins list`，确认技能可被发现 | `hermes plugins uninstall deepseek-vl-support` |

单个客户端失败不会阻塞其他客户端——安装器逐客户端报告并给出指引（失败通常只是
「重启应用」或一条手动命令）。

插件客户端的配置是**环境变量或全局级别**：`install --target plugin` 总是写入
`~/.deepseek-vl/config.json`（没有项目/全局选择），客户端启动的 MCP 子进程能看到
`VISION_*` 环境变量。项目级 `.deepseek-vl/config.json` 对它们不可见——请用
`npx deepseek-vl-support@latest config set <key> <value> --global` 或
`VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY`。

卸载会撤销注册并保留已物化的插件目录：

```bash
npx deepseek-vl-support@latest uninstall --target plugin              # 保留配置
npx deepseek-vl-support@latest uninstall --target plugin --purge-config   # 连同配置/缓存一起删除
```

## 开发者

```bash
npm install            # 仅 devDependencies：typescript esbuild @types/node
npm run build          # esbuild → dist/cli.js + dist/hook.cjs + assets/
npx tsc --noEmit       # 类型检查
node --test tests/     # 基于 mock 的自动化测试（需先 build）
```

真实端点端到端手册见 `e2e-real-endpoint.md`；发布流程见 `releasing.md`。

## 致谢

本项目灵感来自 [pi-deepseek-vision](https://github.com/psychobarge/pi-deepseek-vision)，
感谢原作者 psychobarge 的开源工作。

## 协议

[MIT](../LICENSE)
