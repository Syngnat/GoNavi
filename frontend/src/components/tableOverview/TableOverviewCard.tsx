import React from 'react';
import { Tooltip } from 'antd';
import { TableOutlined } from '@ant-design/icons';

import { t } from '../../i18n';
import { formatRows, formatSize, type TableStatRow } from './tableOverviewModel';

export type TableOverviewCardProps = {
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

export const TableOverviewCard = React.memo(function TableOverviewCard({
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
}: TableOverviewCardProps) {
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
      className={`gn-v2-table-card${isSelected ? ' is-selected' : ''}`}
      data-table-overview-card={table.name}
      data-table-overview-select={table.name}
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
      }}
    >
      <div className="gn-v2-table-card-name" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
        <TableOutlined style={{ fontSize: 14, color: accentColor }} />
        <Tooltip title={displayName} mouseEnterDelay={0.4}>
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
        </Tooltip>
      </div>
      <Tooltip title={table.comment || undefined} mouseEnterDelay={0.4}>
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
      </Tooltip>
      {renderMetaBadges(table, false, true)}
      <div className="gn-v2-table-card-meta" style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 16, marginTop: 'auto', flexShrink: 0, fontSize: 12, color: textMuted }}>
        <span title={t('table_overview.sort.rows')} style={{ minWidth: 52, flexShrink: 0, whiteSpace: 'nowrap' }}>📊 {formatRows(table.rows)}</span>
        <span title={t('table_overview.metric.data_size')} style={{ minWidth: 72, flexShrink: 0, whiteSpace: 'nowrap' }}>💾 {formatSize(table.dataSize)}</span>
        {table.charset ? (
          <span
            data-table-overview-card-field="charset"
            title={`${t('table_overview.metric.charset')}: ${table.charset}${table.collation ? ` / ${table.collation}` : ''}`}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.7,
            }}
          >
            {table.charset}
          </span>
        ) : null}
        <span
          data-table-overview-card-field="engine"
          title={`${t('table_overview.metric.engine')}: ${table.engine || '—'}`}
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
});
