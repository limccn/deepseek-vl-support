# Releasing 发布流程

How to publish a new version of `deepseek-vl-support` to npm. 如何发布新版本。

> 本手册只描述流程与校验清单；`npm publish` 由维护者手工执行（不得在自动化任务中自动发布）。

## Checklist 发布清单

1. **version bump 版本号**
   ```bash
   npm version <major|minor|patch>   # 同步更新 package.json 与 docs
   ```
   同步确认 `src/cli.ts` 的 `VERSION` 与 `src/mcp.ts` 的 `SERVER_VERSION` 与 package.json 一致
   （当前两处均为手工常量，勿遗漏）。
   **bin 仅保留与包名相同的单一条目**：
   ```json
   "bin": { "deepseek-vl-support": "dist/cli.js" }
   ```
   单同名 bin 是标准发布形态（bin 名与包名一致，便于用户发现与调用），保持即可、勿加别名。
   ⚠️ 不要把这与 npx 冒烟报错混为一谈：在**包自身目录**内运行
   `npx -y deepseek-vl-support@<version> …` 时，本地 package.json 的 name+version 命中
   spec，npx 会跳过下载安装、直接按本地包元数据的 bin 名找 PATH shim（本地项目没有），
   cmd 因此报 `'deepseek-vl-support' is not recognized`——这是运行位置问题，与 bin 形态
   无关；发布后冒烟必须在包目录之外的独立目录执行（见 §5）。

2. **build + typecheck + tests 全绿**
   ```bash
   npm run build && npx tsc --noEmit && node --test "tests/*.test.ts"
   ```
   全部通过后继续。

3. **pack 校验产物清单**
   ```bash
   npm pack --dry-run
   ```
   期望内容（`files` 白名单：`dist/ assets/ README.md LICENSE`）：
   - `dist/cli.js`（ESM，shebang 保留，bin 入口）
   - `dist/hook.cjs`（独立单文件 CJS bundle，零依赖，首行 banner 含身份标记
     `/*! deepseek-vl-support-hook */`）
   - `assets/`（SKILL.md、vision.md、vision-prompt.md、agents-fragment.md、skill-references/）
   - `README.md`、`LICENSE`
   - 不得包含：`tests/`、`.trellis/`、`node_modules/`、源码 `src/`（产物已含）、临时文件。

   校验 hook 产物自包含（无外部依赖）：
   ```bash
   node dist/hook.cjs </dev/null   # 应输出 {} 并退出 0（Linux/macOS）
   ```

4. **publish 发布**
   ```bash
   npm publish
   ```
   - 首次发布：`npm publish --access public`（包名无 scope，默认 public）。
   - 确认 tarball 与 dry-run 一致：`npm publish --dry-run` 先行复核。
   - **2FA 账号**：若报 `E403 Two-factor authentication ... is required to publish`，
     终端会提示输入 OTP（验证器 6 位码）后自动重试；若仍失败，改用 granular access
     token（npmjs.com → Access Tokens → Granular，勾选本包 Read+write 与
     "Bypass two-factor authentication in automated environments"），然后
     `npm config set //registry.npmjs.org/:_authToken <token>` 再发布。

5. **发布后冒烟**（在**包目录之外的独立目录**执行，如 `%TEMP%` 下新建目录）
   ```bash
   cd %TEMP% && mkdir -p dvs-smoke && cd dvs-smoke
   npx -y deepseek-vl-support@<version> version
   cd <已配置的项目> && npx -y deepseek-vl-support@<version> doctor
   ```
   ⚠️ 在包自身项目目录内运行会命中本地 package.json、npx 跳过安装，cmd 报
   `'deepseek-vl-support' is not recognized`——测试环境假象，不代表包有问题。

## Rollback 回滚

- npm 不支持删除已发布版本；如需废弃某版本：
  ```bash
  npm deprecate deepseek-vl-support@<version> "broken — use <new-version> instead"
  ```
- 用户侧回滚：安装器写前均有 `.bak` 备份，`uninstall` 按标记逆操作；配置/缓存保留，重装即恢复。
- Codex 侧：`config.toml` 的 MCP 段固定引用 `deepseek-vl-support@<版本>`，升级包后重跑
  `install --update` 会刷新 MCP 段与 hook 副本。

## 发布前自检（含 spike 结论）

- [ ] mock 自动化测试全绿（client/config/detect/cache/hook/install/mcp/smoke）
- [ ] 真实端点 E2E（`docs/e2e-real-endpoint.md`）至少跑通一次 describe + doctor
- [ ] spike 结论（plan-A block+additionalContext 在 Claude Code 中模型可见）已落盘
- [ ] `npx <pkg>@<ver> version` 在 Windows 可运行——在**包目录之外的独立目录**（如 `%TEMP%`
      新建目录）执行；在包自身目录内运行会命中本地 spec、npx 跳过安装而报
      `'<pkg>' is not recognized`（运行位置问题，与 bin 形态无关）
- [ ] `npm pack --dry-run` 清单符合预期、无 secrets（`~/.deepseek-vl` 不参与打包）
