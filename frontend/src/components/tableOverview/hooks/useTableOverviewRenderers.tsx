import React, { useCallback } from 'react';
import { Tooltip } from 'antd';
import { TableOutlined, CaretUpFilled, CaretDownFilled } from '@ant-design/icons';
import {
  type OverviewTableSection,
  type TableStatRow,
  getTableOverviewDisplayName,
  formatRows,
  formatSize,
  type SortField,
} from '../tableOverviewModel';
import { t } from '../../../i18n';
import { formatSidebarTableTimestamp } from '../../sidebar/sidebarHelpers';
import type { TableOverviewTableActionsApi } from './useTableOverviewTableActions';
import type { TableOverviewStateApi } from './useTableOverviewState';

export interface UseTableOverviewRenderersInput {
  textMuted: TableOverviewTableActionsApi['textMuted'];
  textSecondary: TableOverviewTableActionsApi['textSecondary'];
  textPrimary: TableOverviewTableActionsApi['textPrimary'];
  darkMode: TableOverviewStateApi['darkMode'];
  openTableByDefaultAction: TableOverviewStateApi['openTableByDefaultAction'];
  openV2OverviewContextMenu: TableOverviewStateApi['openV2OverviewContextMenu'];
  accentColor: TableOverviewTableActionsApi['accentColor'];
  metadataDialect: TableOverviewStateApi['metadataDialect'];
  maxCombinedSize: TableOverviewTableActionsApi['maxCombinedSize'];
  hasKnownTableSize: TableOverviewTableActionsApi['hasKnownTableSize'];
  getCombinedTableSize: TableOverviewTableActionsApi['getCombinedTableSize'];
  sortField: TableOverviewStateApi['sortField'];
  toggleSort: TableOverviewTableActionsApi['toggleSort'];
  sortOrder: TableOverviewStateApi['sortOrder'];
}

export const useTableOverviewRenderers = ({
  textMuted, textSecondary, textPrimary, darkMode, openTableByDefaultAction,
  openV2OverviewContextMenu, accentColor, metadataDialect, maxCombinedSize, hasKnownTableSize,
  getCombinedTableSize, sortField, toggleSort, sortOrder,
}: UseTableOverviewRenderersInput) => {
  const renderOverviewSectionTitle = (section: OverviewTableSection) => {
      const sectionTitle = section.kind === 'pinned'
          ? t('table_overview.section.pinned')
          : t('table_overview.section.all');

      return (
          <div
              className={'gn-v2-table-overview-section-title'}
              data-overview-table-section={section.kind}
              style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: section.kind === 'pinned' ? '0 0 8px' : '14px 0 8px',
                  color: textMuted,
                  fontSize: 12,
                  fontWeight: 600,
              }}
          >
              <span>{sectionTitle}</span>
              <span>{section.rows.length}</span>
          </div>
      );
  };

  const formatOverviewTimestamp = useCallback((value?: string): string => {
      if (!value) return '';
      return formatSidebarTableTimestamp(value) || value;
  }, []);

  const renderTableOverviewMetaBadges = useCallback((
      table: TableStatRow,
      compact = false,
      reserveMissing = false,
  ) => {
      const metadataItems = [
          {
              key: 'updated',
              label: t('table_overview.metric.updated_at'),
              raw: table.updateTime,
              value: table.updateTime ? formatOverviewTimestamp(table.updateTime) : '—',
          },
          {
              key: 'created',
              label: t('table_overview.metric.created_at'),
              raw: table.createTime,
              value: table.createTime ? formatOverviewTimestamp(table.createTime) : '—',
          },
      ];
      const items = reserveMissing ? metadataItems : metadataItems.filter((item) => item.raw);
      if (items.length === 0) return null;
      return (
          <div
              className={reserveMissing ? 'gn-v2-table-card-timestamps' : undefined}
              style={{
                  display: 'flex',
                  flexDirection: reserveMissing ? 'column' : 'row',
                  flexWrap: reserveMissing ? 'nowrap' : 'wrap',
                  alignItems: reserveMissing ? 'flex-start' : undefined,
                  gap: reserveMissing ? 4 : 8,
                  minHeight: reserveMissing ? 48 : undefined,
                  flexShrink: reserveMissing ? 0 : undefined,
                  marginTop: compact ? 8 : 0,
                  marginBottom: compact ? 0 : 10,
              }}
          >
              {items.map((item) => (
                  <Tooltip
                      key={item.key}
                      title={item.raw ? `${item.label}: ${item.raw}` : undefined}
                      mouseEnterDelay={0.4}
                  >
                      <span
                          data-table-overview-card-field={item.key}
                          style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              maxWidth: '100%',
                              padding: compact ? '1px 7px' : '2px 8px',
                              borderRadius: 999,
                              background: 'var(--gn-bg-active)',
                              color: textSecondary,
                              fontSize: compact ? 10 : 11,
                              lineHeight: compact ? '16px' : '18px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                          }}
                      >
                          <span style={{ opacity: 0.72 }}>{item.label}</span>
                          <span style={{ color: textPrimary, fontVariantNumeric: 'tabular-nums' }}>{item.value}</span>
                      </span>
                  </Tooltip>
              ))}
          </div>
      );
  }, [darkMode, formatOverviewTimestamp, t, textPrimary, textSecondary]);

  const renderCardTableContent = (table: TableStatRow) => (
      <div
          className="gn-v2-table-card"
          data-table-overview-card={table.name}
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
              <Tooltip title={getTableOverviewDisplayName(metadataDialect, table.name)} mouseEnterDelay={0.4}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, display: 'block' }}>
                      {getTableOverviewDisplayName(metadataDialect, table.name)}
                  </span>
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
          {renderTableOverviewMetaBadges(table, false, true)}
          <div className="gn-v2-table-card-meta" style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 16, marginTop: 'auto', flexShrink: 0, fontSize: 12, color: textMuted }}>
              <span title={t('table_overview.sort.rows')} style={{ minWidth: 52, flexShrink: 0, whiteSpace: 'nowrap' }}>📊 {formatRows(table.rows)}</span>
              <span title={t('table_overview.metric.data_size')} style={{ minWidth: 72, flexShrink: 0, whiteSpace: 'nowrap' }}>💾 {formatSize(table.dataSize)}</span>
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
                  <span style={{ width: `${Math.min(100, Math.max(4, maxCombinedSize > 0 && hasKnownTableSize(table) ? Math.round((getCombinedTableSize(table) / maxCombinedSize) * 100) : 4))}%` }} />
          </div>
      </div>
  );

  const renderCardTable = (table: TableStatRow) => (
      <React.Fragment key={table.name}>{renderCardTableContent(table)}</React.Fragment>
  );

  const renderListTable = (table: TableStatRow) => {
      const combinedSize = getCombinedTableSize(table);
      const displayName = getTableOverviewDisplayName(metadataDialect, table.name);
      const sizeRatio = maxCombinedSize > 0 && hasKnownTableSize(table) ? combinedSize / maxCombinedSize : 0;
      const fillWidth = maxCombinedSize > 0 && hasKnownTableSize(table) ? `${Math.max(10, Math.round(sizeRatio * 100))}%` : '0%';
      const fillColor = 'var(--gn-accent-soft, rgba(34, 197, 94, 0.16))';
      const rowSecondary = table.comment || (table.engine
          ? t('table_overview.row.engine_table', { engine: table.engine })
          : t('table_overview.row.open_hint'));

      const content = (
              <div
                  className="gn-v2-table-row"
                  onDoubleClick={() => openTableByDefaultAction(table.name)}
                  onContextMenu={(event) => openV2OverviewContextMenu(event, table)}
                  style={{
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      userSelect: 'none',
                  }}
              >
                  <div
                      style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          bottom: 0,
                          width: fillWidth,
                          background: fillColor,
                          pointerEvents: 'none',
                          transition: 'width 0.2s ease',
                      }}
                  />
                  <div
                      style={{
                          position: 'relative',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 16,
                          padding: '14px 16px',
                          flexWrap: 'wrap',
                      }}
                  >
                      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                              <TableOutlined style={{ fontSize: 13, color: accentColor, flexShrink: 0 }} />
                              <Tooltip title={displayName} mouseEnterDelay={0.4}>
                                  <span style={{ color: textPrimary, fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {displayName}
                                  </span>
                              </Tooltip>
                              {table.engine && (
                                  <span
                                      style={{
                                          flexShrink: 0,
                                          padding: '1px 6px',
                                          borderRadius: 999,
                                          fontSize: 11,
                                          color: textMuted,
                                          background: 'var(--gn-bg-active)',
                                      }}
                                  >
                                      {table.engine}
                                  </span>
                              )}
                          </div>
                          <Tooltip title={rowSecondary} mouseEnterDelay={0.4}>
                              <div style={{ marginTop: 6, color: textSecondary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {rowSecondary}
                              </div>
                          </Tooltip>
                          {renderTableOverviewMetaBadges(table, true)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
                          <div style={{ minWidth: 96, textAlign: 'right' }}>
                              <div style={{ color: textMuted }}>{t('table_overview.sort.rows')}</div>
                              <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatRows(table.rows)}</div>
                          </div>
                          <div style={{ minWidth: 110, textAlign: 'right' }}>
                              <div style={{ color: textMuted }}>{t('table_overview.metric.data_size')}</div>
                              <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatSize(table.dataSize)}</div>
                          </div>
                          <div style={{ minWidth: 110, textAlign: 'right' }}>
                              <div style={{ color: textMuted }}>{t('table_overview.metric.index_size')}</div>
                              <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatSize(table.indexSize)}</div>
                          </div>
                          <div style={{ minWidth: 96, textAlign: 'right' }}>
                              <div style={{ color: textMuted }}>{t('table_overview.metric.relative_size')}</div>
                              <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                  {maxCombinedSize > 0 && hasKnownTableSize(table) ? `${Math.round(sizeRatio * 100)}%` : '—'}
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
      );

      return <React.Fragment key={table.name}>{content}</React.Fragment>;
  };

  const renderCompactSortHeader = (
      field: SortField,
      labelKey: string,
      align: 'left' | 'right' = 'left',
  ) => {
      const active = sortField === field;
      return (
          <button
              type="button"
              className="gn-table-overview-compact-sort-button"
              data-table-overview-sort={field}
              aria-pressed={active}
              onClick={() => toggleSort(field)}
              style={{
                  width: '100%',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
                  gap: 5,
                  padding: '0 10px',
                  border: 0,
                  background: 'transparent',
                  color: active ? accentColor : textSecondary,
                  cursor: 'pointer',
                  font: 'inherit',
                  fontWeight: active ? 700 : 600,
                  textAlign: align,
              }}
          >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(labelKey)}
              </span>
              {active && (sortOrder === 'asc'
                  ? <CaretUpFilled aria-hidden="true" />
                  : <CaretDownFilled aria-hidden="true" />)}
          </button>
      );
  };

  const renderCompactTableHeader = () => (
      <div className="gn-table-overview-compact-header" role="row">
          <div role="columnheader" aria-sort={sortField === 'name' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('name', 'table_overview.sort.name')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'comment' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('comment', 'table_overview.metric.comment')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'rows' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('rows', 'table_overview.sort.rows', 'right')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'dataSize' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('dataSize', 'table_overview.metric.data_size', 'right')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'indexSize' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('indexSize', 'table_overview.metric.index_size', 'right')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'engine' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('engine', 'table_overview.metric.engine')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'updateTime' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('updateTime', 'table_overview.metric.updated_at')}
          </div>
          <div role="columnheader" aria-sort={sortField === 'createTime' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {renderCompactSortHeader('createTime', 'table_overview.metric.created_at')}
          </div>
      </div>
  );

  const renderCompactTableRow = (table: TableStatRow) => {
      const displayName = getTableOverviewDisplayName(metadataDialect, table.name);
      const content = (
          <div
              className="gn-table-overview-compact-row"
              role="row"
              data-table-overview-row={table.name}
              onDoubleClick={() => openTableByDefaultAction(table.name)}
              onContextMenu={(event) => openV2OverviewContextMenu(event, table)}
              style={{
                  display: 'grid',
                  alignItems: 'center',
                  minWidth: 1120,
                  minHeight: 32,
                  ...({
                      cursor: 'pointer',
                      userSelect: 'none',
                  }),
              }}
          >
              <div className="gn-table-overview-compact-name" role="cell" title={displayName}>
                  <TableOutlined aria-hidden="true" />
                  <span>{displayName}</span>
              </div>
              <div className="gn-table-overview-compact-cell" role="cell" title={table.comment || undefined}>{table.comment || '—'}</div>
              <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.rows >= 0 ? String(table.rows) : undefined}>{formatRows(table.rows)}</div>
              <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.dataSize >= 0 ? String(table.dataSize) : undefined}>{formatSize(table.dataSize)}</div>
              <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.indexSize >= 0 ? String(table.indexSize) : undefined}>{formatSize(table.indexSize)}</div>
              <div className="gn-table-overview-compact-cell" role="cell" title={table.engine || undefined}>{table.engine || '—'}</div>
              <div
                  className="gn-table-overview-compact-cell"
                  role="cell"
                  title={table.updateTime || undefined}
              >
                  {table.updateTime ? formatOverviewTimestamp(table.updateTime) : '—'}
              </div>
              <div
                  className="gn-table-overview-compact-cell"
                  role="cell"
                  title={table.createTime || undefined}
              >
                  {table.createTime ? formatOverviewTimestamp(table.createTime) : '—'}
              </div>
          </div>
      );

      return <React.Fragment key={table.name}>{content}</React.Fragment>;
  };
  return {
    renderOverviewSectionTitle, renderCardTable, renderListTable, renderCompactTableHeader,
    renderCompactTableRow,
  };
};

export type TableOverviewRenderersApi = ReturnType<typeof useTableOverviewRenderers>;
