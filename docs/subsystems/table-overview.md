# 表概览

## 职责与边界

- 负责：展示当前库/模式下的表列表与统计信息，支持搜索、排序、置顶、卡片/列表/表格视图切换、表格视图列配置与列宽拖拽，以及表对象右键动作。
- 不负责：元数据读取本身、连接生命周期、结果集编辑、表结构设计器的字段编辑、同步任务调度。

## 真源

- 页面入口：`frontend/src/components/TableOverview.tsx`。
- 页面状态：`frontend/src/components/tableOverview/hooks/useTableOverviewState.ts`。
- 表格视图：`frontend/src/components/tableOverview/TableOverviewRows.tsx`、`frontend/src/components/tableOverview/hooks/useTableOverviewRenderers.tsx`。
- 列宽交互：`frontend/src/components/tableOverview/hooks/useTableOverviewCompactColumnResize.ts`。
- 列定义与网格样式：`frontend/src/components/tableOverview/tableOverviewCompactColumns.ts`、`frontend/src/utils/tableOverviewCompactColumns.ts`。
- 唯一写入点：表概览状态通过 `setQueryOptions` 写入 `queryOptions.tableOverviewCompactColumns` 与 `queryOptions.tableOverviewCompactColumnWidths`。

## 运行时路径

```text
打开表概览页签
  -> useTableOverviewState.loadData
  -> DBGetTables / DBQuery
  -> parseTableStats + 搜索/排序/置顶
  -> TableOverviewRows 渲染表格视图
  -> 拖拽列宽手柄时显示独立的轻量定位线，不改所有行的网格列宽
  -> 松手后按位移量计算最终宽度，先直接更新网格变量完成视觉落位
  -> 下一帧后 setQueryOptions 持久化列宽
  -> 表头按新宽度更新 aria-valuenow，表格主体复用已渲染行
```

## 状态与不变量

- 列宽手柄属于左侧列的右边界；拖拽只改变该列宽度。
- 松手提交值必须是 `起始列宽 + (松手 clientX - 按下 clientX)`，不能把 `clientX` 绝对值直接当列宽。
- 宽度先按列定义的最小宽度和 `TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX` 夹取，写入 Store 时再次清洗。
- 拖拽过程中不写 React/Store 状态，也不触发 300 行表格重排；只移动一条 `position: fixed` 的定位线。
- 松手时先落 DOM 宽度，持久化延后到下一次绘制后，避免 React 更新阻塞松手反馈。
- 列头是 38px 的吸顶栏；排序使用原生 `<button>`，只有当前排序列设置 `aria-sort`，其余列不写 `none`。
- 列宽手柄有列名级 `aria-label`、当前宽度和键盘左右键调整能力。
- 300 行主体使用 memo 行组件与 `content-visibility: auto`，列宽变化不重建行内容。
- 只点击手柄、没有产生宽度变化时不写入列宽。
- 列宽当前是全局偏好，不按连接或数据库分别保存。

## 失败语义

- 元数据读取失败：页面提示加载失败，旧表列表不被伪造。
- `pointercancel`、组件卸载：移除定位线并放弃提交。
- 窗口失焦：按最后预览宽度提交，避免拖拽状态卡住。
- 持久化值非法或越界：读取时由 `sanitizeTableOverviewCompactColumnWidths` 清洗。

## 验证

```bash
cd frontend
npx vitest run src/components/tableOverview
npx tsc --noEmit
```

共享列宽/指针交互变更还需要在 Chromium 和 WebKit 实际拖拽验证；WebKit 覆盖 macOS Wails，Chromium 覆盖 Windows WebView2 的基础事件模型。

## 已知边界 / 未确认

- 当前列宽不区分连接、数据库或模式。
- 触控板与鼠标的 pointer 事件在 Windows WebView2 上的细节仍需真机验证。
