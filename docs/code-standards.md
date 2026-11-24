# GoNavi 变更验收标准

这份文件是“什么算完成”的硬标准，和 `AGENTS.md`（工作守则）、`GO_STYLE.md`（Go 风格）
分工不同：`AGENTS.md` 说怎么做，这里说**什么时候可以合并/发布**。

## 1. 一个变更只做一个目标

- 一个 PR 只解决一个问题；顺手发现的 bug 单独开 issue/PR。
- 不混入无关重构、格式化、依赖升级或 UI 改版。
- 超大文件（`QueryEditor.tsx`、`App.tsx`、`store.ts`、`DataGrid.tsx`、`Sidebar.tsx`、
  `methods_file.go`、`methods_db.go`、`app.go`）不得净增行数；新逻辑写新文件。

## 2. Bug 修复必须能证伪

每个 bug 修复至少要有：

1. **复现**：用报告者的版本、平台、数据源类型/版本、连接方式复现；
2. **旧代码失败**：把新测试放到 base commit 上，必须出现真实 `FAIL`（不是编译错、不是 skip）；
3. **新代码通过**：回到 head，同一测试通过；
4. **同类兄弟点**：grep 同类调用/驱动/分支，确认没有只修截图里那一个。

提交/PR 必须贴出：失败命令与关键输出、通过命令与关键输出。

## 3. 测试分层，不要求每个 PR 跑全量

- **PR 快检**：受影响 Go 包、受影响前端测试、`go vet`、`tsc`、`npm run build`。
- **合并门禁**：`CI Gate` 汇总的 `Frontend clean build`、`Full backend suite`、
  `Plugin and marketplace contract tests`、`Platform-sensitive tests`。
- **夜间/发版**：全量前端 Vitest、全量 Go 套件、macOS/Windows/Linux 实际构建。
- 涉及并发/缓存/连接池/取消：受影响包至少 `go test -race`。
- 涉及 GUI：Chromium/WebKit 中至少覆盖改动页面；涉及共享选择器/布局时跑更大范围。

## 4. 平台和数据源不能互相替代

- Windows 报告必须在 Windows 或 WSL 的真实路径验证；macOS 的 WebKit 不能代表 Windows WebView2。
- 驱动问题必须用对应数据库类型和版本验证：MySQL 8、OceanBase Oracle 模式、
  SQL Server、DuckDB、Redis Cluster 等不能只靠 mock。
- 不能真机验证时，PR 必须明确写“未运行/未验证”，不能写“已修复”。

## 5. 前端与 i18n

- 用户可见文案走 `t()` / `shared/i18n`，六种语言同步：`de-DE`、`en-US`、`ja-JP`、
  `ru-RU`、`zh-CN`、`zh-TW`。
- 改 `shared/i18n/*.json` 必须同提交重新生成 `shared/i18n/catalog.zip`。
- 改 UI 至少跑受影响 Vitest；布局/共享组件变更跑对应页面在 Chromium 和 WebKit 的测试。
- 不手改 `frontend/wailsjs/`；用 Wails 生成并检查 diff。

## 6. 数据库与凭据安全

- 测试使用 Docker/临时数据库/只读账号；禁止连接真实生产库。
- 不把密码、Token、完整 DSN、私钥、业务数据放进代码、测试、日志、PR、issue。
- 不绕过 `secretstore`、`connectionReadOnly`、`productionRiskConfirm`、SQL 审计。
- 涉及写操作、批量删除、同步、迁移的测试必须使用独立 fixture，并在结束后清理。

## 7. 提交与 PR 记录

- commit 格式：`emoji type(scope): 中文描述`。
- commit body 写：根因、用户可见变化、验证命令、未运行项；不把完整测试日志只放在聊天里。
- PR 使用 `.github/pull_request_template.md`；没有“旧代码失败/新代码通过”的 PR 不进入 review。
- 评审只认 reviewed head；rebase/push 后重新跑门禁。

## 8. 发布

- tag 只能打在 `main` 上，且该 commit 或其后继 commit 有成功的 `CI Gate`。
- `release.yml` 的 `Verify CI Gate` 未通过时不得构建/发布；旧 tag 重跑必须显式
  `allow_missing_ci`。
- 发布资产必须满足 `publish-release.yml` 的精确资产契约；版本号、Latest、校验和、
  安装包/CLI/驱动资产缺一不可。
- 没有真实验证过的平台/数据库，不在 release notes 里写成“已支持”。

## 9. 规则晋升

- 同一类问题在 `LESSONS.md` 中出现 **3 个不同日期**，移入本文件。
- 能自动检测的规则，必须同时落成 guard test / CI 检查；只写文字不算完成。
- 规则改名/移动时，搜索 `tools/`、`.github/`、`AGENTS.md`、`CLAUDE.md` 的引用。
