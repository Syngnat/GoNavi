export const TABLE_DESIGNER_SHELL_CSS = `
            .table-designer-shell .ant-table,
            .table-designer-shell .ant-table-wrapper,
            .table-designer-shell .ant-table-container {
                background: transparent !important;
            }
            .table-designer-shell .ant-table-wrapper {
                border: none !important;
                overflow: hidden !important;
            }
            .table-designer-shell .ant-table-container {
                border: none !important;
            }
            .table-designer-shell .ant-table-thead > tr > th {
                background: var(--gn-bg-panel-2) !important;
                border-bottom: 1px solid var(--gn-br-1) !important;
                border-inline-end: var(--gn-data-table-vertical-border, none) !important;
            }
            .table-designer-shell .ant-table-tbody > tr > td,
            .table-designer-shell .ant-table-tbody .ant-table-row > .ant-table-cell {
                background: transparent !important;
                border-bottom: 1px solid var(--gn-br-1) !important;
                border-inline-end: var(--gn-data-table-vertical-border, none) !important;
            }
            .table-designer-shell .ant-table-tbody td .ant-input {
                padding-left: 0 !important;
                padding-right: 0 !important;
            }
            .table-designer-shell .ant-table-tbody td .ant-select .ant-select-selector {
                padding-left: 0 !important;
            }
            .table-designer-shell .table-designer-cell-field {
                display: flex;
                align-items: center;
                min-height: 34px;
                padding: 0 10px;
                border: 1px solid var(--gn-br-2);
                border-radius: 10px;
                background: var(--gn-bg-input);
                box-sizing: border-box;
            }
            .table-designer-shell .table-designer-cell-field .ant-input,
            .table-designer-shell .table-designer-cell-field .ant-select,
            .table-designer-shell .table-designer-cell-field .ant-select-selector,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-search,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-item {
                background: transparent !important;
            }
            .table-designer-shell .table-designer-cell-field .ant-input,
            .table-designer-shell .table-designer-cell-field .ant-select-selection-item,
            .table-designer-shell .table-designer-cell-field input {
                font-size: 13px;
                line-height: 1.4;
            }
            .table-designer-shell .table-designer-cell-field .ant-select {
                width: 100%;
            }
            .table-designer-shell .table-designer-cell-field .ant-select-selector,
            .table-designer-shell .table-designer-cell-field .ant-input {
                padding: 0 !important;
                box-shadow: none !important;
            }
            .table-designer-shell .table-designer-cell-field.is-compact {
                padding-right: 6px;
            }
            .table-designer-shell .table-designer-cell-check {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                min-height: 34px;
            }
            .table-designer-shell .table-designer-cell-check .ant-checkbox-wrapper {
                margin-inline-end: 0 !important;
            }
            .table-designer-shell .table-designer-cell-check.is-left-aligned {
                justify-content: flex-start;
            }
            .table-designer-shell .table-designer-header-title {
                display: inline-flex;
                align-items: center;
                justify-content: flex-start;
                width: 100%;
                line-height: 1.1;
                white-space: nowrap;
            }
            .table-designer-shell .table-designer-select-check {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 100%;
                min-height: 28px;
            }
            .table-designer-shell .table-designer-select-check .ant-checkbox-wrapper {
                margin-inline-end: 0 !important;
            }
            .table-designer-shell .table-designer-select-column {
                text-align: center !important;
                vertical-align: middle !important;
            }
            .table-designer-shell .table-designer-action-column {
                text-align: left !important;
            }
            .table-designer-shell .table-designer-comment-field {
                gap: 4px;
                padding-right: 4px;
            }
            .table-designer-shell .table-designer-comment-field .ant-input {
                flex: 1;
                min-width: 0;
            }
            .table-designer-shell .table-designer-comment-display {
                flex: 1;
                min-width: 0;
                min-height: 28px;
                display: flex;
                align-items: center;
                font: inherit;
                line-height: 1.4;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: text;
            }
            .table-designer-shell .table-designer-comment-display.is-empty {
                color: var(--gn-fg-5);
            }
            .table-designer-shell .table-designer-action-cell {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
            }
            .table-designer-shell .table-designer-action-cell .ant-btn {
                width: 28px;
                height: 28px;
                padding: 0;
                border-radius: 8px;
            }
            .table-designer-shell .ant-table-thead > tr > th::before {
                display: none !important;
            }
            .table-designer-shell .ant-table-thead > tr > th {
                cursor: default !important;
                user-select: none !important;
                -webkit-user-select: none !important;
            }
            .table-designer-shell .ant-table-tbody > tr:hover > td,
            .table-designer-shell .ant-table-tbody .ant-table-row:hover > .ant-table-cell {
                background: var(--gn-bg-hover) !important;
            }
            .table-designer-shell .ant-tabs-nav {
                margin-bottom: 8px !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav {
                margin-bottom: 0 !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-nav {
                margin-bottom: 0 !important;
            }
            .table-designer-shell .ant-tabs-nav::before {
                border-bottom-color: var(--gn-br-1) !important;
            }
            .table-designer-shell .ant-tabs-ink-bar {
                will-change: transform;
                transition: width 0.15s ease, left 0.15s ease, transform 0.15s ease !important;
            }
            .table-designer-shell .ant-tabs-tab {
                transition: color 0.15s ease !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav-wrap,
            .table-designer-shell.gn-v2-table-designer .ant-tabs-nav-list {
                width: auto !important;
                min-height: 34px !important;
                align-items: center !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-tab {
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
                min-height: 34px !important;
                margin: 0 !important;
                padding: 0 12px !important;
                border-right: 0 !important;
                border-bottom: 0 !important;
                white-space: nowrap !important;
            }
            .table-designer-shell.gn-v2-table-designer .ant-tabs-tab-btn {
                width: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-nav-wrap,
            .table-designer-shell.is-embedded .ant-tabs-nav-list {
                width: auto !important;
                min-height: 34px !important;
                align-items: center !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-tab {
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
                min-height: 34px !important;
                margin: 0 !important;
                padding: 0 12px !important;
                border-right: 0 !important;
                border-bottom: 0 !important;
                white-space: nowrap !important;
            }
            .table-designer-shell.is-embedded .ant-tabs-tab-btn {
                width: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field {
                min-height: 28px;
                padding-inline: 0;
                border: none !important;
                border-radius: 0;
                background: transparent !important;
                box-shadow: none !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input:focus,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-input-focused,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-select-selector,
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field .ant-select-focused .ant-select-selector {
                border: none !important;
                box-shadow: none !important;
                background: transparent !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-display,
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field .ant-input,
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field .ant-input input {
                font-size: 12px !important;
                line-height: 1.4 !important;
                font-family: inherit !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-field.is-compact {
                padding-right: 0;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-comment-field {
                padding-right: 0;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-cell-check {
                min-height: 30px;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-select-check {
                min-height: 22px;
            }
            .table-designer-shell.is-embedded .table-designer-select-check {
                min-height: 14px !important;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-action-cell {
                justify-content: flex-start;
                gap: 4px;
            }
            .table-designer-shell.gn-v2-table-designer .table-designer-action-cell .ant-btn {
                width: 26px;
                height: 26px;
                border-radius: 7px;
            }
            .table-designer-shell .ant-tabs-content-holder,
            .table-designer-shell .ant-tabs-content,
            .table-designer-shell .ant-tabs-tabpane {
                height: 100%;
            }
            .table-designer-shell .react-resizable-handle {
                position: absolute !important;
                right: 0 !important;
                top: 0 !important;
                bottom: 0 !important;
                width: 10px !important;
                height: auto !important;
                background-position: top right !important;
                cursor: col-resize !important;
                z-index: 10;
                touch-action: none;
            }

        `;
