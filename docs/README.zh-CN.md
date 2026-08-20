<img src="banner/banner_zh-CN.png" alt="deepseek-vl-support — 为 DeepSeek 装上「眼睛」" width="100%">

# deepseek-vl-support

> **English** → [README.md](../README.md)

## 它能做什么

有些 AI 模型（比如 DeepSeek）能读文字，却**看不了图片**。报错截图、界面草图、图表、
手写笔记照片——对它们来说都是"看不见"的。

这个小工具就是给它们装上"眼睛"。装好之后，每当模型想读一张图片，工具会把图片发给
一家你选的"看图服务"（Moonshot、OpenRouter、SiliconFlow、Ollama……），拿回一段详细
的文字描述，再把描述交给模型——模型就像真的看见了图片一样。

```
模型读取 screenshot.png
  → 本工具在读取时拦截
  → 图片 → 看图服务 → 返回详细文字描述
  → 模型收到："[Vision of screenshot.png]: <描述>"
  → 模型根据描述继续干活
```

不需要改任何模型设置，也不需要写配置文件——一次性安装后自动生效。一条命令安装，
一条命令卸载。MIT 开源。

## 适用人群

你在**任何 AI 编程工具**里使用纯文本模型（如 DeepSeek），希望它能看懂图片：报错截图、
UI 稿、图表、笔记照片。在下面的[安装向导](#快速安装向导)里找到你的工具——每个受支持
的 agent 都有一条命令的安装方式，包括 Claude Code、Codex、Cursor、GitHub Copilot、
VS Code、OpenCode、Trae、Qwen Code 等 22 种。

## 开始之前（你需要准备什么）

1. **Node.js 18 或更新版本** —— 用 `node -v` 检查；没装的话到 <https://nodejs.org> 下载。
2. **一个看图服务的账号和它的 API key** —— 看图服务就是"替你看图"的网站：云端的
   Moonshot、OpenRouter、MiniMax、智谱 GLM、阶跃星辰、OpenCode Zen、SiliconFlow、
   百炼 DashScope；免费的本地选项（跑在你自己的电脑上）：Ollama、llama.cpp、vLLM、
   LM Studio。API key 是这家服务给你的一串密钥（一般在网站"API keys"页面）；安装器
   只问一次，并且只存在你自己的电脑上。
3. **已经装好你的 AI 工具** —— 下面任意一种。

## 快速安装向导

在**你的项目文件夹**里打开终端，运行：

```bash
cd 你的项目路径
npx @limccn/deepseek-vl-support@latest install
```

就这么简单——向导会自动检测你电脑上装了哪些 agent，然后问 7 个简短的问题。
**几乎每个问题都有合理的默认值：直接回车即可。** 两个值得看一眼的问题：哪些 agent
需要视觉能力（已预选）和用哪家看图服务 + API key（拿不定主意就选最后一项
**稍后决定**，以后随时可以补）。

装完以后，**重启你的会话**（安装器会打印这个提醒，这是生效的必要步骤）。可选验证：

```bash
npx @limccn/deepseek-vl-support@latest doctor    # 看到 [OK] 即正常
```

在同一项目里重复安装？它会问是否保留当前设置——回车即保留。

**不想用终端？让你的 agent 自己装。** 如果你用的是支持 Agent Plugins 标准的工具
（GitHub Copilot、Cursor、Kiro、OpenClaw、Hermes Agent、VS Code、ChatGPT & Codex、
Grok Bot、NanoClaw 以及其他符合该标准的 agent），直接在对话里说：

```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

安装后，用 
```
npx @limccn/deepseek-vl-support@latest install --target <你的agent>
```
（或环境变量，见[修改设置](#修改设置)）配置一次看图服务即可。

### 每种 agent 的一键安装

下面每条命令与上面的向导等价——只是只针对某一个 agent。找到你的：

<details>
<summary>Claude Code</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target claude
```

**2. 装完** — 重启会话，然后直接读取任意图片：描述会自动送达（手动触发：
`/vision 图片路径.png`）。

</details>

<details>
<summary>Codex</summary>

**1. 一句话安装** — 在 Codex 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target codex
```

**3. 装完** — 重启 Codex，然后让它描述一张图片。

</details>

<details>
<summary>OpenCode</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target opencode
```

**2. 装完** — 重启 OpenCode。

</details>

<details>
<summary>Trae</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target trae
```

**2. 装完** — 手动导入一次技能：设置 → 规则与技能 → 创建/导入。

</details>

<details>
<summary>Pi Coding Agent</summary>

**1. 原生安装（推荐）** — 一条命令同时装上技能和扩展
```bash
pi install npm:@limccn/deepseek-vl-support
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target pi
```

**3. 装完** — 重启 Pi。

</details>

<details>
<summary>Oh My Pi</summary>

**1. 原生安装（推荐）**
```bash
omp install npm:@limccn/deepseek-vl-support
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target omp
```

**3. 装完** — 执行 `/reload-plugins` 激活（无需重启）。

</details>

<details>
<summary>DeepSeek Harness</summary>

**1. 原生安装（推荐）** — 进程内获得工具，不启子进程
```bash
dsh plugin --profile web add @limccn/deepseek-vl-support@latest
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target dsh
```

**3. 装完** — 重启 dsh web 会话。

</details>

<details>
<summary>Qwen Code</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target qwen
```

**2. 装完** — 重启 Qwen Code。

</details>

<details>
<summary>Reasonix</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target reasonix
```

**2. 装完** — 重启 Reasonix。

</details>

<details>
<summary>Kilo Code</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target kilo
```

**2. 装完** — 重启 Kilo Code。

</details>

<details>
<summary>WorkBuddy（CodeBuddy Code）</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target workbuddy
```

**2. 装完** — 重启 WorkBuddy。

</details>

<details>
<summary>Devin</summary>

**1. 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target devin
```

**2. 装完** — 重启 Devin。（Devin 的 CLI 没有官方 npm 包——从
<https://devin.ai/download> 下载。）

</details>

<details>
<summary>GitHub Copilot</summary>

**1. 一句话安装** — 在 Copilot 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target copilot
```

**3. 装完** — 用 `copilot plugin list` 检查。

</details>

<details>
<summary>Cursor</summary>

**1. 一句话安装** — 在 Cursor 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target cursor
```

**3. 装完** — 重载窗口（Developer → Reload Window）。

</details>

<details>
<summary>Kiro</summary>

**1. 一句话安装** — 在 Kiro 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target kiro
```

**3. 装完** — 手动导入一次：Kiro → Powers → 添加自定义 Power → 从文件夹导入 → 选择
`~/.deepseek-vl/plugin`。

</details>

<details>
<summary>OpenClaw</summary>

**1. 一句话安装** — 在 OpenClaw 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target openclaw
```

**3. 装完** — 重启网关，用 `openclaw plugins list` 检查。

</details>

<details>
<summary>Hermes Agent</summary>

**1. 一句话安装** — 在 Hermes 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target hermes
```

**3. 装完** — 用 `hermes plugins list` 检查。

</details>

<details>
<summary>VS Code</summary>

**1. 一句话安装** — 在 VS Code 聊天里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target vscode
```

**3. 装完** — 重载窗口。

</details>

<details>
<summary>ChatGPT & Codex</summary>

**1. 一句话安装** — 让 ChatGPT 或 Codex 安装：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target chatgpt-codex
```

**3. 装完** — 新开一个 Codex 线程（或 ChatGPT 会话）。

</details>

<details>
<summary>Grok Bot</summary>

**1. 一句话安装** — 在 Grok 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target grok
```

**3. 装完** — 在插件页按 `r`（刷新）或新开会话。

</details>

<details>
<summary>NanoClaw</summary>

**1. 一句话安装** — 在 NanoClaw 会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target nanoclaw
```

**3. 装完** — 按打印的指引运行 `ncl wirings create`。

</details>

<details>
<summary>其他类型Agent（适配Agent Plugins 开放标准）</summary>

**1. 一句话安装** — 在聊天会话里说：
```
安装 https://github.com/limccn/deepseek-vl-support 的插件并启用它
```

**2. 或用 npx 安装**
```bash
npx @limccn/deepseek-vl-support@latest install --target other
```

</details>

<details>
<summary>混合安装（一次装多个Agent）</summary>

任意组合都可以，逗号分隔：

```bash
npx @limccn/deepseek-vl-support@latest install --target claude,copilot
```

或一次装齐全部 10 个插件客户端：

```bash
npx @limccn/deepseek-vl-support@latest install --target copilot,cursor,kiro,openclaw,hermes,vscode,chatgpt-codex,grok,nanoclaw,other
```

</details>

所有受支持的 agent 一览：

| Agent | `--target` |
|---|---|
| Claude Code | `claude` |
| Codex | `codex` |
| OpenCode | `opencode` |
| Trae | `trae` |
| Pi Coding Agent | `pi` |
| Oh My Pi | `omp` |
| DeepSeek Harness | `dsh` |
| Qwen Code | `qwen` |
| Reasonix | `reasonix` |
| Kilo Code | `kilo` |
| WorkBuddy（CodeBuddy Code） | `workbuddy` |
| Devin | `devin` |
| GitHub Copilot | `copilot` |
| Cursor | `cursor` |
| Kiro | `kiro` |
| OpenClaw | `openclaw` |
| Hermes Agent | `hermes` |
| VS Code | `vscode` |
| ChatGPT & Codex | `chatgpt-codex` |
| Grok Bot | `grok` |
| NanoClaw | `nanoclaw` |
| 其他 agent | `other` |

## 试一试

最快的验证——直接在终端描述一张图片：

```bash
npx @limccn/deepseek-vl-support@latest describe 图片路径.png
```

返回一段像样的文字描述 → 一切就绪。之后照常在你的 agent 里读图片，描述会自动送达。

## 选择看图服务

安装器会把上面的服务列成菜单让你选——手动配置时才需要记住这些地址：

| 服务 | base URL | 示例模型 |
|---|---|---|
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-32k-vision-preview` |
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen2.5-vl-72b-instruct` |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-VL-01` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| 阶跃星辰 | `https://api.stepfun.com/v1` | `step-1o-turbo-vision` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `mimo-v2.5-free` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| 百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5vl:7b`（先运行 `ollama pull qwen2.5vl:7b`） |
| llama.cpp（本地） | `http://localhost:8080/v1` | `llava`（`llama-server -m llava.gguf`） |
| vLLM（本地） | `http://localhost:8000/v1` | `deepseek-ai/deepseek-vl2` |
| LM Studio（本地） | `http://localhost:1234/v1` | `qwen2.5-vl-7b-instruct` |

## 常用命令

| 想做什么 | 命令 |
|---|---|
| 安装 | `npx @limccn/deepseek-vl-support@latest install` |
| 健康检查 | `npx @limccn/deepseek-vl-support@latest doctor` |
| 立刻描述一张图片 | `npx @limccn/deepseek-vl-support@latest describe picture.png` |
| 查看当前设置 | `npx @limccn/deepseek-vl-support@latest config get` |
| 修改设置 | `npx @limccn/deepseek-vl-support@latest config set maxBytes 5242880` |
| 卸载 | `npx @limccn/deepseek-vl-support@latest uninstall` |

## 修改设置

你的回答保存在项目文件夹里的 `.deepseek-vl/config.json`——通常完全不用碰它。两个值得
知道的设置：

| 设置 | 含义 | 默认值 |
|---|---|---|
| `maxBytes` | 超过这个大小的图片跳过（省钱省时间） | 10485760（10 MB） |
| `timeoutMs` | 等一次描述的最长时间 | 120000（2 分钟） |

示例——跳过 5 MB 以上的图片：

```bash
npx @limccn/deepseek-vl-support@latest config set maxBytes 5242880
```

同一张图片描述两次是免费的：结果会缓存在你电脑上（上限 64 MB）。图片改动了就会重新
描述。所有设置也都能用环境变量（`VISION_MODEL`、`VISION_BASE_URL`……）设置——完整参考
见 [CLAUDE.md](../CLAUDE.md#configuration)。

## 常见问题

| 现象 | 怎么办 |
|---|---|
| 模型还是不会描述图片 | 重启会话（安装后必须），然后运行 `… doctor` 看是否有 `[OK]`。 |
| `doctor` 提示未配置模型 | 安装时选了**稍后决定**。现在补：`config set model <模型ID>`（非默认服务再加 `config set baseUrl <地址>`）。 |
| `doctor` 显示 "unreachable" / 没有 `[OK]` | 服务地址或密钥不对——检查 base URL 是否以 `/v1` 结尾、API key 是否正确。 |
| 提示"图片太大" | 压缩或裁剪图片（如 5 MB 以内、长边约 2000 像素），或用 `config set maxBytes …` 提高上限。 |
| 描述很慢 | 调低上限，或换更快的服务（见上表）。 |
| 粘贴（Ctrl+V）的图片不生效 | 粘贴的图片不经过读取通道——先把图片存成文件再读（或使用 `/vision` / `describe_image`）。 |

更多边界情况（Windows 编码、Codex 特有坑、推理模型注意事项）见
[CLAUDE.md](../CLAUDE.md) 和 [README.md](../README.md#troubleshooting)。

## 致谢

本项目受 [pi-deepseek-vision](https://github.com/psychobarge/pi-deepseek-vision)
启发——感谢 psychobarge 的开源工作。

## 参与贡献

欢迎贡献——如何报问题、搭开发环境，见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 开源许可

[MIT](../LICENSE)
