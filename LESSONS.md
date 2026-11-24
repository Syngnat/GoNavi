<!-- reviewed-through: 2026-11-24 (seed audit; nightly review not started yet) -->
# Lessons from merged work

这份文件只记录“已经发生过、以后还可能再犯”的工程教训。每条必须能指向证据：
commit、PR、失败 CI、reopen 的 issue，或一次真实的用户复现。

格式：

- **规则**：一句话，能直接执行。
- **原因**：为什么这条规则存在。
- **证据**：具体 commit / PR / run / issue，不接受“感觉”。
- **Seen**：这个错误在多少个不同日期被看到；同一天只算一次。
- **正确做法**：下次应该怎么做。

规则在 **3 个不同日期**被看到后，移入 [`docs/code-standards.md`](docs/code-standards.md)，
并尽量落成一个 guard test 或 CI 检查。只写进文档、没有执行机制的规则，优先级低于 guard test。

---

## 种子教训（2026-11-24 仓库审计）

> 这些是本次审计已经能证实的结构性问题，先作为种子记录；夜间复盘开始后，
> 用真实事故证据替换或补充，不要把它们当成“已经验证过很多次”的结论。

### L-001 门禁必须真实存在，且名字可被消费

- **规则**：任何被代码/机器人读取的 check 名称，必须在 workflow 里有一个同名 job；
  改名前先搜全仓引用。
- **原因**：`tools/pr-review/gate.go` 把 `CI Gate` 当作权威检查，但
  `.github/workflows/backend-tests.yml` 原先没有名为 `CI Gate` 的 job，
  导致评审评论里的门禁永远显示“未开始/未通过”。
- **证据**：`tools/pr-review/gate.go` 的 `gateCheckName`；本次改动新增
  `backend-tests.yml` 的 `gate` job。
- **Seen**：1×（2026-11-24）
- **正确做法**：新增/改名 check 时，同时搜索 `tools/`、`.github/` 和文档里的引用；
  给 gate job 加一个最小的工作流契约测试。

### L-002 能发版的每个分支，都必须跑同一套测试

- **规则**：`dev`、`main`、`release/**` 和 release tag 所指向的 commit，
  必须能追溯到一次成功的完整 Backend Tests；tag 不能绕过测试。
- **原因**：原先 `backend-tests.yml` 只监听 `dev`，`release.yml` 打 tag 时
  只跑发布资产契约和少量 Windows 测试，完整后端套件不在发版路径上。
- **证据**：`.github/workflows/backend-tests.yml` 的 `on`；`.github/workflows/release.yml`
  原先的 job 依赖图；本次改动新增 `main`/`release/**` 触发和 `Verify CI Gate` job。
- **Seen**：1×（2026-11-24）
- **正确做法**：release workflow 在构建前查询 tag SHA 的 `CI Gate`；
  查不到就等待，失败就拒绝发布。旧 tag 重跑必须显式 `allow_missing_ci`。

### L-003 i18n 源文件和 catalog 必须同一提交更新

- **规则**：改 `shared/i18n/*.json` 时，同一提交必须重新生成并提交
  `shared/i18n/catalog.zip`；六种语言缺一不可。
- **原因**：语言目录和 catalog 脱节会让运行时回退到 key 或旧文案，
  这类问题在前后端之间不一致时很难靠单测发现。
- **证据**：`AGENTS.md` 的 i18n 约束；近期修复提交 `967da929e`、`46153b782`。
- **Seen**：1×（2026-11-24，按本次审计记录；后续按真实复发日期更新）
- **正确做法**：PR 模板要求写 i18n 验证；CI 增加 catalog 与六语言文件的
  “同提交/同内容”检查；`tools/pr-review` 的 locale drift 检查不能删。

### L-004 超大文件禁止净增，规则必须由检查执行

- **规则**：`QueryEditor.tsx`、`App.tsx`、`store.ts`、`DataGrid.tsx`、`Sidebar.tsx`、
  `methods_file.go`、`methods_db.go`、`app.go` 等超标文件，任何 PR 不得净增行数；
  新逻辑写新文件，旧文件只接线。
- **原因**：只写进 `AGENTS.md` 的“禁止膨胀”会被忽略；必须让 PR 检查直接报错。
- **证据**：`AGENTS.md` 的“1. 体积与拆分”限额；`tools/pr-review/rules.go` 的
  `forbiddenGrowthFiles` 和 `forbidden-file-growth` 规则；本次审计确认该规则已存在，
  但没有被分支保护强制。
- **Seen**：1×（2026-11-24）
- **正确做法**：保留 `pr-review` 的 forbidden growth 检查；把 `CI Gate` 设为 required；
  新增超标文件时先拆文件，而不是加 `//nolint` 或换行。
