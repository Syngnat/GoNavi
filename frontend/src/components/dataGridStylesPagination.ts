import type { DataGridCssVars } from './dataGridStyles';

export const buildDataGridPaginationCss = ({
    gridId,
    paginationPrimaryTextColor,
    paginationSecondaryTextColor,
    paginationChipBorderColor,
    paginationChipBg,
    paginationHoverBg,
    paginationActiveItemBorderColor,
    paginationActiveItemBg,
    paginationAccentBorderColor,
    paginationActiveItemTextColor,
}: DataGridCssVars): string => `                .${gridId} .data-grid-pagination-summary-value {

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
