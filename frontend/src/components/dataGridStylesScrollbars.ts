import type { DataGridCssVars } from './dataGridStyles';

export const buildDataGridScrollbarCss = ({
    gridId,
    floatingScrollbarThumbBg,
    floatingScrollbarHeight,
    verticalScrollbarTrackBg,
    floatingScrollbarThumbBorderColor,
    floatingScrollbarThumbShadow,
    floatingScrollbarThumbHoverBg,
    floatingScrollbarInset,
    floatingScrollbarBottomOffset,
    horizontalScrollbarTrackBg,
    horizontalScrollbarTrackBorderColor,
    horizontalScrollbarTrackShadow,
    horizontalScrollbarThumbBg,
    horizontalScrollbarThumbBorderColor,
    horizontalScrollbarThumbShadow,
    horizontalScrollbarThumbHoverBg,
    paginationShellBorderColor,
    paginationShellBg,
    paginationShellShadow,
    dataGridBackdropFilter,
    paginationChipBorderColor,
    paginationChipBg,
    paginationPrimaryTextColor,
    paginationAccentBg,
    paginationAccentBorderColor,
    paginationActiveItemTextColor,
}: DataGridCssVars): string => `                body:not([data-platform="windows"]) .${gridId} .ant-table-body {

                    scrollbar-width: thin;

                    scrollbar-color: ${floatingScrollbarThumbBg} transparent;

                }

                body:not([data-platform="windows"]) .${gridId} .ant-table-body::-webkit-scrollbar {

                    width: ${floatingScrollbarHeight}px;

                    height: 0;

                }

                body:not([data-platform="windows"]) .${gridId} .ant-table-body::-webkit-scrollbar-track {

                    background: ${verticalScrollbarTrackBg};

                    margin: 8px 0;

                    border-radius: 999px;

                }

                body:not([data-platform="windows"]) .${gridId} .ant-table-body::-webkit-scrollbar-thumb {

                    background: ${floatingScrollbarThumbBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    border-radius: 999px;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                body:not([data-platform="windows"]) .${gridId} .ant-table-body::-webkit-scrollbar-thumb:hover {

                    background: ${floatingScrollbarThumbHoverBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                body:not([data-platform="windows"]) .${gridId} .rc-virtual-list-holder {

                    scrollbar-width: thin;

                    scrollbar-color: ${floatingScrollbarThumbBg} transparent;

                }

                body:not([data-platform="windows"]) .${gridId} .rc-virtual-list-holder::-webkit-scrollbar {

                    width: ${floatingScrollbarHeight}px;

                    height: 0;

                }

                body:not([data-platform="windows"]) .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-track {

                    background: ${verticalScrollbarTrackBg};

                    margin: 8px 0;

                    border-radius: 999px;

                }

                body:not([data-platform="windows"]) .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-thumb {

                    background: ${floatingScrollbarThumbBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    border-radius: 999px;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                body:not([data-platform="windows"]) .${gridId} .rc-virtual-list-holder::-webkit-scrollbar-thumb:hover {

                    background: ${floatingScrollbarThumbHoverBg};

                    border: 1px solid ${floatingScrollbarThumbBorderColor};

                    background-clip: border-box;

                    box-shadow: ${floatingScrollbarThumbShadow};

                }

                .${gridId} .ant-table-tbody-virtual-holder[data-virtual-scrollbar-controlled="true"] {

                    scrollbar-width: none;

                }

                .${gridId} .ant-table-tbody-virtual-holder[data-virtual-scrollbar-controlled="true"]::-webkit-scrollbar {

                    width: 0;

                    height: 0;

                }

                .${gridId} .ant-table-tbody-virtual-scrollbar-vertical {

                    width: ${floatingScrollbarHeight}px !important;

                    right: 0 !important;

                    z-index: 25;

                }

                .${gridId} .ant-table-tbody-virtual-scrollbar-vertical .ant-table-tbody-virtual-scrollbar-thumb {

                    background: ${floatingScrollbarThumbBg} !important;

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

`;
