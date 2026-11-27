import React from 'react';
import { CaretDownFilled, CaretUpFilled } from '@ant-design/icons';

import { t } from '../../i18n';
import {
  TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX,
  type TableOverviewCompactColumn,
  type TableOverviewCompactColumnWidths,
} from '../../utils/tableOverviewCompactColumns';
import type {
  TableOverviewCompactColumnDefinition,
} from './tableOverviewCompactColumns';
import type { TableOverviewSortField, TableOverviewSortOrder } from '../../utils/tableOverviewFilter';

export interface TableOverviewCompactHeaderProps {
  columns: TableOverviewCompactColumnDefinition[];
  columnWidths?: TableOverviewCompactColumnWidths;
  sortField: TableOverviewSortField;
  sortOrder: TableOverviewSortOrder;
  toggleSort: (field: TableOverviewSortField) => void;
  onResizeStart?: (
    key: TableOverviewCompactColumn,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onResizeKeyDown?: (
    key: TableOverviewCompactColumn,
    event: React.KeyboardEvent<HTMLElement>,
  ) => void;
  onAutoFit?: (
    key: TableOverviewCompactColumn,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
}

const TableOverviewCompactHeader = React.memo(({
  columns,
  columnWidths,
  sortField,
  sortOrder,
  toggleSort,
  onResizeStart,
  onResizeKeyDown,
  onAutoFit,
}: TableOverviewCompactHeaderProps) => (
  <div className="gn-table-overview-compact-header" role="row">
    {columns.map((column) => {
      const active = column.sortField === sortField;
      const requestedWidth = columnWidths?.[column.key];
      const currentWidth = Math.round(Math.max(
        column.minWidth,
        Number.isFinite(requestedWidth) ? requestedWidth as number : column.minWidth,
      ));
      return (
        <div
          key={column.key}
          className="gn-table-overview-compact-column-header"
          data-table-overview-column-header={column.key}
          data-align={column.align}
          role="columnheader"
          aria-sort={active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : undefined}
        >
          {column.sortField ? (
            <button
              type="button"
              className="gn-table-overview-compact-sort-button"
              data-table-overview-sort={column.sortField}
              onClick={() => toggleSort(column.sortField as TableOverviewSortField)}
            >
              <span className="gn-table-overview-compact-header-label">
                {t(column.labelKey)}
              </span>
              {active && (
                <span className="gn-table-overview-compact-sort-indicator" aria-hidden="true">
                  {sortOrder === 'asc' ? <CaretUpFilled /> : <CaretDownFilled />}
                </span>
              )}
            </button>
          ) : (
            <span className="gn-table-overview-compact-plain-header">
              {t(column.labelKey)}
            </span>
          )}
          {onResizeStart && (
            <span
              className="gn-table-overview-compact-column-resizer"
              data-table-overview-column-resizer={column.key}
              role="separator"
              aria-label={`${t(column.labelKey)} · ${t('data_grid.column.resize_tooltip')}`}
              aria-orientation="vertical"
              aria-valuemin={column.minWidth}
              aria-valuemax={TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX}
              aria-valuenow={currentWidth}
              tabIndex={0}
              title={t('data_grid.column.resize_tooltip')}
              onPointerDown={(event) => onResizeStart(column.key, event)}
              onDoubleClick={(event) => onAutoFit?.(column.key, event)}
              onKeyDown={(event) => onResizeKeyDown?.(column.key, event)}
              onClick={(event) => event.stopPropagation()}
            />
          )}
        </div>
      );
    })}
  </div>
));

TableOverviewCompactHeader.displayName = 'TableOverviewCompactHeader';

export default TableOverviewCompactHeader;
