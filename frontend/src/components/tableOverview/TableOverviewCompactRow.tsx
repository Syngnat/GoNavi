import React from 'react';
import { TableOutlined } from '@ant-design/icons';

import { formatRows, formatSize, type TableStatRow } from './tableOverviewModel';
import type { TableOverviewCompactColumnDefinition } from './tableOverviewCompactColumns';

export interface TableOverviewCompactRowProps {
  table: TableStatRow;
  displayName: string;
  columns: TableOverviewCompactColumnDefinition[];
  isSelected: boolean;
  openTableByDefaultAction: (tableName: string) => void;
  openV2OverviewContextMenu: (event: React.MouseEvent, table: TableStatRow) => void;
  renderMetadataHover: (
    table: TableStatRow,
    displayName: string,
    child: React.ReactElement,
  ) => React.ReactElement;
  formatTimestamp: (value?: string) => string;
}

const renderCompactCell = (
  table: TableStatRow,
  displayName: string,
  column: TableOverviewCompactColumnDefinition,
  formatTimestamp: (value?: string) => string,
) => {
  if (column.key === 'name') {
    return (
      <div key={column.key} className="gn-table-overview-compact-name" role="cell">
        <TableOutlined aria-hidden="true" />
        <span title={displayName}>{displayName}</span>
      </div>
    );
  }

  let text = '—';
  switch (column.key) {
    case 'comment':
      text = table.comment || '—';
      break;
    case 'rows':
      text = formatRows(table.rows);
      break;
    case 'dataSize':
      text = formatSize(table.dataSize);
      break;
    case 'indexSize':
      text = formatSize(table.indexSize);
      break;
    case 'engine':
      text = table.engine || '—';
      break;
    case 'charset':
      text = table.charset || '—';
      break;
    case 'collation':
      text = table.collation || '—';
      break;
    case 'updateTime':
      text = table.updateTime ? formatTimestamp(table.updateTime) : '—';
      break;
    case 'createTime':
      text = table.createTime ? formatTimestamp(table.createTime) : '—';
      break;
    default:
      break;
  }

  return (
    <div
      key={column.key}
      className={`gn-table-overview-compact-cell${column.align === 'right' ? ' gn-table-overview-compact-number' : ''}`}
      role="cell"
    >
      {text}
    </div>
  );
};

const TableOverviewCompactRow = React.memo(({
  table,
  displayName,
  columns,
  isSelected,
  openTableByDefaultAction,
  openV2OverviewContextMenu,
  renderMetadataHover,
  formatTimestamp,
}: TableOverviewCompactRowProps) => {
  const content = (
    <div
      className={`gn-table-overview-compact-row${isSelected ? ' is-selected' : ''}`}
      role="row"
      data-table-overview-select={table.name}
      data-table-overview-row={table.name}
      aria-selected={isSelected}
      tabIndex={-1}
      onDoubleClick={() => openTableByDefaultAction(table.name)}
      onContextMenu={(event) => openV2OverviewContextMenu(event, table)}
    >
      {columns.map((column) => renderCompactCell(table, displayName, column, formatTimestamp))}
    </div>
  );

  return renderMetadataHover(table, displayName, content);
});

TableOverviewCompactRow.displayName = 'TableOverviewCompactRow';

export default TableOverviewCompactRow;
