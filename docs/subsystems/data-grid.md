# DataGrid

## 职责与边界

负责表数据和查询结果的虚拟滚动、单元格/行选择、编辑草稿、复制粘贴、筛选排序与保存交互。不负责数据库方言的执行实现；SQL 生成和落库由 `internal/app` 与对应驱动完成。

## 真源

- 页面编排：`frontend/src/components/DataGrid.tsx`、`DataGridShell.tsx`
- 单元格选择与交互：`frontend/src/components/dataGrid/batchActions/`
- 剪贴板载荷与解析：`dataGridClipboardPayload.ts`、`dataGridClipboardPaste.ts`
- 单元格复制矩阵：`dataGridSelectionCopy.ts`
- 复制事件与菜单：`dataGrid/v2Actions/useDataGridV2ColumnActions.ts`
- 编辑草稿：`dataGrid/hooks/useDataGridCellEditing.ts`、`useDataGridCommit.ts`

## 运行时路径

1. 鼠标拖选、Shift 点击或键盘移动更新 `currentSelectionRef`，同时同步 DOM 高亮和 React `selectedCells`。
2. `copy` 事件在触发时读取最新选区引用，生成 TSV/HTML/CSV/Markdown/JSON 载荷并同步写入事件剪贴板。
3. `paste` 事件优先读取应用内 JSON，其次 HTML、CSV、纯文本；按粘贴起点和可见列顺序映射到目标行。
4. 粘贴先写入 `modifiedRows` / `modifiedColumns` 草稿，再由保存或自动提交链路落库。

## 状态与不变量

- 复制必须使用事件发生时的最新选区，不能依赖可能滞后一帧的 React state。
- 已存在单元格或整行选区时，页面残留的 DOM 文本选区不得抢占复制。
- 单元格复制保持可见行列顺序；稀疏矩阵缺失位置写空字符串。
- 单值粘贴可填充多单元格选区；矩阵粘贴按起点平铺，越过边界必须提示。
- 截断预览值禁止粘贴写回，避免覆盖数据库原始 LOB。

## 失败语义

- 剪贴板为空、缺少粘贴锚点、只读网格或目标越界时不写入草稿，并给出明确提示。
- 富格式不可用时回退纯文本；复制是否成功以实际写入结果为准。
- 粘贴矩阵没有有效可写单元格时不产生保存草稿。

## 验证

```bash
cd frontend
npx vitest run src/components/dataGrid src/components/dataGridClipboardPaste.test.ts src/components/dataGridSelectionCopy.test.ts src/components/useDataGridBatchActions.test.tsx
npx tsc --noEmit
```

涉及原生剪贴板的行为仍需在 macOS 与 Windows 桌面 WebView 中各做一次手工复制粘贴验证。
