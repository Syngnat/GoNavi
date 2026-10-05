import { DATA_GRID_FILL_BODY_CSS } from './dataGridLayout';
import type { DataGridCssVars } from './dataGridStyles';

export const buildDataGridTableCss = ({
    gridId,
    darkMode,
    panelRadius,
    dataTableVerticalBorderRule,
    densityParams,
    fixedColumnFill,
    selectionColumnFill,
    rowAddedBg,
    rowModBg,
    bgContent,
}: DataGridCssVars): string => `${DATA_GRID_FILL_BODY_CSS}
                .${gridId} .data-grid-toolbar-scroll > * {

                    flex-shrink: 0;

                }

                .${gridId} .data-grid-toolbar-scroll::-webkit-scrollbar {

                    height: 7px;

                }

                .${gridId} .data-grid-toolbar-scroll::-webkit-scrollbar-thumb {

                    background: ${darkMode ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)'};

                    border: 0;

                    background-clip: border-box;

                    border-radius: 999px;

                }

                .${gridId} .data-grid-toolbar-scroll::-webkit-scrollbar-thumb:hover {

                    background: ${darkMode ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.32)'};

                    border: 0;

                    background-clip: border-box;

                }

                .${gridId} .data-grid-toolbar-scroll::-webkit-scrollbar-track {

                    background: transparent;

                }

                .${gridId} .ant-table,

                .${gridId} .ant-table-wrapper,

                .${gridId} .ant-table-container {

                    background: transparent !important;

                    border-radius: ${panelRadius}px !important;

                }

                .${gridId} .ant-table-wrapper,

                .${gridId} .ant-table-container {

                    border: none !important;

                    overflow: hidden !important;

                }

                .${gridId} .ant-table-tbody > tr > td,

                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell,

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell { background: transparent !important; border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} !important; border-inline-end: ${dataTableVerticalBorderRule} !important; font-size: ${densityParams.dataFontSize}px !important; vertical-align: middle !important; }

                .${gridId} .ant-table-thead > tr > th { background: transparent !important; border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} !important; border-inline-end: ${dataTableVerticalBorderRule} !important; font-size: ${densityParams.dataFontSize}px !important; }

                .${gridId} .ant-table-tbody > tr > td:last-child,

                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell:last-child,

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell:last-child,

                .${gridId} .ant-table-thead > tr > th:last-child {

                    border-inline-end-color: transparent !important;

                }

                /* 选择列对齐：header TH 无 class（Ant Design 虚拟模式），需用 :first-child 匹配 */

                .${gridId} .ant-table-header th:first-child,

                .${gridId} .ant-table-thead > tr > th:first-child {

                    text-align: center !important;

                    padding-inline-start: 0 !important;

                    padding-inline-end: 0 !important;

                    padding-left: 0 !important;

                    padding-right: 0 !important;

                }

                .${gridId} .ant-table-selection-column {

                    vertical-align: middle !important;

                    text-align: center !important;

                    padding-inline-start: 0 !important;

                    padding-inline-end: 0 !important;

                }

                .${gridId} .ant-table-selection-column .ant-checkbox-wrapper {

                    display: inline-flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    margin-right: 0 !important;

                }

                /* 窄表场景下 rc-table 会按视口等比放大选择列宽度，不能再额外锁死 header 宽度；

                   这里只统一 header/body 的内边距与对齐方式，避免第一列把后续数据列整体顶偏。 */

                .${gridId} .ant-table-tbody > tr > td.ant-table-selection-column,

                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell.ant-table-selection-column {

                    text-align: center !important;

                    vertical-align: middle !important;

                    padding-inline-start: 0 !important;

                    padding-inline-end: 0 !important;

                    padding-left: 0 !important;

                    padding-right: 0 !important;

                }

                .${gridId} .ant-table-tbody > tr > td.ant-table-selection-column .ant-checkbox-wrapper,

                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell.ant-table-selection-column .ant-checkbox-wrapper {

                    display: inline-flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    margin-right: 0 !important;

                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column {

                    display: flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    padding-inline-start: 0 !important;

                    padding-inline-end: 0 !important;

                    padding-left: 0 !important;

                    padding-right: 0 !important;

                }
                /*
                 * 固定列：
                 * - 表头：真实 scrollLeft + sticky（保留全选 / 行号）
                 * - Mac 虚拟表体：原生 scrollLeft + sticky 固定列
                 * - 其他虚拟表体：marginLeft + 单 CSS 变量补偿
                 * - 固定列表头 z-index 必须 > 列宽手柄(10)，否则其他列拖拽/筛选图标会穿透进来
                 */
                /* 普通表头压低层级，子元素（拖拽区/缩放条）不得盖过固定列 */
                .${gridId} .ant-table-header .ant-table-thead > tr > th {
                    z-index: 1;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th .react-resizable-handle,
                .${gridId} .ant-table-header .ant-table-thead > tr > th .sortable-header-cell-drag-handle {
                    z-index: 1 !important;
                }
                /*
                 * 固定列实心底：必须跟「非固定列透出的表格底」一致。
                 * V2：ant-table 用 --gn-bg-panel / thead 用 --gn-bg-panel-2（见 v2-theme.css）
                 * 非 V2：回退 bgContent（colorBgContainer）
                 * 禁止再写死 #141414 / #1f1f1d 一类色值。
                 */
                /* —— 表头固定 —— */
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left,
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-right,
                .${gridId} .ant-table-header th.ant-table-cell-fix-left,
                .${gridId} .ant-table-header th.ant-table-cell-fix-right,
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                .${gridId} .ant-table-thead > tr > th.ant-table-cell-fix-left,
                .${gridId} .ant-table-thead > tr > th.ant-table-cell-fix-right,
                .${gridId} .ant-table-thead > tr > th.data-grid-row-number-cell {
                    position: sticky !important;
                    z-index: 30 !important;
                    /* 与非固定表头一致：本网格 thead 被设为 transparent，透出 .ant-table 的 --gn-bg-panel */
                    background: ${fixedColumnFill} !important;
                    background-clip: padding-box !important;
                    transform: none !important;
                    overflow: hidden !important;
                    isolation: isolate;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th:first-child,
                .${gridId} .ant-table-header th:first-child,
                .${gridId} .ant-table-header th.ant-table-selection-column,
                .${gridId} .ant-table-thead > tr > th:first-child,
                .${gridId} .ant-table-thead > tr > th.ant-table-selection-column {
                    position: sticky !important;
                    left: 0 !important;
                    z-index: 32 !important;
                    transform: none !important;
                    overflow: hidden !important;
                    isolation: isolate;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th.data-grid-row-number-cell,
                .${gridId} .ant-table-header th.data-grid-row-number-cell {
                    left: 46px !important;
                    z-index: 31 !important;
                }
                .${gridId} .ant-table-header th.ant-table-selection-column .ant-checkbox-wrapper,
                .${gridId} .ant-table-header th:first-child .ant-checkbox-wrapper,
                .${gridId} .ant-table-header .ant-table-selection {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    position: relative;
                    z-index: 1;
                }
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                .${gridId} .ant-table-header th.data-grid-row-number-cell * {
                    visibility: visible !important;
                    opacity: 1 !important;
                }
                /* —— 表体固定：与 .ant-table 的 --gn-bg-panel 同色 —— */
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-first,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-last {
                    position: relative !important;
                    left: auto !important;
                    right: auto !important;
                    transform: translate3d(var(--gn-datagrid-h-scroll, 0px), 0, 0) !important;
                    will-change: transform;
                    z-index: 4 !important;
                    background: ${fixedColumnFill} !important;
                    background-clip: padding-box !important;
                    overflow: hidden !important;
                }
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header > table {
                    will-change: translate;
                }
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left-first,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left-last,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.data-grid-row-number-cell,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header thead > tr > th.ant-table-cell-fix-left,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header thead > tr > th.ant-table-selection-column,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header thead > tr > th.data-grid-row-number-cell {
                    position: relative !important;
                    left: auto !important;
                    right: auto !important;
                    isolation: auto;
                    translate: var(--gn-datagrid-h-scroll, 0px) 0 !important;
                    will-change: translate;
                }
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-right,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-right-first,
                .${gridId} .data-grid-table-wrap[data-horizontal-scroll-sync="transform"] .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-right-last {
                    position: relative !important;
                    left: auto !important;
                    right: auto !important;
                    isolation: auto;
                    translate: calc(var(--gn-datagrid-h-scroll, 0px) - var(--gn-datagrid-h-max, 0px)) 0 !important;
                    will-change: translate;
                }
                .${gridId} .ant-table-tbody > tr > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr > td.ant-table-cell-fix-right {
                    position: sticky !important;
                    z-index: 4 !important;
                    background: ${fixedColumnFill} !important;
                    background-clip: padding-box !important;
                    transform: none !important;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .ant-table-header th.ant-table-selection-column,
                .${gridId} .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr > td.ant-table-selection-column,
                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual-holder:not([data-horizontal-scroll-native="true"]) .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"] .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId}.data-grid-root .ant-table-header th.ant-table-selection-column,
                .${gridId}.data-grid-root .ant-table-thead > tr > th.ant-table-selection-column {
                    background: ${selectionColumnFill} !important;
                    background-clip: padding-box !important;
                }

                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left-last:not(.ant-table-selection-column),
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last:not(.ant-table-selection-column) {
                    box-shadow: ${darkMode
                        ? '4px 0 6px -2px rgba(0,0,0,0.45)'
                        : '4px 0 6px -2px rgba(15, 23, 42, 0.16)'} !important;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column {
                    box-shadow: none !important;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-right-first,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first {
                    box-shadow: ${darkMode
                        ? '-4px 0 6px -2px rgba(0,0,0,0.45)'
                        : '-4px 0 6px -2px rgba(15, 23, 42, 0.16)'} !important;
                }
                /* 固定列悬浮时保持实心底，防止透出横向滚动内容 */
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-cell-fix-right {
                    background: ${fixedColumnFill} !important;
                    background-image: none !important;
                }
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-selection-column {
                    background: ${selectionColumnFill} !important;
                }
                /* 固定列选中：与整行同一绿色（实心底防透出滚动内容） */
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-selection-column {
                    background: linear-gradient(var(--gn-bg-selected, rgba(34, 197, 94, 0.14)), var(--gn-bg-selected, rgba(34, 197, 94, 0.14))), ${fixedColumnFill} !important;
                }
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-selection-column {
                    background: linear-gradient(var(--gn-bg-selected, rgba(34, 197, 94, 0.14)), var(--gn-bg-selected, rgba(34, 197, 94, 0.14))), ${fixedColumnFill} !important;
                }
                .${gridId} .data-grid-row-number-cell {
                    text-align: center !important;
                    overflow: hidden !important;
                    padding: 0 !important;
                }
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.data-grid-row-number-cell,
                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell.data-grid-row-number-cell,
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                body[data-ui-version="v2"] .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.data-grid-row-number-cell,
                body[data-ui-version="v2"] .${gridId}.gn-v2-data-grid .ant-table-tbody .ant-table-row > .ant-table-cell.data-grid-row-number-cell {
                    padding: 0 !important;
                }
.${gridId} .ant-table-thead > tr:first-child > th:first-child,

                .${gridId} .ant-table-header table > thead > tr:first-child > th:first-child {

                    border-top-left-radius: ${panelRadius}px !important;

                }

                .${gridId} .ant-table-thead > tr:first-child > th:last-child,

                .${gridId} .ant-table-header table > thead > tr:first-child > th:last-child {

                    border-top-right-radius: ${panelRadius}px !important;

                }

                .${gridId} .ant-table-body {

                    border-bottom-left-radius: ${panelRadius}px !important;

                    border-bottom-right-radius: ${panelRadius}px !important;

                }

                .${gridId} .ant-table-thead > tr > th::before { display: none !important; }

                .${gridId} .ant-table-thead > tr > th .ant-table-column-sorters { cursor: default !important; }

                .${gridId} .ant-table-thead > tr > th .ant-table-column-sorter,

                .${gridId} .ant-table-thead > tr > th .ant-table-column-sorter * { cursor: pointer !important; }

                .${gridId}.data-grid-root .ant-table-tbody > tr:hover > td,

                .${gridId}.data-grid-root .ant-table-tbody .ant-table-row:hover > .ant-table-cell { background-color: transparent !important; }

                /* 固定行控制列（序号/单选/多选）在整行 hover 透明时仍保持实心底。 */
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody > tr:hover > td:is(.data-grid-row-number-cell, .ant-table-selection-column) {
                    background: ${selectionColumnFill} !important;
                }

                /* 当前单元格行列交叉高亮：仅增加中性半透明蒙层，不改变行勾选或单元格选区语义。 */
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row[data-active-cell-row="true"] > .ant-table-cell,
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row[data-active-cell-row="true"] > .ant-table-cell,
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row[data-active-cell-row="true"] > .ant-table-cell,
                .${gridId}.data-grid-root .ant-table-tbody > tr[data-active-cell-row="true"] > td.ant-table-cell,
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row > .ant-table-cell[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row > .ant-table-cell[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-tbody > tr > td.ant-table-cell[data-active-cell-column="true"] {
                    background-image: linear-gradient(
                        var(--gn-bg-hover, ${darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.045)'}),
                        var(--gn-bg-hover, ${darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.045)'})
                    ) !important;
                }

                /* 固定的勾选框/序号列在活动行 hover 时继续保留十字高亮蒙层。 */
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row[data-active-cell-row="true"]:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row[data-active-cell-row="true"]:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row[data-active-cell-row="true"]:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody > tr[data-active-cell-row="true"]:hover > td:is(.data-grid-row-number-cell, .ant-table-selection-column) {
                    background: ${selectionColumnFill} !important;
                }

                .${gridId}.data-grid-root .ant-table-header .ant-table-thead > tr > th.ant-table-cell[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-thead > tr > th.ant-table-cell[data-active-cell-column="true"] {
                    background-color: ${fixedColumnFill} !important;
                    background-image: linear-gradient(
                        var(--gn-bg-active, ${darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.075)'}),
                        var(--gn-bg-active, ${darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.075)'})
                    ) !important;
                }

                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-selection-column[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-tbody > tr > td.ant-table-selection-column[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-header .ant-table-thead > tr > th.ant-table-selection-column[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-thead > tr > th.ant-table-selection-column[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-header th.ant-table-selection-column:hover,
                .${gridId}.data-grid-root .ant-table-thead > tr > th.ant-table-selection-column:hover {
                    background: ${selectionColumnFill} !important;
                }

                /*
                 * 行选中：整行统一绿色。
                 * 关键：virtual-holder 下有
                 *   .row > .ant-table-cell { background: transparent !important }
                 * 特异性 0,4,1。选中规则必须 ≥ 该特异性，否则非固定列选中无效，
                 * 只会透出底色（看起来像一半绿一半黄/棕）。
                 */
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-cell-row-hover,
                .${gridId} .ant-table-tbody-virtual .ant-table-row.ant-table-row-selected > .ant-table-cell,
                .${gridId} .ant-table-tbody-virtual-holder-inner .ant-table-row.ant-table-row-selected > .ant-table-cell,
                .${gridId} .ant-table-tbody .ant-table-row.ant-table-row-selected > .ant-table-cell,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td,
                .${gridId} .ant-table-row.ant-table-row-selected > .ant-table-cell {
                    background: rgba(34, 197, 94, 0.14) !important;
                    background-color: rgba(34, 197, 94, 0.14) !important;
                    background-image: none !important;
                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-cell-row-hover,
                .${gridId} .ant-table-tbody-virtual .ant-table-row.ant-table-row-selected:hover > .ant-table-cell,
                .${gridId} .ant-table-tbody-virtual-holder-inner .ant-table-row.ant-table-row-selected:hover > .ant-table-cell,
                .${gridId} .ant-table-tbody .ant-table-row.ant-table-row-selected:hover > .ant-table-cell,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td,
                .${gridId} .ant-table-row.ant-table-row-selected:hover > .ant-table-cell {
                    background: rgba(34, 197, 94, 0.14) !important;
                    background-color: rgba(34, 197, 94, 0.14) !important;
                    background-image: none !important;
                }

                /* 选中行同样覆盖固定行控制列，保持与整行一致的选中底色。 */
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column),
                .${gridId}.data-grid-root .ant-table-tbody > tr:is(.ant-table-row-selected, .ant-table-row-selected:hover) > td:is(.data-grid-row-number-cell, .ant-table-selection-column) {
                    background-color: ${fixedColumnFill} !important;
                    background-image: linear-gradient(
                        var(--gn-bg-selected, rgba(34, 197, 94, 0.14)),
                        var(--gn-bg-selected, rgba(34, 197, 94, 0.14))
                    ) !important;
                }

                .${gridId} .row-added td,

                .${gridId} .row-added > .ant-table-cell { background-color: ${rowAddedBg} !important; color: ${darkMode ? '#e6fffb' : 'inherit'}; }

                .${gridId} .row-modified td,

                .${gridId} .row-modified > .ant-table-cell { background-color: ${rowModBg} !important; color: ${darkMode ? '#e6f7ff' : 'inherit'}; }

                .${gridId} .row-deleted td,

                .${gridId} .row-deleted > .ant-table-cell { background-color: ${darkMode ? '#1f1f1f' : '#f0f0f0'} !important; color: ${darkMode ? '#595959' : '#bfbfbf'} !important; text-decoration: line-through; }

                .${gridId} .ant-table-tbody > tr.row-added:hover > td,

                .${gridId} .ant-table-tbody .ant-table-row.row-added:hover > .ant-table-cell { background-color: ${rowAddedBg} !important; }

                .${gridId} .ant-table-tbody > tr.row-modified:hover > td,

                .${gridId} .ant-table-tbody .ant-table-row.row-modified:hover > .ant-table-cell { background-color: ${rowModBg} !important; }

                .${gridId} .ant-table-tbody > tr.row-deleted:hover > td,

                .${gridId} .ant-table-tbody .ant-table-row.row-deleted:hover > .ant-table-cell { background-color: ${darkMode ? '#1f1f1f' : '#f0f0f0'} !important; }

                .${gridId}.cell-edit-mode .ant-table-tbody > tr > td[data-col-name],

                .${gridId}.cell-edit-mode .ant-table-tbody .ant-table-row > .ant-table-cell[data-col-name] { user-select: none; -webkit-user-select: none; cursor: crosshair; }

                /* 单元格选区：与行选中/主题强调色统一为 V2 绿色，不用黄色 selectionAccent */
                .${gridId} .ant-table-tbody > tr > td[data-cell-selected="true"],
                .${gridId} .ant-table-tbody .ant-table-row > .ant-table-cell[data-cell-selected="true"],
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-selected="true"],
                .${gridId} [data-cell-selected="true"] {
                    box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e) !important;
                    background-color: transparent !important;
                    background-image: linear-gradient(
                        var(--gn-bg-selected, rgba(34, 197, 94, 0.14)),
                        var(--gn-bg-selected, rgba(34, 197, 94, 0.14))
                    ) !important;
                }

                /* 待提交编辑：由真实 table cell 统一承载底色；data-grid-root 的特异性保证其压过整行选中/悬停及固定列底色。 */
                .${gridId}.data-grid-root .ant-table-tbody > tr > td.ant-table-cell[data-cell-modified="true"],
                .${gridId}.data-grid-root .ant-table-tbody .ant-table-row > .ant-table-cell[data-cell-modified="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-modified="true"] {
                    background-color: var(--gn-bg-panel, ${bgContent || (darkMode ? '#141414' : '#ffffff')}) !important;
                    background-image: linear-gradient(
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'}),
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'})
                    ) !important;
                }

                .${gridId}.data-grid-root .ant-table-tbody > tr:hover > td.ant-table-cell[data-cell-modified="true"],
                .${gridId}.data-grid-root .ant-table-tbody .ant-table-row:hover > .ant-table-cell[data-cell-modified="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell[data-cell-modified="true"] {
                    background-color: var(--gn-bg-panel, ${bgContent || (darkMode ? '#141414' : '#ffffff')}) !important;
                    background-image: linear-gradient(
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'}),
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'})
                    ) !important;
                }

                .${gridId}.data-grid-root .ant-table-tbody > tr > td.ant-table-cell[data-cell-modified="true"][data-cell-selected="true"],
                .${gridId}.data-grid-root .ant-table-tbody .ant-table-row > .ant-table-cell[data-cell-modified="true"][data-cell-selected="true"],
                .${gridId}.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-modified="true"][data-cell-selected="true"] {
                    box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e) !important;
                    background-color: var(--gn-bg-panel, ${bgContent || (darkMode ? '#141414' : '#ffffff')}) !important;
                    background-image: linear-gradient(
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'}),
                        var(--gn-warn-soft, ${darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0'})
                    ) !important;
                }

                /* V2 虚拟编辑器自身无边框，由实际 cell 提供不被 overflow 裁切的焦点描边。 */
                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-editing="true"] {
                    box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e) !important;
                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last[data-cell-modified="true"][data-cell-selected="true"],
                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last[data-cell-editing="true"] {
                    box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e), ${darkMode
                        ? '4px 0 6px -2px rgba(0,0,0,0.45)'
                        : '4px 0 6px -2px rgba(15, 23, 42, 0.16)'} !important;
                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first[data-cell-modified="true"][data-cell-selected="true"],
                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first[data-cell-editing="true"] {
                    box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e), ${darkMode
                        ? '-4px 0 6px -2px rgba(0,0,0,0.45)'
                        : '-4px 0 6px -2px rgba(15, 23, 42, 0.16)'} !important;
                }

`;
