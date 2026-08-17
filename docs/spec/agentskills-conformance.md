# AgentSkills 规范符合性（deepseek-vision）

> 适用范围：`deepseek-vision` 技能产品面（5 处 SKILL.md 副本 + 安装器 + 打包产物）。
> 规范权威来源：[agentskills.io/specification](https://agentskills.io/specification)，
> 官方镜像 github.com/agentskills/agentskills `docs/specification.mdx`。
> 研究底稿：`.trellis/tasks/08-17-agentskills-spec-conformance/research/agentskills-compliance.md`。

## 1. 规范条款摘要

- 技能 = 目录 + `SKILL.md`（YAML frontmatter + Markdown body，body 无格式限制）。
- `name`：必填，1–64 字符，仅小写字母/数字/连字符（kebab-case），不可首尾/连续连字符，
  **必须与父目录名完全一致**。
- `description`：必填，1–1024 字符。
- `allowed-tools`：可选，**空格分隔**的预授权工具列表（实验性），规范示例
  `Bash(git:*) Bash(jq:*) Read`。规范跟随实现按空白拆分解析。
- 可选字段：`license`、`compatibility`（≤500 字符）、`metadata`（string→string map）。
- 推荐可选子目录：`scripts/`、`references/`（按需加载）、`assets/`（静态资源）；
  渐进式披露：SKILL.md 激活时被整体加载，长内容应拆入 references/ 按需引用。
- 标准落点：项目 `.agents/skills/<name>/SKILL.md` 供多客户端发现。

## 2. 修复前偏差（D1–D3）

| # | 严重度 | 偏差 | 处置 |
|---|---|---|---|
| D1 | 高 | `allowed-tools: Bash, Read` 逗号分隔；规范要求空格分隔，规范跟随实现按空白拆分得到非法工具 id `Bash,` | 修复：统一改 `allowed-tools: Bash Read`（D8） |
| D2 | 中 | 渐进式披露引用悬空：SKILL.md body 引用 `references/vision-prompt.md`，但 `.agents/skills/` 与 npm 包内 `skills/deepseek-vision/` 均不含该文件 | 修复：build 同步 + 安装器 `.agents` 分支写入 + uninstall 按标记移除（R2） |
| D3 | 低 | frontmatter 首行非标准注释 `# deepseek-vl-support:skill`（项目自造管理标记） | **保留**（D9），见 §4 |

## 3. 修复后符合性自查清单（R4）

- `name: deepseek-vision` 与各父目录同名 ✓（`skills/deepseek-vision/`、
  `.agents/skills/deepseek-vision/`、`.claude/skills/deepseek-vision/`）；kebab-case ✓；
  长度 1–64 ✓。
- `description` 1–1024 字符，含触发词 ✓。
- `allowed-tools: Bash Read` 空格分隔、无逗号，预授权语义与修复前一致（Bash 全量 + Read）✓。
- 未使用规范外的其它 frontmatter 字段 ✓。
- 渐进式披露引用完整：`skills/deepseek-vision/references/vision-prompt.md` 存在并被 npm
  打包；安装器 `.agents` 分支写入同源 references/；uninstall 按 SKILL_MARKER 移除并清理
  空目录 ✓。
- 5 处 SKILL.md 副本字节一致（src/assets/、assets/、skills/deepseek-vision/、
  .agents/skills/deepseek-vision/ 及安装产物）✓。
- 上述自查以自动化测试落地（tests/plugin.test.ts「AgentSkills conformance」测试）✓。

## 4. 三偏差处置结论

### D1 定稿（D8）：空格分隔，不平台分化

Claude Code 官方文档对 `allowed-tools` 明确接受三种形式：
> "Accepts a space- or comma-separated string, or a YAML list."

（官方示例两种并存：`Read, Grep, Glob` 与 `Bash(git add *) Bash(git commit *)`；YAML
列表形式自 CC v2.1.0 起支持。本仓库 0.2.1 真实机 E2E 已实证逗号形式在 CC 下可用。）

因此改为空格分隔对 CC 无损（行为不回退），对规范可移植（规范跟随实现按空白拆分得到
干净工具 id）。不改命令示例、不产生平台分化副本。

### D2 定稿：打包与安装产物自包含

- `build.mjs` 构建时把 `assets/skill-references/vision-prompt.md` 同步复制到
  `skills/deepseek-vision/references/vision-prompt.md`（npm 包内技能目录自包含）。
- 安装器 `.agents` 分支（项目级 codex 安装）写 SKILL.md 后以同源同标记
  （`writeManagedFile` + SKILL_MARKER，update/dryRun 语义与 Claude 分支一致）写
  `references/vision-prompt.md`；uninstall 按标记移除该文件后 `removeEmptyDirTree`
  清理空目录（兄弟技能目录不受影响，有测试保护）。
- 仓库内已安装形态 `.agents/skills/deepseek-vision/` 已刷新为含 references/ 的自包含形态。

### D3 定稿（D9）：保留注释标记

- 权威要求仅为 "valid YAML frontmatter"（`---` 分隔）；`#` 注释是原生 YAML 语法，
  合法且被解析器忽略。规范对 frontmatter 注释无禁止条款。
- Claude Code 使用完整 YAML 解析器解析 SKILL.md frontmatter（QwenLM/qwen-code PR
  #4870 旁证）；regex 类第三方解析器曾报告注释行解析失败（Texarkanine/a16n issue
  #70）——属实现缺陷而非规范禁止，无文档化案例表明 CC loader 因注释行失败。
- 本仓库 0.2.1 真实机 E2E（install + skill 加载）已实证带该注释的模板正常加载。
- 卸载机制（writeManagedFile / removeFileIfManaged 的 SKILL_MARKER）依赖该标记识别
  管理文件；移除需重构标记机制，收益仅为外观纯度。
- **结论：保留**；已知真实风险与注释无关——无效 YAML（如 description 未加引号且含
  `: `）会静默加载失败，模板变更时注意。

## 5. 跨 shell 适配（D10）

- `allowed-tools` 的 `Bash` 指 CC 的 Bash 工具，Windows（Git Bash）/macOS 同名，
  field 无需平台分化。
- SKILL.md 正文「How to use」命令在 bash / zsh（macOS 默认）/ pwsh（Windows 默认）
  三壳下语义一致：双引号包裹含空格路径通用，`npx` 在 pwsh 下经 .cmd shim 解析、
  无需调用运算符。
- 已增加一行跨 shell 等价说明（不改变命令示例本身），避免模型在非 bash 环境改换
  语法；5 处副本保持同内容，不产生平台分化副本。

## 6. 验证形态（D7）

- 自动化符合性测试（node:test，tests/plugin.test.ts）：遍历 4 处仓库内 SKILL.md 副本
  （src/assets、assets、skills/deepseek-vision、.agents/skills/deepseek-vision）校验
  frontmatter（name kebab-case 且与父目录同名、description 1–1024、allowed-tools
  空格分隔无逗号）与打包结构（references/vision-prompt.md 存在且与模板源一致）；
  安装到客户端机器的第 5 处副本经「全部副本字节一致」断言传递覆盖。
- 安装/卸载回归（tests/install.test.ts）：`.agents` 写入含 references/（带标记），
  uninstall 移除 references/ 与空目录、兄弟技能不受影响。
- 打包自查：`npm pack --dry-run` 产物清单含 `skills/deepseek-vision/SKILL.md` 与
  `skills/deepseek-vision/references/vision-prompt.md`。
- 决策 D5：本任务为 mock 回归 + 打包自查，不做真实端点 E2E 复验。

## 7. 范围边界

- 仅 deepseek-vision 产品面；`.claude/skills/`、`.agents/skills/` 下 12 个 trellis-*
  框架技能不在规范审计范围（用户确认）。
- agent-plugins.org 插件规范（plugin.json / marketplace.json schema）是另一标准，另案处理。
