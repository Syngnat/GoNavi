# frontend/patches —— rc 依赖补丁（patch-package）

通过 package.json 的 `postinstall: patch-package --error-on-fail` 在 `npm install` / `npm ci` 后自动应用。

## 补丁清单

| 补丁 | 作用 | 测试锚点 |
|------|------|----------|
| `rc-table+7.54.0.patch` | VirtualTable 列虚拟化窗口 `columnVirtualWindow`：只渲染水平可视窗内的列（overscan 640/960px，原生纵向滚动时 overscan 归 0），并给 `BodyLine` / `VirtualCell` 加 memo 比较，减少宽表重渲染。消费点 `src/components/dataGrid/shell/DataGridTableSurface.tsx` 的 `listItemColumnVirtual`。 | `src/utils/rcTableColumnVirtualWindow.test.ts` |
| `rc-virtual-list+3.19.2.patch` | `itemHeightFixed` 原生纵向滚动模式（去掉 Filler/transform 模拟滚动）、`itemHeightResolver`（可变行高），以及外层高度变化时同步视口区间，避免首屏底部留白。 | `src/components/virtualListNativeScroll.test.tsx` |
| `rc-resize-observer+1.4.3.patch` | 侧栏拖拽/过渡期间**延迟** ResizeObserver 通知：新增 `deferredSidebarResizeTargets` 集合，按 `<body>` 上的 `data-sidebar-resizing` / `data-sidebar-transitioning` 属性判定是否处于侧栏 resize 中，收到 `gonavi:sidebar-resize-settled` 事件后统一 flush。避免拖侧栏时每次尺寸变化级联触发大量 observer 回调。配套模块侧代码 `src/utils/sidebarResizeLifecycle.ts`。 | `src/utils/sidebarResizeLifecycle.test.ts`<br>`src/utils/rcResizeObserverSidebarLifecycle.test.ts` |
| `rc-tree+5.13.1.patch` | 把 `itemHeightFixed` / `itemHeightResolver` 两个 prop 透传到 rc-tree 的 `NodeList` → `VirtualList`（es/lib 各一份）。让**侧栏对象树**也能复用原生滚动 + 精确行高，而不只是结果集表格。消费点 `src/components/sidebar/SidebarObjectExplorer.tsx` 的 `itemHeightResolver={resolveSidebarTreeRowHeight}`（定义在 `src/components/sidebar/sidebarV2TreeNodes.ts`）。 | 无独立测试锚点；行为由 `src/components/virtualListNativeScroll.test.tsx` 与 `src/components/Sidebar.locate-toolbar.test.tsx` 间接覆盖 |
| `@rc-component+trigger+2.3.1.patch` | `useAlign` 在临时测量前后优先写 `inset`（不支持时回退长属性），并在检测到 WebKitGTK 的陈旧 layout 时做一次短促的 `display` 切换强制 flush。否则 Dropdown / Popover 会永远停在 `-1000vw/-1000vh`。 | `src/appShell/hooks/useAppAntdTheme.motion.test.ts`；Linux WebKitGTK 2.44 + Xvfb 手测 About / 列筛选浮层 |

## 注意：`--ignore-scripts` 会跳过补丁

`npm ci --ignore-scripts`（或 pnpm 默认阻止 postinstall）不会执行 postinstall，补丁不会应用，
此时 `listItemHeightFixed` / `listItemColumnVirtual` / `itemHeightResolver` 等 props 静默无效
（表现为滚动回退到 transform 模拟、宽表全量渲染列、侧栏定高失效）。

因此：

- CI 与本地首次安装需允许 scripts（不要加 `--ignore-scripts`），或在构建脚本中显式执行
  `npx patch-package` / `node node_modules/patch-package/dist/index.js`。
- 本地手动验证：在 `frontend/` 下执行
  `node node_modules/patch-package/dist/index.js --error-on-fail`，
  输出五个包各一行 `✔`（`rc-table@7.54.0 ✔` / `rc-virtual-list@3.19.2 ✔` /
  `rc-resize-observer@1.4.3 ✔` / `rc-tree@5.13.1 ✔` /
  `@rc-component/trigger@2.3.1 ✔`）即为干净 apply。

## ⚠️ 版本绑定风险（本仓库当前是浮动约束）

补丁与依赖版本**强绑定**：patch 文件名里的版本号就是生成基准，`--error-on-fail` 在补丁应用失败时直接中断安装。

当前 `package.json` 里 `antd` 是 caret 约束 `"^5.12.0"`，而补丁锁定的是它传递依赖的具体版本：

| 包 | 补丁锁定版本 | lock 当前解析 | package.json 约束 |
|---|---|---|---|
| `antd` | — | 5.29.3 | `^5.12.0`（浮动） |
| `rc-table` | 7.54.0 | 7.54.0 | 无直接约束 |
| `rc-virtual-list` | 3.19.2 | 3.19.2 | 无直接约束 |
| `rc-resize-observer` | 1.4.3 | 1.4.3 | 无直接约束 |
| `rc-tree` | 5.13.1 | 5.13.1 | 无直接约束 |
| `@rc-component/trigger` | 2.3.1 | 2.3.1 | 无直接约束 |

**风险**：`package-lock.json` 目前把版本钉死在补丁基准上（一致，安全），但 upgrade `antd` 时
若把 rc-* 传递依赖顶到补丁不兼容的新版本，会出现「安装报错」或「补丁应用成功但语义已偏」两种情况。
`patch-package` 在**版本号不匹配但补丁仍能应用**时只打印 Warning 并继续（不中断），
所以版本漂移不一定在 CI 立刻暴露 —— 需要靠上表的测试锚点兜底。

**建议**：升级 `antd` / rc-* 后，先跑上表五个锚点测试；确认行为等价后再以新版本为基础重新生成补丁
（`npx patch-package rc-table` 等）。若希望升级时立刻被拦住，可考虑把 `antd` 也改成精确版本，
或显式声明 rc-table / rc-virtual-list / rc-tree / rc-resize-observer 的传递依赖约束。

## 升级 rc-* 依赖时

1. 升级依赖，`npm install`（允许 scripts）。
2. 跑上表全部测试锚点，确认功能未回退。
3. 补丁与版本强绑定，需以新版本 `node_modules` 为基准**重新生成等价补丁**：
   改完 node_modules 里的源码后 `npx patch-package <包名>` 导出，并重命名/更新本表。
4. 若某个补丁在新版本已原生支持（上游合并），删除该补丁并在本表标注。
