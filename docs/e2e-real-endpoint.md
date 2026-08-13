# Real-endpoint E2E manual 真实端点端到端手册

Automated tests use a mock server; this manual validates against a REAL
vision endpoint (D5). Run it once per release in a clean directory.

自动化测试走 mock 服务器；本手册用**真实视觉端点**验证全链路（D5）。每次发版前在干净目录跑一遍。

## 0. Prerequisites 前置

- Node ≥ 18（`node -v`）
- 一个 OpenAI 兼容视觉端点及可用 key（示例用 OpenRouter，其余端点参数一致）
- 本仓库已构建：`npm run build`

## 1. Clean-room install 干净目录安装

```bash
mkdir -p ~/tmp/dvls-e2e && cd ~/tmp/dvls-e2e
rm -rf project && mkdir project && cd project
npx deepseek-vl-support install --non-interactive \
  --target both --preset openrouter \
  --api-key $OPENROUTER_API_KEY
```

复核（dry-run 先行、结果可预期）：

```bash
npx deepseek-vl-support install --dry-run --non-interactive --target both --preset openrouter
# [dry-run] ... 仅预览，不写入
ls -R .deepseek-vl .claude .codex .gitignore   # 按预期生成
cat .gitignore                                  # 含 .deepseek-vl/
```

## 2. Config + doctor 配置与自检

```bash
deepseek-vl config get          # 确认 baseUrl/model/apiKey（key 掩码显示）
deepseek-vl doctor              # 期望 [OK] endpoint reachable + model found，退出码 0
deepseek-vl doctor --all        # 含兜底链逐条诊断
```

端点未实现 `/v1/models`（404/405）时 doctor 降级为警告不失败；网络/模型不存在则退出码 1。

## 3. describe 单图描述（CLI）

```bash
deepseek-vl describe some/screenshot.png
deepseek-vl describe some/screenshot.png "What error message is shown? 报错内容是什么？"
deepseek-vl describe --json some/screenshot.png
```

复核点：输出为详细中文+英文混合描述（可见文本/UI/颜色/报错）；问题被转发为文本部分；
`--json` 含 `text/model/fromFallback`。

## 4. Cache 缓存命中

```bash
deepseek-vl describe --json some/screenshot.png   # 第一次：调 API
deepseek-vl describe --json some/screenshot.png   # 第二次：缓存命中
ls .deepseek-vl/cache/                            # <sha256>.json，内容即描述文本
touch some/screenshot.png && deepseek-vl describe some/screenshot.png   # 改文件 → 重新调 API
```

## 5. Claude Code 全链路

在干净目录里对 Claude Code 项目执行：

1. 确认 `.claude/settings.json` 含 PreToolUse(Read) 与 SessionStart 条目（`node .claude/hooks/deepseek-vision-hook.cjs`）。
2. 重启会话（SessionStart hook 输出诊断）。
3. 在会话中 Read 一张截图：
   - 期望模型收到 `[Vision of <file>]:` 注入的描述并基于它作答（plan-A 验证点，见 spike 记录）；
   - 图片过大/端点故障时 Read 照常执行，stderr 有提示。
4. `/vision path/to/image.png 描述一下` 斜杠命令手动触发。

## 6. Codex 全链路

1. `codex mcp list` → 确认 `deepseek-vl` server 已列出（连接成功）。
2. 若工具不可见 → 检查 models.json 修复（`~/.codex/models.json` 中 DeepSeek 条目
   `supports_search_tool` 应为 false；安装器已自动处理）。
3. 会话中要求："用 mcp__deepseek-vl__describe_image 描述 <路径>，然后根据描述分析截图"。
4. `mcp__deepseek-vl__vision_status` 自检端点与模型。

## 7. Fallback 兜底链（可选）

```bash
deepseek-vl config set fallbacks '{"model":"Qwen/Qwen2.5-VL-72B-Instruct","baseUrl":"https://api.siliconflow.cn/v1"}'
deepseek-vl config set baseUrl http://127.0.0.1:1/v1   # 故意让主链路失败
deepseek-vl describe some/screenshot.png               # 期望自动降级到兜底成功
deepseek-vl config set baseUrl https://openrouter.ai/api/v1   # 还原
```

## 8. Cleanup 收尾

```bash
deepseek-vl uninstall --purge-config    # 移除全部产物 + 配置/缓存
git status                              # 项目目录应恢复干净
```

## 通过标准

- [ ] 1–4 全部符合预期（doctor 退出码 0、describe 输出真实描述、缓存命中 0 次 API）
- [ ] Claude Code 会话中 Read 图片后模型能基于注入描述作答（spike 结论一致的输出形态）
- [ ] Codex `codex mcp list` 显示 server 且 describe_image 可用
- [ ] 卸载后目录无残留
