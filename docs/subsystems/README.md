# 子系统设计参考

这些页面描述**当前行为**，不是需求历史，也不是提案。
改代码前先读对应子系统；改完后同一 PR 内更新页面，别让下一位 Agent 读到旧结构。

## 核心子系统

| 子系统 | 真源 | 当前文档 |
| --- | --- | --- |
| Wails 绑定与 `QueryResult` | `internal/app/`、`internal/connection/` | 待补 |
| 数据源契约与驱动 | `internal/db/`、`docs/driver-manifest.json` | 待补 |
| 连接、凭据与生产保护 | `internal/app/`、`internal/secretstore/`、`internal/sqlaudit/` | 待补 |
| Query Editor | `frontend/src/components/queryEditor/`、`QueryEditor.tsx` | 待补 |
| DataGrid | `frontend/src/components/DataGrid*.tsx`、`dataGrid*` | 待补 |
| Zustand 状态与持久化 | `frontend/src/store.ts`、`store/` | 待补 |
| i18n 与 catalog | `shared/i18n/`、`tools/i18n-scan/` | 待补 |
| 插件运行时 / Driver Agent | `internal/plugin/`、`internal/pluginmarket/`、`cmd/optional-driver-agent/` | 部分：`docs/plugins/README.md` |
| 脚本工作台 | `frontend/src/components/scriptWorkbench/`、Go 执行引擎 | 部分：`docs/features/script-workbench.md` |
| Wails v3 迁移 | `cmd/wails3app/`、`scripts/build-wails3.mjs` | 部分：`WAILS3_MIGRATION.md` |
| Hive 支持 | `internal/db/` 的 Hive 实现、`internal/hivesql/` | 部分：`HIVE_SUPPORT.md` |
| 数据同步 | `internal/sync/`、`frontend/src/components/data-sync/` | 部分：`DATA_SYNC_TASKS.md` |

“待补”不是可以跳过：第一次改某个子系统时，先把该页补到能回答下面六个问题，再改代码。

### 侧栏对象与会话入口（当前行为）

1. **职责与边界**：侧栏负责智能体会话入口、对象筛选、表/视图复制粘贴；不负责连接管理、会话内容解析和同步任务调度。
2. **真源**：智能体节点在 `frontend/src/components/sidebar/sidebarAgentTreeNodes.tsx`；剪贴板在 `useSidebarTableClipboard.ts`；视图复制后端在 `internal/app/methods_view_copy.go`；定义页签在 `frontend/src/components/definitionViewer/`。
3. **运行时路径**：侧栏点击/快捷键 -> `addTab` 或对象动作 -> Wails `App` 方法 -> 驱动执行 DDL/读取定义 -> `gonavi:sidebar-database-refresh` 刷新侧栏与定义页签。
4. **状态与不变量**：`agent-integration` 不受表/视图筛选影响；视图复制要求同一连接，目标可跨数据库或模式，目标名从 `_copy1` 递增且不覆盖；`schemaChanged=true` 时定义页签必须重读；对象编辑页签的“保存”执行整段 DDL。
5. **失败语义**：定义读取失败不保留旧对象；视图定义不可读或跨库复制时返回明确错误；DDL 失败不触发定义刷新。
6. **验证**：`npx vitest run src/components/sidebar src/components/DefinitionViewer.object-edit.test.tsx`、`npx tsc --noEmit`、`go test ./internal/app ./shared/i18n`。

已知边界：视图复制依赖宿主已有的视图 DDL 获取能力；智能体会话入口已在浏览器 mock、macOS 1.2.3 和当前源码验证，无条件“点击无反应”未复现。

## 每个页面必须回答

1. **职责与边界**：这个子系统负责什么，明确不负责什么。
2. **真源**：哪个文件/类型/配置是唯一事实来源。
3. **运行时路径**：从用户入口到最终副作用，经过哪些层。
4. **状态与不变量**：哪些状态必须一起变，哪些值不能被默认值覆盖。
5. **失败语义**：读失败、网络失败、取消、超时分别意味着什么。
6. **验证**：最相关的 Go/Vitest/构建命令，以及必须真机验证的平台。

## 写和改的规则

- 只写当前行为；提案写 issue/PR，不写进本目录。
- 引用函数名和文件路径，不复制大段实现。
- 不写“未来计划”“暂定”；未确认就标“未确认”。
- 行为变了就更新页面；只改文档不改代码，或只改代码不改文档，都不算完成。
- 页面控制在能读完的规模；超过 300 行就按运行时路径拆页。

模板见 [`TEMPLATE.md`](./TEMPLATE.md)。
