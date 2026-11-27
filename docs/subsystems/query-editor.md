# Query Editor

## 职责与边界

负责 SQL / MongoDB / Elasticsearch 查询编辑、语句定位与参数解析、托管事务与取消控制、执行生命周期与纯 SQL 耗时展示，以及多结果集页签装配。不负责数据源底层协议实现与通用虚拟表格渲染；驱动执行由 `internal/db` 完成，结果网格渲染由 `DataGrid` 负责。

## 真源

- 页面与状态编排：`frontend/src/components/QueryEditor.tsx`、`queryEditor/hooks/useQueryEditorCoreState.ts`、`useQueryEditorExecutionStatus.ts`
- 执行与结果构建：`queryEditor/hooks/useQueryEditorRun.ts`、`run/queryEditorSqlRun.ts`、`run/queryEditorRunResultSets.ts`、`queryResultTransport.ts`
- 执行生命周期与计时：`queryEditor/queryEditorExecutionLifecycle.ts`、`useQueryEditorExecutionLifecycle.ts`、`queryEditorExecutionTimer.ts`、`QueryEditorEditorPane.tsx`
- 后端绑定与进度事件：`internal/app/query_execution_lifecycle.go`、`methods_db_query_multi.go`、`methods_db_query.go`、`methods_db_transaction_multi.go`、`methods_db_params.go`、`query_result_compact.go`、`ipc_profile.go`
- 状态与耗时展示规则：`frontend/src/utils/queryDurationFormat.ts`、`internal/connection/types.go`（`QueryResult.DurationMs`）

## 运行时路径

```text
编辑器运行 / 快捷键
  -> useQueryEditorRun -> runQueryEditorSqlStatements
  -> 行定位计划 / 参数解析 / GenerateQueryID
  -> DBQueryMultiWithOptionsCompact / DBQueryMultiTransactional* / DBQueryMultiWithParams*
  -> internal/app 建连 (query:progress stage=starting)
  -> lifecycle.markExecuting() -> 驱动执行 SQL (stage=executing，每 1s 心跳)
  -> lifecycle.completeWithDuration(result, queryExecutionDuration) (done/error/cancelled + durationMs)
  -> attachQueryTimings + encodeCompactQueryResult (编码/压缩) -> IPC 回传
  -> expandCompactQueryResult + collectQueryEditorRunResultSets -> 结果页签与 SQL 日志
```

## 状态与不变量

- 纯 SQL 耗时口径：状态栏与 SQL 日志必须显示同一数字，仅统计驱动执行 SQL 的耗时（`queryExecutionDuration`），不包含前端语句分析/元数据补全、建连/SSH 隧道等待、后端结果编码/gzip 压缩、IPC 传输及前端解码渲染耗时。
- 运行中状态流转：
  - 预处理与建连（`starting`）：显示 `正在连接数据库`，隐藏计时器且不累加。
  - 执行 SQL（`executing`）：立即对齐后端 SQL 起算点显示并每 100ms 跳动，显示 `正在执行 SQL`。
  - 后端 SQL 完成、结果编码与传输中（`loading === true` 且生命周期进入 `done`）：立即将计时器定格在后端上报的精确 `durationMs` 并停止定时器，状态文本切为 `正在接收结果`。
  - 前端加载结束（`loading === false`）：状态切为 `执行完成`（或由新结果接替），数值保持与传输定格值及 SQL 日志一致，无回跳。
- 锁与线程安全：后端 `queryExecutionLifecycle` 绝不在持有 `mu` 时调用 `uievents.EmitWith` 或 `queryExecutionCancellable`。
- 取消与孤儿事务：页面卸载或切换取消时按 `queryId` 触发 `CancelQuery`；若卸载期间刚启动托管事务，前端兜底调用 `DBRollbackTransactionWithTrigger`。

## 失败语义

- 建连失败（`starting` 阶段失败）：`hasDurationMs` 为 `false`，不展示虚假的 `0ms` 耗时。
- 执行失败或取消：按实际是否进入执行阶段上报已执行的 SQL 耗时；触发结构变更的 RPC 异常走 `outcomeUnknown` 语义并提示用户核对数据。
- RPC 连接中断但后端仍在执行（`shouldRetainQueryEditorRunAfterRpcFailure`）：保留运行状态并由 `query:progress` 终态事件收口。
- Web 运行时若未配置/暂未收到 `query:progress` 事件，ES 控制台等无进度事件路径保留本地计时回退。

## 验证

```bash
go test -race ./internal/app -run "TestQueryExecution|TestEmitQueryExecution|TestCancelQuery|TestDBQueryMulti|TestDBQueryWithCancel"
go test ./shared/i18n
go vet ./internal/app ./shared/i18n
cd frontend
npx vitest run src/components/queryEditor/queryEditorExecutionTimer.test.ts src/components/queryEditor/queryEditorExecutionLifecycle.test.ts src/components/queryEditor/useQueryEditorExecutionLifecycle.test.tsx src/components/queryEditor/QueryEditorExecutionStatus.test.tsx src/components/QueryEditorToolbar.layout.test.tsx
npx tsc --noEmit
npm run i18n:scan
npm run build
```

## 已知边界 / 未确认

- 未确认：Wails v3 桌面版与 Web 运行时在大结果集压缩与 IPC 传输期间，`query:progress` 终态事件的真实实时推送延迟仍需在运行中的应用中手工复测。
