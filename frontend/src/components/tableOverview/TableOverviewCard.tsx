import React from 'react';
import { TableOutlined } from '@ant-design/icons';

import { formatRows, formatSize, type TableStatRow } from './tableOverviewModel';

export type TableOverviewCardProps = React.HTMLAttributes<HTMLDivElement> & {
  table: TableStatRow;
  displayName: string;
  isSelected: boolean;
  accentColor: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  maxCombinedSize: number;
  hasKnownTableSize: (table: TableStatRow) => boolean;
  getCombinedTableSize: (table: TableStatRow) => number;
  openTableByDefaultAction: (tableName: string) => void;
  openV2OverviewContextMenu: (event: React.MouseEvent, table: TableStatRow) => void;
  renderNameNode: (
    table: TableStatRow,
    displayName: string,
    style?: React.CSSProperties,
  ) => React.ReactNode;
  renderMetaBadges: (
    table: TableStatRow,
    compact?: boolean,
    reserveMissing?: boolean,
  ) => React.ReactNode;
};

export const TableOverviewCard = React.memo(React.forwardRef<HTMLDivElement, TableOverviewCardProps>(
function TableOverviewCard({
    table,
    displayName,
    isSelected,
    accentColor,
    textPrimary,
    textSecondary,
    textMuted,
    maxCombinedSize,
    hasKnownTableSize,
    getCombinedTableSize,
    openTableByDefaultAction,
    openV2OverviewContextMenu,
    renderNameNode,
    renderMetaBadges,
    className: extraClassName,
    style: extraStyle,
    ...triggerProps
  }, ref) {
  const sizePercent = Math.min(
    100,
    Math.max(
      4,
      maxCombinedSize > 0 && hasKnownTableSize(table)
        ? Math.round((getCombinedTableSize(table) / maxCombinedSize) * 100)
        : 4,
    ),
  );

  return (
    <div
      ref={ref}
      className={`gn-v2-table-card${isSelected ? ' is-selected' : ''}${extraClassName ? ` ${extraClassName}` : ''}`}
      data-table-overview-card={table.name}
      data-table-overview-select={table.name}
      {...triggerProps}
      aria-selected={isSelected}
      tabIndex={-1}
      onDoubleClick={() => openTableByDefaultAction(table.name)}
      onContextMenu={(event) => openV2OverviewContextMenu(event, table)}
      style={{
        borderRadius: 10,
        padding: '14px 16px',
        height: '100%',
        minHeight: 0,
        maxHeight: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        userSelect: 'none',
        ...extraStyle,
      }}
    >
      <div className="gn-v2-table-card-name" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
        <TableOutlined style={{ fontSize: 14, color: accentColor }} />
        {renderNameNode(table, displayName, {
          fontSize: 13,
          fontWeight: 600,
          color: textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          display: 'block',
        })}
      </div>
      <div
        className="gn-v2-table-card-comment"
        data-table-overview-card-field="comment"
        style={{
          minHeight: 19,
          flexShrink: 0,
          fontSize: 12,
          color: textSecondary,
          marginBottom: 10,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {table.comment || '—'}
      </div>
      {renderMetaBadges(table, false, true)}
      <div className="gn-v2-table-card-meta" style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 16, marginTop: 'auto', flexShrink: 0, fontSize: 12, color: textMuted }}>
        <span style={{ minWidth: 52, flexShrink: 0, whiteSpace: 'nowrap' }}>📊 {formatRows(table.rows)}</span>
        <span style={{ minWidth: 72, flexShrink: 0, whiteSpace: 'nowrap' }}>💾 {formatSize(table.dataSize)}</span>
        {table.charset ? (
          <span
            data-table-overview-card-field="charset"
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.7,
            }}
          >
            {table.charset}{table.collation ? ` / ${table.collation}` : ''}
          </span>
        ) : null}
        <span
          data-table-overview-card-field="engine"
          style={{
            marginLeft: 'auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.7,
          }}
        >
          {table.engine || '—'}
        </span>
      </div>
      <div className="gn-v2-table-size-bar">
        <span style={{ width: `${sizePercent}%` }} />
      </div>
    </div>
  );
}));

TableOverviewCard.displayName = 'TableOverviewCard';
