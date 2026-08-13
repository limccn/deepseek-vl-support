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

2. **build + typecheck + tests 全绿**
   ```bash
   npm run build && npx tsc --noEmit && node --test tests/
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

5. **发布后冒烟**
   ```bash
   npx -y deepseek-vl-support@<version> version
   npx -y deepseek-vl-support@<version> doctor   # 在配置好的项目里
   ```

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
- [ ] `npm pack --dry-run` 清单符合预期、无 secrets（`~/.deepseek-vl` 不参与打包）
