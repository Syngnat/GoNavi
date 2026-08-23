type DataGridCssTextParams = Record<string, any>;

export const buildDataGridCssText = ({
    darkMode,
    bgContent,
    dataGridBackdropFilter,
    dataTableVerticalBorderRule,
    densityParams,
    floatingScrollbarBottomOffset,
    floatingScrollbarHeight,
    floatingScrollbarInset,
    floatingScrollbarThumbBg,
    floatingScrollbarThumbBorderColor,
    floatingScrollbarThumbHoverBg,
    floatingScrollbarThumbShadow,
    gridId,
    horizontalScrollbarThumbBg,
    horizontalScrollbarThumbBorderColor,
    horizontalScrollbarThumbHoverBg,
    horizontalScrollbarThumbShadow,
    horizontalScrollbarTrackBg,
    horizontalScrollbarTrackBorderColor,
    horizontalScrollbarTrackShadow,
    paginationAccentBg,
    paginationAccentBorderColor,
    paginationActiveItemBg,
    paginationActiveItemBorderColor,
    paginationActiveItemTextColor,
    paginationChipBg,
    paginationChipBorderColor,
    paginationHoverBg,
    paginationPrimaryTextColor,
    paginationSecondaryTextColor,
    paginationShellBg,
    paginationShellBorderColor,
    paginationShellShadow,
    panelRadius,
    rowAddedBg,
    rowModBg,
    selectionAccentHex,
    selectionAccentRgb,
    tableBodyBottomPadding,
    useVirtualEditablePaintContain,
    useVirtualEditableVisibilityHints,
    useVirtualHolderPaintHints,
    useVirtualRowCellContain,
    verticalScrollbarTrackBg,
}: DataGridCssTextParams) => `

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
                 * - 表头：scrollLeft + sticky（保留全选 / 行号）
                 * - 虚拟表体：marginLeft + translateX 补偿
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
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .ant-table-header th.ant-table-cell-fix-left,
                .${gridId} .ant-table-header th.ant-table-cell-fix-right,
                .${gridId} .ant-table-header th.ant-table-selection-column,
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                .${gridId} .ant-table-thead > tr > th.ant-table-cell-fix-left,
                .${gridId} .ant-table-thead > tr > th.ant-table-cell-fix-right,
                .${gridId} .ant-table-thead > tr > th.ant-table-selection-column,
                .${gridId} .ant-table-thead > tr > th.data-grid-row-number-cell {
                    position: sticky !important;
                    z-index: 30 !important;
                    /* 与非固定表头一致：本网格 thead 被设为 transparent，透出 .ant-table 的 --gn-bg-panel */
                    background: var(--gn-bg-panel, ${bgContent}) !important;
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
                    /* 全选列与钉住列/行号同色；覆盖 v2-theme 里可能的 panel-2 */
                    background: var(--gn-bg-panel, ${bgContent}) !important;
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
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-first,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-last,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-first,
                .${gridId} .ant-table-tbody-virtual .ant-table-row > .ant-table-cell.ant-table-cell-fix-right-last {
                    position: relative !important;
                    left: auto !important;
                    right: auto !important;
                    transform: translate3d(var(--gn-datagrid-h-scroll, 0px), 0, 0) !important;
                    will-change: transform;
                    z-index: 4 !important;
                    background: var(--gn-bg-panel, ${bgContent}) !important;
                    background-clip: padding-box !important;
                    overflow: hidden !important;
                }
                .${gridId} .ant-table-tbody > tr > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr > td.ant-table-selection-column {
                    position: sticky !important;
                    z-index: 4 !important;
                    background: var(--gn-bg-panel, ${bgContent}) !important;
                    background-clip: padding-box !important;
                    transform: none !important;
                }
                .${gridId} .ant-table-header .ant-table-thead > tr > th.ant-table-cell-fix-left-last,
                .${gridId} .ant-table-header th.data-grid-row-number-cell,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last {
                    box-shadow: ${darkMode
                        ? '4px 0 6px -2px rgba(0,0,0,0.45)'
                        : '4px 0 6px -2px rgba(15, 23, 42, 0.16)'} !important;
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
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr:hover > td.ant-table-selection-column {
                    background: var(--gn-bg-panel, ${bgContent}) !important;
                    background-image: none !important;
                }
                /* 固定列选中：与整行同一绿色（实心底防透出滚动内容） */
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td.ant-table-selection-column {
                    background: rgba(34, 197, 94, 0.14) !important;
                    background-color: rgba(34, 197, 94, 0.14) !important;
                    background-image: none !important;
                }
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row.ant-table-row-selected:hover > .ant-table-cell.ant-table-selection-column,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-cell-fix-left,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-cell-fix-right,
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td.ant-table-selection-column {
                    background: rgba(34, 197, 94, 0.14) !important;
                    background-color: rgba(34, 197, 94, 0.14) !important;
                    background-image: none !important;
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
                    background: var(--gn-bg-panel, ${bgContent}) !important;
                    background-image: none !important;
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
                    background-color: var(--gn-bg-panel, ${bgContent}) !important;
                    background-image: linear-gradient(
                        var(--gn-bg-hover, ${darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.045)'}),
                        var(--gn-bg-hover, ${darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.045)'})
                    ) !important;
                }

                .${gridId}.data-grid-root .ant-table-header .ant-table-thead > tr > th.ant-table-cell[data-active-cell-column="true"],
                .${gridId}.data-grid-root .ant-table-thead > tr > th.ant-table-cell[data-active-cell-column="true"] {
                    background-color: var(--gn-bg-panel, ${bgContent}) !important;
                    background-image: linear-gradient(
                        var(--gn-bg-active, ${darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.075)'}),
                        var(--gn-bg-active, ${darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.075)'})
                    ) !important;
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
                    background-color: var(--gn-bg-panel, ${bgContent}) !important;
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

                .${gridId} .ant-table-content,

                .${gridId} .ant-table-body {

                    scrollbar-gutter: stable;

                }

                .${gridId} .ant-table-body {

                    padding-bottom: ${tableBodyBottomPadding}px;

                    box-sizing: border-box;

                    scroll-padding-bottom: ${tableBodyBottomPadding}px;

                    contain: layout paint style;

                }

                .${gridId} .ant-table-tbody-virtual-holder,

                .${gridId} .rc-virtual-list-holder {

                    padding-bottom: ${tableBodyBottomPadding}px;

                    box-sizing: border-box;

                    scroll-padding-bottom: ${tableBodyBottomPadding}px;

                    contain: ${useVirtualHolderPaintHints ? 'layout paint style' : 'layout style'};

                    content-visibility: ${useVirtualHolderPaintHints ? 'auto' : 'visible'};

                }

                .${gridId} .ant-table-tbody-virtual-holder-inner {

                    padding-bottom: ${tableBodyBottomPadding}px;

                    box-sizing: border-box;

                    contain: ${useVirtualHolderPaintHints ? 'layout paint style' : 'layout style'};

                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row,

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell {

                    contain: ${useVirtualRowCellContain ? 'layout paint style' : 'none'};

                }

                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell {

                    overflow: hidden;

                    text-overflow: ellipsis;

                    white-space: nowrap;

                }

                .${gridId}.gn-v2-data-grid .ant-table-tbody > tr > td,

                .${gridId}.gn-v2-data-grid .ant-table-tbody .ant-table-row > .ant-table-cell,

                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell {

                    vertical-align: middle !important;

                }

                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-row-hover,

                .${gridId}.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.data-grid-virtual-inline-editing {

                    overflow: visible;

                    text-overflow: clip;

                    white-space: normal;

                }

                .${gridId} .data-grid-table-wrap {

                    width: 100%;

                    max-width: 100%;

                    overflow: hidden;

                }

                .${gridId} .ant-table-sticky-scroll {

                    display: none !important;

                }

                .${gridId} .data-grid-find-highlight {

                    padding: 0 1px;

                    border-radius: 3px;

                    background: ${darkMode ? 'rgba(246, 196, 83, 0.42)' : 'rgba(255, 193, 7, 0.42)'};

                    color: inherit;

                }

                .${gridId} .data-grid-record-json-field-match {

                    padding: 0 1px;

                    border-radius: 3px;

                    background: ${darkMode ? 'rgba(246, 196, 83, 0.22)' : 'rgba(255, 193, 7, 0.22)'};

                    box-shadow: inset 0 -1px 0 ${darkMode ? 'rgba(246, 196, 83, 0.7)' : 'rgba(181, 132, 0, 0.65)'};

                }

                .${gridId} .data-grid-record-json-field-match-active {

                    background: ${darkMode ? 'rgba(246, 196, 83, 0.48)' : 'rgba(255, 193, 7, 0.48)'};

                    outline: 1px solid ${darkMode ? 'rgba(246, 196, 83, 0.92)' : 'rgba(181, 132, 0, 0.86)'};

                }

                .${gridId} .data-grid-record-field-search {

                    display: inline-flex;

                    align-items: center;

                    gap: 4px;

                    height: 24px;

                    min-height: 24px;

                }

                .${gridId} .data-grid-record-field-search-autocomplete,

                .${gridId} .data-grid-record-field-search-autocomplete .ant-select-selector,

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper {

                    height: 24px !important;

                    min-height: 24px !important;

                    box-sizing: border-box !important;

                }

                .${gridId} .data-grid-record-field-search-autocomplete,

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper {

                    display: inline-flex !important;

                    align-items: center !important;

                }

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper {

                    padding-top: 0 !important;

                    padding-bottom: 0 !important;

                }

                .${gridId} .data-grid-record-field-search .ant-input,

                .${gridId} .data-grid-record-field-search .ant-input::placeholder {

                    font-size: 12px !important;

                }

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper-focused,

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper:focus,

                .${gridId} .data-grid-record-field-search .ant-input-affix-wrapper:focus-within,

                .${gridId} .data-grid-record-field-search-autocomplete.ant-select-focused,

                .${gridId} .data-grid-record-field-search-autocomplete.ant-select-focused .ant-select-selector,

                .${gridId} .data-grid-record-field-search .ant-input:focus,

                .${gridId} .data-grid-record-field-search .ant-input:focus-visible {

                    outline: none !important;

                    box-shadow: none !important;

                }

                .${gridId} .data-grid-record-field-search-navigation.ant-btn {

                    display: inline-flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    align-self: center !important;

                    width: 24px !important;

                    min-width: 24px !important;

                    height: 24px !important;

                    min-height: 24px !important;

                    margin: 0 !important;

                    padding: 0 !important;

                    line-height: 1 !important;

                    box-sizing: border-box !important;

                }

                .${gridId} .data-grid-record-field-search-position {

                    display: inline-flex;

                    align-items: center;

                    justify-content: flex-end;

                    min-width: 42px;

                    height: 24px;

                    font-size: 12px;

                    line-height: 24px;

                    opacity: 0.66;

                    white-space: nowrap;

                    text-align: right;

                }

                .${gridId} .editable-cell-value-wrap {

                    display: block;

                    width: 100%;

                    min-width: 0;

                    min-height: 20px;

                    padding-right: 0;

                    position: relative;

                    contain: ${useVirtualEditablePaintContain ? 'layout paint style' : 'layout style'};

                }

                .${gridId} .editable-cell-value-wrap > * {

                    min-width: 0;

                }

                .${gridId} .data-grid-inline-editor-form-item,

                .${gridId} .data-grid-inline-editor-form-item .ant-form-item-row,

                .${gridId} .data-grid-inline-editor-form-item .ant-form-item-control,

                .${gridId} .data-grid-inline-editor-form-item .ant-form-item-control-input,

                .${gridId} .data-grid-inline-editor-form-item .ant-form-item-control-input-content {

                    width: 100%;

                    min-width: 0;

                }

                .${gridId} .data-grid-inline-editor-input,

                .${gridId} .data-grid-inline-editor-form-item .ant-picker {

                    width: 100% !important;

                    min-width: 0;

                }

                .${gridId} .ant-table-tbody-virtual-holder .editable-cell-value-wrap {

                    content-visibility: ${useVirtualEditableVisibilityHints ? 'auto' : 'visible'};

                    contain-intrinsic-size: ${useVirtualEditableVisibilityHints ? '24px 160px' : 'auto'};

                }

                /* 虚拟表列对齐：
                 * - 去掉 min-width:100%，避免少列时 header 被强行拉到视口宽
                 * - 保留 rc-table FixedHolder 写入的 width:scrollX，保证 header.scrollLeft 可滚
                 *   （固定列依赖 header 真实 scrollLeft + sticky，不能改成 marginLeft）
                 */
                .${gridId} .ant-table-header > table {
                    min-width: 0 !important;
                }
                /* 外部滚动条激活时 header 仍需可被程序设置 scrollLeft（overflow:hidden 也允许） */
                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-header {
                    overflow: hidden !important;
                }

                .${gridId} .ant-table-tbody-virtual-scrollbar.ant-table-tbody-virtual-scrollbar-horizontal {

                    display: none !important;

                }

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-content {

                    overflow-x: hidden !important;

                }

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-body {

                    overflow-x: hidden !important;

                    overflow-y: auto !important;

                }

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-tbody-virtual-holder,

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .rc-virtual-list-holder {

                    overflow-x: hidden !important;

                }

                .${gridId} .ant-table-body {

                    scrollbar-width: thin;

                    scrollbar-color: ${floatingScrollbarThumbBg} transparent;

                }

                .${gridId} .ant-table-body::-webkit-scrollbar {

                    width: ${floatingScrollbarHeight}px;

                    height: 0;

                }

                .${gridId} .ant-table-body::-webkit-scrollbar-track {

                    background: ${verticalScrollbarTrackBg};

                    margin: 8px 0;

                    border-radius: 999px;

                }

                .${gridId} .ant-table-body::-webkit-scrollbar-thumb {

                    background: ${floatingScrollbarThumbBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    border-radius: 999px;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                .${gridId} .ant-table-body::-webkit-scrollbar-thumb:hover {

                    background: ${floatingScrollbarThumbHoverBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                .${gridId} .rc-virtual-list-holder {

                    scrollbar-width: thin;

                    scrollbar-color: ${floatingScrollbarThumbBg} transparent;

                }

                .${gridId} .rc-virtual-list-holder::-webkit-scrollbar {

                    width: ${floatingScrollbarHeight}px;

                    height: 0;

                }

                .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-track {

                    background: ${verticalScrollbarTrackBg};

                    margin: 8px 0;

                    border-radius: 999px;

                }

                .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-thumb {

                    background: ${floatingScrollbarThumbBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    border-radius: 999px;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-thumb:hover {

                    background: ${floatingScrollbarThumbHoverBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                .${gridId} .data-grid-external-horizontal-scroll {

                    position: absolute;

                    left: ${floatingScrollbarInset}px;

                    right: ${floatingScrollbarInset}px;

                    bottom: ${floatingScrollbarBottomOffset}px;

                    height: ${floatingScrollbarHeight + 4}px;

                    overflow-x: auto;

                    overflow-y: hidden;

                    background: transparent;

                    z-index: 24;

                }

                .${gridId} .data-grid-external-horizontal-scroll::-webkit-scrollbar {

                    height: ${floatingScrollbarHeight}px;

                }

                .${gridId} .data-grid-external-horizontal-scroll::-webkit-scrollbar-track {

                    background: ${horizontalScrollbarTrackBg};

                    border: 1px solid ${horizontalScrollbarTrackBorderColor};

                    border-radius: 999px;

                    box-shadow: ${horizontalScrollbarTrackShadow};

                }

                .${gridId} .data-grid-external-horizontal-scroll::-webkit-scrollbar-thumb {

                    background: ${horizontalScrollbarThumbBg};

                    border: 1px solid ${horizontalScrollbarThumbBorderColor};

                    background-clip: border-box;

                    border-radius: 999px;

                    box-shadow: ${horizontalScrollbarThumbShadow};

                }

                .${gridId} .data-grid-external-horizontal-scroll::-webkit-scrollbar-thumb:hover {

                    background: ${horizontalScrollbarThumbHoverBg};

                    border: 1px solid ${horizontalScrollbarThumbBorderColor};

                    background-clip: border-box;

                    box-shadow: ${horizontalScrollbarThumbShadow};

                }

                .${gridId} .data-grid-external-horizontal-scroll-inner {

                    height: 1px;

                }

                .${gridId} .data-grid-pagination-shell {

                    display: inline-flex;

                    align-items: center;

                    justify-content: flex-end;

                    gap: 10px;

                    flex-wrap: wrap;

                    max-width: 100%;

                    padding: 8px 10px;

                    border-radius: 16px;

                    border: 1px solid ${paginationShellBorderColor};

                    background: ${paginationShellBg};

                    box-shadow: ${paginationShellShadow};

                    backdrop-filter: ${dataGridBackdropFilter};

                    -webkit-backdrop-filter: ${dataGridBackdropFilter};

                }

                .${gridId} .data-grid-pagination-summary,

                .${gridId} .data-grid-pagination-page-chip {

                    display: inline-flex;

                    align-items: center;

                    gap: 8px;

                    min-height: 34px;

                    padding: 0 12px;

                    border-radius: 999px;

                    border: 1px solid ${paginationChipBorderColor};

                    background: ${paginationChipBg};

                    color: ${paginationPrimaryTextColor};

                    font-size: 12px;

                    line-height: 1;

                    font-variant-numeric: tabular-nums;

                    white-space: nowrap;

                }

                .${gridId} .data-grid-pagination-kicker {

                    display: inline-flex;

                    align-items: center;

                    height: 20px;

                    padding: 0 8px;

                    border-radius: 999px;

                    background: ${paginationAccentBg};

                    border: 1px solid ${paginationAccentBorderColor};

                    color: ${paginationActiveItemTextColor};

                    font-size: 11px;

                    font-weight: 700;

                    letter-spacing: 0.02em;

                }

                .${gridId} .data-grid-pagination-summary-value {

                    color: ${paginationPrimaryTextColor};

                    font-weight: 600;

                    font-variant-numeric: tabular-nums;

                }

                .${gridId} .data-grid-pagination-page-chip {

                    color: ${paginationSecondaryTextColor};

                    font-weight: 600;

                }

                .${gridId} .ant-pagination {

                    display: inline-flex;

                    align-items: center;

                    gap: 6px;

                    margin: 0;

                    color: ${paginationPrimaryTextColor};

                }

                .${gridId} .ant-pagination .ant-pagination-item,

                .${gridId} .ant-pagination .ant-pagination-prev,

                .${gridId} .ant-pagination .ant-pagination-next,

                .${gridId} .ant-pagination .ant-pagination-jump-prev,

                .${gridId} .ant-pagination .ant-pagination-jump-next {

                    min-width: 34px;

                    height: 34px;

                    margin-inline-end: 0;

                    border-radius: 12px;

                    border: 1px solid ${paginationChipBorderColor};

                    background: ${paginationChipBg};

                    box-shadow: none;

                    display: inline-flex;

                    align-items: center;

                    justify-content: center;

                    overflow: hidden;

                    transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;

                }

                .${gridId} .ant-pagination .ant-pagination-item a,

                .${gridId} .ant-pagination .ant-pagination-prev .ant-pagination-item-link,

                .${gridId} .ant-pagination .ant-pagination-next .ant-pagination-item-link,

                .${gridId} .ant-pagination .ant-pagination-prev > *,

                .${gridId} .ant-pagination .ant-pagination-next > * {

                    display: flex;

                    align-items: center;

                    justify-content: center;

                    width: 100%;

                    height: 100%;

                    color: ${paginationPrimaryTextColor};

                    font-weight: 600;

                    border: none;

                    background: transparent;

                    border-radius: inherit;

                    line-height: 1;

                }

                .${gridId} .ant-pagination .ant-pagination-item:hover,

                .${gridId} .ant-pagination .ant-pagination-prev:hover,

                .${gridId} .ant-pagination .ant-pagination-next:hover {

                    background: ${paginationHoverBg};

                    border-color: ${paginationActiveItemBorderColor};

                    transform: translateY(-1px);

                }

                .${gridId} .ant-pagination .ant-pagination-item-active {

                    border-color: ${paginationActiveItemBorderColor};

                    background: ${paginationActiveItemBg};

                    box-shadow: inset 0 0 0 1px ${paginationAccentBorderColor};

                }

                .${gridId} .ant-pagination .ant-pagination-item-active a {

                    color: ${paginationActiveItemTextColor};

                }

                .${gridId} .ant-pagination .ant-pagination-disabled,

                .${gridId} .ant-pagination .ant-pagination-disabled:hover {

                    background: transparent;

                    border-color: ${paginationChipBorderColor};

                    transform: none;

                    opacity: 0.42;

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev,

                .${gridId} .ant-pagination .ant-pagination-jump-next {

                    padding: 0;

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-link,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-link {

                    position: relative;

                    display: flex;

                    align-items: center;

                    justify-content: center;

                    width: 100%;

                    height: 100%;

                    padding: 0;

                    margin: 0;

                    line-height: 1;

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-container,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-container {

                    display: flex;

                    align-items: center;

                    justify-content: center;

                    width: 100%;

                    height: 100%;

                    position: relative;

                    line-height: 1;

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-ellipsis,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-ellipsis,

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-link-icon,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-link-icon {

                    position: absolute !important;

                    top: 0 !important;

                    right: 0 !important;

                    bottom: 0 !important;

                    left: 0 !important;

                    inset: 0 !important;

                    width: fit-content !important;

                    height: fit-content !important;

                    min-width: 0 !important;

                    min-height: 0 !important;

                    margin: auto !important;

                    padding: 0 !important;

                    transform: none !important;

                    display: inline-flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    line-height: 1 !important;

                    color: ${paginationSecondaryTextColor};

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-ellipsis,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-ellipsis {

                    letter-spacing: 0.18em;

                    text-indent: 0.18em;

                    text-align: center;

                }

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-link-icon .anticon,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-link-icon .anticon,

                .${gridId} .ant-pagination .ant-pagination-jump-prev .ant-pagination-item-link-icon svg,

                .${gridId} .ant-pagination .ant-pagination-jump-next .ant-pagination-item-link-icon svg {

                    display: inline-flex !important;

                    align-items: center !important;

                    justify-content: center !important;

                    width: 1em;

                    height: 1em;

                    line-height: 1;

                }

                .${gridId} .data-grid-pagination-nav-icon {

                    display: inline-flex;

                    align-items: center;

                    justify-content: center;

                    width: 100%;

                    height: 100%;

                    font-size: 12px;

                    line-height: 1;

                }

                .${gridId} .data-grid-pagination-nav-icon .anticon {

                    display: inline-flex;

                    align-items: center;

                    justify-content: center;

                    width: 100%;

                    height: 100%;

                }

                .${gridId} .data-grid-pagination-jump {

                    display: inline-flex;

                    align-items: center;

                    gap: 6px;

                    height: 34px;

                    color: ${paginationSecondaryTextColor};

                    font-size: 12px;

                    font-weight: 600;

                    white-space: nowrap;

                }

                .${gridId} .data-grid-pagination-jump-label {

                    color: ${paginationSecondaryTextColor};

                    font-variant-numeric: tabular-nums;

                }

                .${gridId} .data-grid-pagination-jump-input,

                .${gridId} .data-grid-pagination-jump-input.ant-input-number {

                    width: 64px;

                    min-width: 64px;

                    height: 34px;

                    display: inline-flex;

                    align-items: stretch;

                }

                .${gridId} .data-grid-pagination-jump-input .ant-input-number-input-wrap,

                .${gridId} .data-grid-pagination-jump-input .ant-input-number-input {

                    height: 100%;

                }

                .${gridId} .data-grid-pagination-jump-input .ant-input-number-input {

                    padding: 0 10px;

                    text-align: center;

                    color: ${paginationPrimaryTextColor};

                    font-weight: 600;

                    font-variant-numeric: tabular-nums;

                    line-height: 34px;

                }

                .${gridId} .data-grid-pagination-jump-input.ant-input-number {

                    border-radius: 12px;

                    border: 1px solid ${paginationChipBorderColor};

                    background: ${paginationChipBg};

                    box-shadow: none;

                }

                .${gridId} .data-grid-pagination-jump-button.ant-btn {

                    height: 34px;

                    min-width: 34px;

                    padding: 0 10px;

                    border-radius: 12px;

                    border-color: ${paginationChipBorderColor};

                    background: ${paginationChipBg};

                    color: ${paginationPrimaryTextColor};

                    font-weight: 700;

                    box-shadow: none;

                }

                .${gridId} .data-grid-pagination-size-select {

                    width: 72px;

                    min-width: 72px;

                    max-width: 72px;

                    height: 34px;

                    display: inline-flex;

                    align-items: stretch;

                }

                .${gridId} .data-grid-pagination-size-select.ant-select-single,

                .${gridId} .data-grid-pagination-size-select.ant-select-single.ant-select-sm {

                    width: 72px;

                    min-width: 72px;

                    max-width: 72px;

                    height: 34px;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-selector {

                    height: 34px !important;

                    border-radius: 12px !important;

                    border: 1px solid ${paginationChipBorderColor} !important;

                    background: ${paginationChipBg} !important;

                    box-shadow: none !important;

                    padding: 0 24px 0 10px !important;

                    display: flex !important;

                    align-items: center !important;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-wrap {

                    display: flex !important;

                    align-items: center !important;

                    height: 100%;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-search,

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-search-input {

                    height: 100% !important;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-item,

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-placeholder {

                    display: flex;

                    align-items: center;

                    height: 100%;

                    line-height: 34px !important;

                    color: ${paginationPrimaryTextColor};

                    font-weight: 600;

                    justify-content: flex-start;

                    font-variant-numeric: tabular-nums;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-selection-search {

                    inset-inline-start: 10px !important;

                    inset-inline-end: 24px !important;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-arrow {

                    color: ${paginationSecondaryTextColor};

                    inset-inline-end: 10px;

                    top: 50%;

                    transform: translateY(-50%);

                    margin-top: 0;

                    display: inline-flex;

                    align-items: center;

                    justify-content: center;

                    height: 16px;

                    line-height: 1;

                }

                .${gridId} .data-grid-pagination-size-select .ant-select-arrow .anticon {

                    display: inline-flex;

                    align-items: center;

                    justify-content: center;

                    line-height: 1;

                }

  `;
