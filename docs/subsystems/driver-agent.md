# Driver Agent（驱动代理）

## 职责与边界

- 负责：将可选 Go 驱动与 Cgo 驱动隔离到独立子进程 `cmd/optional-driver-agent`，通过 stdin/stdout JSON Lines 与主进程通信；提供 `query`、`queryMulti`、`streamQuery`（分片流式结果）、`exec`、参数绑定（`json-lines-v2`）、在途取消（`cancelQuery`）、托管事务会话、`metadata` 探测及旧版代理 32 MiB 单帧超限兼容。
- 不负责：SQL 编辑器前端状态与分页视图（见 [`query-editor.md`](./query-editor.md)）、导入/导出文件格式编码（见 [`data-import.md`](./data-import.md) / [`data-export.md`](./data-export.md)）。

## 真源

- 类型/接口：[`database.go`](../../internal/db/database.go)（`Database`）、[`database_capabilities.go`](../../internal/db/database_capabilities.go)（`StreamQueryExecer`、`QueryStreamConsumer`、`QueryStreamValueConsumer`）、[`optional_driver_agent_protocol.go`](../../internal/db/optional_driver_agent_protocol.go)（请求/响应契约）、[`optional_driver_agent_ipc.go`](../../internal/db/optional_driver_agent_ipc.go)（`ErrOptionalDriverAgentJSONLineTooLarge`、`ReadOptionalDriverAgentJSONLine`）、[`stream_query_collect.go`](../../internal/db/stream_query_collect.go)（`CollectStreamQueryWithBudget`）。
- 配置/状态文件：[`driver_agent_revisions_gen.go`](../../internal/db/driver_agent_revisions_gen.go)（由 `tools/generate-driver-agent-revisions.sh` 生成）、`~/.gonavi/drivers/<driver>/installed.json` 与 `<driver>-driver-agent`。
- 唯一写入点：代理侧 [`request_dispatch.go`](../../cmd/optional-driver-agent/request_dispatch.go) 与 [`main.go`](../../cmd/optional-driver-agent/main.go) 串行响应写出；主进程侧 [`optional_driver_agent_client.go`](../../internal/db/optional_driver_agent_client.go)、[`optional_driver_agent_stream.go`](../../internal/db/optional_driver_agent_stream.go) 与 [`optional_driver_agent_cancel.go`](../../internal/db/optional_driver_agent_cancel.go)。

## 运行时路径

```text
连库校验: app_db_connect.go -> verifyRuntimeOptionalDriverAgentRevision -> agent metadata -> revision 不一致只告警不阻断连库
普通查询: internal/app 查询入口 (DBQueryMulti / DBQuery / DBQueryIsolated / 托管事务)
            -> OptionalDriverAgentDB (query / queryMulti)
            -> 若旧版 agent 返回 ErrOptionalDriverAgentJSONLineTooLarge 且为无参只读非插件查询
            -> fallbackReadQueryToStreamOnOversize -> db.CollectStreamQueryWithBudget -> agent streamQuery (64 行分片)
            -> 不可回退或单行仍超限 -> localizeOptionalDriverAgentOversizeError -> 提示更新或重装驱动代理
```

## 状态与不变量

- 当前主进程与新版 agent 均已取消 32 MiB JSON Lines 单帧上限；`ErrOptionalDriverAgentJSONLineTooLarge` 仅用于兼容未重装的旧版 agent 二进制。
- 旧版 agent 触发写帧上限时不会写出半帧，而是返回完整的小失败帧，帧边界仍然可信；同一 transport 保持可用，不触发 `forceTerminate` 或连接池刷新重建。
- `CollectStreamQueryWithBudget` 命中 `RowBudget` 上限时立即取消派生的 `streamCtx` 触发在途 `cancelQuery`（旧代理无此能力时终止运输）以停止继续拉取，并仅在父 `ctx.Err() == nil` 时返回截断前缀且不报错。
- 仅无参、非插件只读事务、且在连接或当前托管会话上支持 `StreamQueryExecer` 的只读查询可回退到 `streamQuery`；含副作用的 query-first 写语句、参数化查询与插件只读查询严禁静默回退或丢参数重放。
- 修改 `cmd/optional-driver-agent/*` 或 `tools/generate-driver-agent-revisions.sh` 纳入的共享协议/驱动源码后，必须同步重新生成 `internal/db/driver_agent_revisions_gen.go`。

## 失败语义

- 读失败：旧版 agent 非流式单帧超 32 MiB 返回 `ErrOptionalDriverAgentJSONLineTooLarge`；只读查询自动流式回退，单行超过 32 MiB 或流式同样超限则包装为可操作的升级/重装提示并保留 `errors.Is(..., ErrOptionalDriverAgentJSONLineTooLarge)` 语义。
- 连接失败：`agent` 进程意外退出、`io.EOF` 或协议 ID 失步会终止 transport，只读操作由 `shouldRefreshCachedConnection` 触发重建；单帧超限错误不销毁缓存连接。
- 取消/超时：父 `ctx` 取消优先于预算截断；`collect` 不得将调用方取消误判为预算截断成功。
- 降级/回退：`StreamQueryContext` 在不支持流式的老代理上由 `OptionalDriverAgentDB` 回退到缓冲查询；而在旧代理能跑流式分片但 `query` 单帧超限时，主进程按预算回退至 `StreamQueryContext`。

## 验证

```bash
go test -race -count=1 ./internal/db -run 'TestCollectStreamQuery|TestOptionalDriverAgent|TestIsOptionalAgentOversize|TestReadOptionalDriverAgentJSONLine'
go test -race -count=1 ./internal/app -run 'Test.*Oversize|TestDBQueryMulti|TestDBQueryWith|TestDBQueryIsolated|TestManagedTransaction|TestDBQueryParams'
```

## 已知边界 / 未确认

- 仍保留极早期旧版（未带 `streamQuery` 且单帧上限 32 MiB）或单行本身超过 32 MiB 的旧代理场景：此时无法通过分片恢复，需在驱动管理中更新/重装驱动代理（新版已完全取消单帧上限）。
- Windows 与 Linux 平台下特定版本旧代理二进制的真实端到端表现未在本次 macOS 环境中联调，以单测伪管道与逻辑验证为准。
