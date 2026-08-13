# Implement: deepseek-vl-support

执行顺序（每步完成后运行验证命令，绿了再进下一步；每步一个 git commit，可回滚）。

## Step 0 — 仓库初始化

- `git init`；`.gitignore`（node_modules/、dist/、`.deepseek-vl/`、`pi-deepseek-vision-main/`）。
- `package.json`（name `deepseek-vl-support`、version 0.1.0、license MIT、
  bin `{ "deepseek-vl-support": "dist/cli.js" }`（0.1.1 起单同名 bin；0.1.0 曾用别名
  deepseek-vl）、files: dist/ assets/ README.md LICENSE）、
  tsconfig.json、esbuild 构建脚本；`npm i -D typescript esbuild @types/node`。
- 验证：`npx tsc --noEmit && npm run build`（先放 cli 占位文件）。

## Step 1 — 核心模块 + 单测（R1）

- `src/config.ts`：VisionConfig（含 `maxBytes` 与 `fallbacks[]`）+ 解析链（env > 项目 > 全局 >
  默认）+ 读写（深合并写回）。
- `src/detect.ts`：扩展名白名单 + magic bytes（png/jpg/gif/webp/bmp 各前 8 字节）。
- `src/prompt.ts`：三级覆盖（frontmatter 剥离）。
- `src/client.ts`：describe（**尺寸守卫 → base64 data URI → 兜底链降级**、超时预算沿链共享、
  错误语义）+ listModels（404/405 → null）；`VisionSizeError` 含压缩/裁剪建议。
- `src/cache.ts`：sha256+mtime+model 键、64MB LRU 淘汰。
- tests：`tests/config.test.ts`（临时 HOME/项目目录隔离，含 fallbacks 解析）、
  `tests/detect.test.ts`、`tests/client.test.ts`（mock node:http 服务器：成功/兜底降级/全失败/
  超限拒发/空 content）、`tests/cache.test.ts`。
- 验证：`npx tsc --noEmit && node --test tests/`。

## Step 2 — CLI（describe/doctor/config）

- `src/cli.ts`：手写参数解析；`describe <file> [question…]`、`doctor [--url] [--all]`（--all
  逐项探测兜底链）、`config [get|set <key> <val>] [--global]`。
- 向导组件：`src/wizard.ts` 编号菜单（`node:readline/promises`，问题列表驱动，每步默认值/跳过）。
- `tests/smoke.ts`：对 mock 视觉服务器跑 describe + doctor 冒烟。
- 验证：`node dist/cli.js doctor --url http://127.0.0.1:<mock>` 等。

## Step 3 — MCP server（R3）

- `src/mcp.ts`：stdio JSON-RPC（initialize / tools/list / tools/call），stdout 纯协议、
  stderr 日志；工具 `describe_image`、`vision_status`。
- `tests/mcp.test.ts`：spawn 子进程 + 管道 JSON-RPC 往返（mock 视觉服务器）。
- 验证：`npx tsc --noEmit && node --test tests/mcp.test.ts`。

## Step 4 — hook 脚本（R2 核心）

- `src/hook.ts`：`hook-read`（快速路径识别 → 缓存 → 视觉调用 → 方案 A block 输出；失败/未配置
  → `{}` exit 0；stderr 提示）与 `hook-start`（doctor 轻量检查 → additionalContext 警告，exit 0）。
- esbuild 打包为独立 `dist/hook.cjs`（zero-dep，UTF-8 显式处理）。
- `tests/hook.test.ts`：stdin JSON 喂入，断言各分支输出（图片→block 输出、非图片→{}、
  disabled→{}、失败→{}）。
- 验证：`npm run build && node --test tests/hook.test.ts`。

## Step 5 — 资产模板 + 安装器（R4）

- `src/assets/`：SKILL.md 模板、commands/vision.md 模板、AGENTS.md 片段（bilingual，
  文件首行含标记注释供卸载校验）。
- `src/install.ts`：向导（Step 2 的 wizard.ts；预设顺序 D2；隐藏输入 key；备用模型步骤）、
  文件安装（项目/全局两套路径）、settings.json 深合并（备份 + 条目识别）、幂等、
  `uninstall`（design §8 移除矩阵：标记识别 + 内容指纹校验，用户自写文件跳过并警告）、
  `--update`、`--non-interactive`、`--dry-run`。
- `src/codex.ts`：config.toml 段写入（版本锁定 npx）、AGENTS.md 标记段、models.json 修复
  （备份后改 `supports_search_tool`）。
- `tests/install.test.ts`：临时项目目录跑非交互安装/重复安装/卸载/卸载后残留检查，断言
  合并正确、用户既有配置无损、幂等、移除矩阵逐项覆盖（含"用户自写文件不误删"用例）。
- 验证：`npx tsc --noEmit && node --test tests/install.test.ts`。

## Step 6 — Spike：真实环境实证（design §10）

- 在本机 Claude Code（DeepSeek 模型）+ mock 视觉服务器下：debug hook dump 完整 stdin；
  实测方案 A（block+additionalContext）模型可见性、方案 B（updatedInput）端到端、
  文本模型 Read 图片省略文案、UserPromptSubmit 图片复核、Windows 路径转义。
  **本会话环境即 Claude Code + deepseek-v4-pro，可直接用作 spike 场地**（本仓库已挂
  trellis hooks，机制同源，风险低）。
- 结论写 `research/spike-results.md`，据此定稿 A/B 选择（默认 A，A 不达预期切 B）。
- 验证：spike 记录完整，hook 输出形态最终确定。

## Step 7 — 文档（R5，D4/D5）

- `README.md` 中英双语：安装（向导流程说明）、端点配置示例（OpenRouter/硅基流动/百炼/本地
  四类）、**大图限制（maxBytes）与兜底模型（fallbacks）配置示例**、卸载说明、Claude Code 与
  Codex 用法、故障排查（Windows UTF-8、hook 超时、models.json bug、推理模型不可用、
  粘贴图片局限）。
- `docs/e2e-real-endpoint.md`：真实端点 E2E 手册步骤（D5）。
- 验证：按 README 步骤在干净目录可复现安装（dry-run 复核）。

## Step 8 — 总验证 + 发布准备 + 质量检查

- `npm run build && npx tsc --noEmit && node --test tests/` 全绿。
- 发布准备：`npm pack --dry-run` 校验产物清单（AC12）；`docs/releasing.md` 发布流程
  （version bump → pack 校验 → publish 清单）；不执行 `npm publish`。
- 交给 `trellis-check` 复查（specs + 工件一致性 + lint/type/test）。

## 风险文件与回滚点

| 文件 | 风险 | 回滚 |
|---|---|---|
| `src/install.ts` / `src/codex.ts` | 改动用户全局/项目配置 | 写前备份 `.bak`；uninstall 按标记逆操作；测试全覆盖 |
| `src/hook.ts` | 输出形态不符 harness 预期 | spike（Step 6）先行验证；失败即 `{}` 放行 |
| `src/mcp.ts` | 手写协议与 Codex 不兼容 | 实现期用真实 Codex 做一次 `tools/list` 验证（spike 6 扩展项） |

## 完成定义

PRD Acceptance Criteria 1–9 全部满足；mock 自动化全绿；spike 结论落盘；README 手册步骤自洽。
