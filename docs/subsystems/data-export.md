# 数据导出工作台

## 职责与边界

- 负责：单表与批量对象导出、SQL 备份/仅数据/结构导出、数据文件格式导出、
  导出字段选择、导出进度与历史摘要。
- 不负责：查询结果页的临时结果导出、跨库数据同步、SQL 文件执行与导入。

## 真源

- Wails 绑定：`internal/app/methods_file_export_table.go`、`methods_file_export_tables.go`
- 工作台状态：`frontend/src/components/tableExport/hooks/useTableExportState.ts`
- 执行动作：`frontend/src/components/tableExport/hooks/useTableExportRunActions.ts`
- 配置界面：`frontend/src/components/tableExport/`
- Tab 构建：`frontend/src/utils/tableExportTab.ts`
- 右键入口：`frontend/src/components/sidebar/useSidebarCopyExportActions.tsx`、
  `frontend/src/components/tableOverview/hooks/useTableOverviewTableActions.tsx`

## 运行时路径

```text
侧栏/表概览右键“打开导出工作台”
  -> buildBatchTableExportWorkbenchTab(initialObjectNames + initialFormat)
  -> table-export 标签页（batch-tables）
  -> 加载数据库/对象/字段元数据
  -> 数据文件格式：ExportTableWithOptions（单对象 + 字段选择）
  -> SQL 格式：ExportTablesSQLWithOptions（可多对象，一个 SQL 文件）
  -> export:progress 事件 -> 当前任务面板与最近任务
```

## 状态与不变量

- 同一连接与数据库的批量表工作台使用稳定 Tab ID；重复打开会更新预设对象和格式，
  不会创建第二套页面。
- 右键“打开导出工作台”默认打开 `batch-tables`、预选当前表、初始格式为 XLSX。
- SQL 工具中的“批量处理表”使用同一工作台；未显式带格式时默认 SQL，
  未显式指定导出内容时默认“仅数据”，选定表后即可配置逐表字段。
- 数据文件格式（CSV/XLSX/JSON/Markdown/HTML）一次只能导出一个对象；
  选择多个对象时格式会回到 SQL。
- 数据文件格式和 SQL 的数据导出都会按表加载字段选择，默认全选；
  字段配置在独立的大尺寸弹窗中完成，弹窗左侧切换表、右侧宽区域选择字段，
  避免在窄侧栏里逐表无限纵向展开。SQL 的“结构”模式不涉及数据字段。
- 弹窗左侧表切换区展示已选表的表注释（通过 `DBGetTableInfo` 读取），
  并加宽到可容纳长表名、字段计数和注释。
- 字段以胶囊标签（chip）排列并自动换行：选中项为浅绿底、绿边、左侧绿色勾选和加粗字段名，
  未选中项为浅色底、灰边、灰字；标签内同时展示后端返回的字段类型和注释（存在时），
  完整信息在悬停提示中展示。
- 批量 SQL 可导出结构、仅数据或结构+数据；对象进度按对象计数。
- 共享导出配置弹窗内的格式、范围、字段等下拉浮层挂在可拖拽弹窗容器内，
  随弹窗移动；不能回落到 `body` 后继续使用上一次的屏幕坐标。

## 失败语义

- 数据库/对象/字段元数据加载失败：保留已有选择，显示原地重试入口并阻止开始。
- 字段选择为空：数据文件导出开始按钮保持禁用。
- 多个对象加数据文件格式：自动切回 SQL，避免生成多个未知目标文件。
- 导出取消、超时与写入失败沿用 `export:progress` 和现有任务结果分类。

## 验证

```bash
cd frontend
npx vitest run src/utils/tableExportTab.test.ts \
  src/components/sidebar/useSidebarBatchExport.test.ts \
  src/components/TableExportWorkbench.test.tsx \
  src/components/TableExportWorkbench.sql-export-and-history.test.tsx
npx tsc --noEmit
npm run build
```

## 已知边界

- 数据文件批量导出尚未支持多个对象分别生成多个文件；需要该能力时应新增目录选择与
  后端批量数据导出接口，而不是在多个保存对话框中循环。
- SQL 批量导出按 `ExportFileOptions.tableColumns` 传递每张表的字段集合；
  未提供的表仍按全字段导出。
- 右键入口默认 XLSX；SQL 备份入口仍应使用“备份为数据库脚本”或批量处理表的 SQL 模式。
