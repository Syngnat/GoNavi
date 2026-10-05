import type { DataGridCssVars } from './dataGridStyles';

export const buildDataGridBodyCss = ({
    gridId,
    tableBodyBottomPadding,
    darkMode,
}: DataGridCssVars): string => `                .${gridId} .ant-table-content,

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

                    contain: layout style;

                    content-visibility: visible;

                }

                .${gridId} .ant-table-tbody-virtual-holder-inner {

                    padding-bottom: ${tableBodyBottomPadding}px;

                    box-sizing: border-box;

                    contain: layout style;

                }

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row,

                .${gridId} .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell {

                    contain: none;

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

                    contain: layout style;

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

                    content-visibility: visible;

                    contain-intrinsic-size: auto;

                }

                /* 虚拟表列对齐：
                 * - 去掉 min-width:100%，避免少列时 header 被强行拉到视口宽
                 * - 保留 rc-table FixedHolder 写入的 width:scrollX，保证 header.scrollLeft 可滚
                 *   （固定列依赖 header 真实 scrollLeft + sticky）
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

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-tbody-virtual-holder:not([data-horizontal-scroll-native="true"]),

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .rc-virtual-list-holder:not([data-horizontal-scroll-native="true"]) {

                    overflow-x: hidden !important;

                }

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"],

                .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .rc-virtual-list-holder[data-horizontal-scroll-native="true"] {

                    overflow-x: auto !important;

                    overscroll-behavior-x: contain;

                    scrollbar-width: none;

                }

                .${gridId} .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"],

                .${gridId} .rc-virtual-list-holder[data-horizontal-scroll-native="true"] {

                    overflow-x: auto !important;

                    overscroll-behavior-x: contain;

                }

                body[data-platform="darwin"] .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"],

                body[data-platform="darwin"] .${gridId} .data-grid-table-wrap.data-grid-table-wrap-external-active .rc-virtual-list-holder[data-horizontal-scroll-native="true"] {

                    scrollbar-width: none;

                }

                body[data-platform="darwin"] .${gridId} .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"]::-webkit-scrollbar,

                body[data-platform="darwin"] .${gridId} .rc-virtual-list-holder[data-horizontal-scroll-native="true"]::-webkit-scrollbar {

                    width: 0;

                    height: 0;

                }

                body[data-platform="windows"] .${gridId} .data-grid-external-horizontal-scroll {

                    display: none !important;

                }

                body[data-platform="windows"] .${gridId} .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"],

                body[data-platform="windows"] .${gridId} .rc-virtual-list-holder[data-horizontal-scroll-native="true"],

                body[data-platform="windows"] .${gridId} .ant-table-body {

                    scrollbar-width: auto;

                }

`;
