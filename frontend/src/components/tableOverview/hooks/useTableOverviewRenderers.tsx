import React, { useCallback } from 'react';
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
import { TableOverviewCard } from '../TableOverviewCard';
import { MetadataHoverCard, MetadataHoverTooltip } from '../../common/MetadataHoverCard';
import {
  resolveTableOverviewCompactColumnDefinitions,
  type TableOverviewCompactColumnDefinition,
} from '../tableOverviewCompactColumns';
import {
  DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
  TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX,
  type TableOverviewCompactColumn,
  type TableOverviewCompactColumnWidths,
} from '../../../utils/tableOverviewCompactColumns';
import { buildTableOverviewHoverModel } from '../tableOverviewMetadata';

const renderTableOverviewName = (
  _table: TableStatRow,
  displayName: string,
  style?: React.CSSProperties,
) => <span style={style} title={displayName}>{displayName}</span>;

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
  compactColumns?: TableOverviewCompactColumn[];
  compactColumnWidths?: TableOverviewCompactColumnWidths;
  onCompactColumnResizeStart?: (
    key: TableOverviewCompactColumn,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onCompactColumnResizeKeyDown?: (
    key: TableOverviewCompactColumn,
    event: React.KeyboardEvent<HTMLElement>,
  ) => void;
  onCompactColumnAutoFit?: (
    key: TableOverviewCompactColumn,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  connectionName?: string;
  hostSummary?: string;
  dbName?: string;
  schemaName?: string;
  /** 行是否处于选中态（卡片 / 列表 / 紧凑表三种视图共用）。 */
  isOverviewTableSelected: (name: string) => boolean;
}

export const useTableOverviewRenderers = ({
  textMuted, textSecondary, textPrimary, darkMode, openTableByDefaultAction,
  openV2OverviewContextMenu, accentColor, metadataDialect, maxCombinedSize, hasKnownTableSize,
  getCombinedTableSize, sortField, toggleSort, sortOrder, isOverviewTableSelected,
  compactColumns, compactColumnWidths, onCompactColumnResizeStart,
  onCompactColumnResizeKeyDown, onCompactColumnAutoFit,
  connectionName, hostSummary, dbName, schemaName,
}: UseTableOverviewRenderersInput) => {
  // 三种视图的行都带同一个选中标记，拖选 / Shift 区间只按它解析，不区分视图。
  // tabIndex=-1 让点击后行可聚焦，键盘交互以当前焦点行判定。
  const overviewRowProps = (name: string) => ({
      'data-table-overview-select': name,
      'aria-selected': isOverviewTableSelected(name),
      tabIndex: -1,
  });
  const selectedClass = (name: string) => (isOverviewTableSelected(name) ? ' is-selected' : '');

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
  const resolvedCompactColumns = React.useMemo(
      () => compactColumns ?? DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
      [compactColumns],
  );
  const compactColumnDefinitions = React.useMemo(
      () => resolveTableOverviewCompactColumnDefinitions(resolvedCompactColumns),
      [resolvedCompactColumns],
  );
  const renderMetadataHover = useCallback((
      table: TableStatRow,
      displayName: string,
      child: React.ReactElement,
  ) => {
      return (
          <MetadataHoverTooltip
              content={() => {
                  const hoverModel = buildTableOverviewHoverModel({
                      table,
                      displayName,
                      connectionName,
                      hostSummary,
                      dbName,
                      schemaName,
                  });
                  return (
                      <MetadataHoverCard
                          badge={hoverModel.badge}
                          title={hoverModel.title}
                          rows={hoverModel.rows}
                          dataKind={hoverModel.dataKind}
                      />
                  );
              }}
              mouseEnterDelay={0.8}
              rootClassName="gn-v2-tab-hover-tooltip gn-v2-table-overview-hover-tooltip"
          >
              {child}
          </MetadataHoverTooltip>
      );
  }, [connectionName, dbName, hostSummary, schemaName]);

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
                  <span
                      key={item.key}
                      data-table-overview-card-field={item.key}
                      aria-label={`${item.label}: ${item.raw || item.value}`}
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
              ))}
          </div>
      );
  }, [darkMode, formatOverviewTimestamp, t, textPrimary, textSecondary]);

  const renderCardTable = (table: TableStatRow) => {
      const displayName = getTableOverviewDisplayName(metadataDialect, table.name);
      return (
          <React.Fragment key={table.name}>
              {renderMetadataHover(
                  table,
                  displayName,
                  <TableOverviewCard
                      table={table}
                      displayName={displayName}
                      isSelected={isOverviewTableSelected(table.name)}
                      accentColor={accentColor}
                      textPrimary={textPrimary}
                      textSecondary={textSecondary}
                      textMuted={textMuted}
                      maxCombinedSize={maxCombinedSize}
                      hasKnownTableSize={hasKnownTableSize}
                      getCombinedTableSize={getCombinedTableSize}
                      openTableByDefaultAction={openTableByDefaultAction}
                      openV2OverviewContextMenu={openV2OverviewContextMenu}
                      renderNameNode={renderTableOverviewName}
                      renderMetaBadges={renderTableOverviewMetaBadges}
                  />,
              )}
          </React.Fragment>
      );
  };

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
                  className={`gn-v2-table-row${selectedClass(table.name)}`}
                  {...overviewRowProps(table.name)}
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
                              {renderTableOverviewName(table, displayName, { color: textPrimary, fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}
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
                          <div style={{ marginTop: 6, color: textSecondary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {rowSecondary}
                          </div>
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

      return (
          <React.Fragment key={table.name}>
              {renderMetadataHover(table, displayName, content)}
          </React.Fragment>
      );
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

  const renderCompactColumnHeader = (column: TableOverviewCompactColumnDefinition) => {
      const sortState = sortField === column.sortField
          ? (sortOrder === 'asc' ? 'ascending' : 'descending')
          : 'none';
      const requestedWidth = compactColumnWidths?.[column.key];
      return (
          <div
              key={column.key}
              className="gn-table-overview-compact-column-header"
              role="columnheader"
              aria-sort={column.sortField ? sortState : undefined}
          >
              {column.sortField
                  ? renderCompactSortHeader(column.sortField, column.labelKey, column.align)
                  : <span className="gn-table-overview-compact-plain-header">{t(column.labelKey)}</span>}
              {onCompactColumnResizeStart && (
                  <span
                      className="gn-table-overview-compact-column-resizer"
                      data-table-overview-column-resizer={column.key}
                      role="separator"
                      aria-label={t('data_grid.column.resize_tooltip')}
                      aria-orientation="vertical"
                      aria-valuemin={column.minWidth}
                      aria-valuemax={TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX}
                      aria-valuenow={Math.round(
                          Math.max(
                              column.minWidth,
                              Number.isFinite(requestedWidth) ? requestedWidth as number : column.minWidth,
                          ),
                      )}
                      tabIndex={0}
                      title={t('data_grid.column.resize_tooltip')}
                      onPointerDown={(event) => onCompactColumnResizeStart(column.key, event)}
                      onDoubleClick={(event) => onCompactColumnAutoFit?.(column.key, event)}
                      onKeyDown={(event) => onCompactColumnResizeKeyDown?.(column.key, event)}
                      onClick={(event) => event.stopPropagation()}
                  />
              )}
          </div>
      );
  };

  const renderCompactTableHeader = () => (
      <div className="gn-table-overview-compact-header" role="row">
          {compactColumnDefinitions.map(renderCompactColumnHeader)}
      </div>
  );

  const renderCompactCell = (
      table: TableStatRow,
      displayName: string,
      column: TableOverviewCompactColumnDefinition,
  ) => {
      if (column.key === 'name') {
          return (
              <div key={column.key} className="gn-table-overview-compact-name" role="cell">
                  <TableOutlined aria-hidden="true" />
                  {renderTableOverviewName(table, displayName)}
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
              text = table.updateTime ? formatOverviewTimestamp(table.updateTime) : '—';
              break;
          case 'createTime':
              text = table.createTime ? formatOverviewTimestamp(table.createTime) : '—';
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

  const renderCompactTableRow = (table: TableStatRow) => {
      const displayName = getTableOverviewDisplayName(metadataDialect, table.name);
      const content = (
          <div
              className={`gn-table-overview-compact-row${selectedClass(table.name)}`}
              role="row"
              data-table-overview-row={table.name}
              {...overviewRowProps(table.name)}
              onDoubleClick={() => openTableByDefaultAction(table.name)}
              onContextMenu={(event) => openV2OverviewContextMenu(event, table)}
              style={{
                  display: 'grid',
                  alignItems: 'center',
                  minHeight: 32,
                  ...({
                      cursor: 'pointer',
                      userSelect: 'none',
                  }),
              }}
          >
              {compactColumnDefinitions.map((column) => renderCompactCell(table, displayName, column))}
          </div>
      );

      return (
          <React.Fragment key={table.name}>
              {renderMetadataHover(table, displayName, content)}
          </React.Fragment>
      );
  };
  return {
    renderOverviewSectionTitle, renderCardTable, renderListTable, renderCompactTableHeader,
    renderCompactTableRow,
  };
};

export type TableOverviewRenderersApi = ReturnType<typeof useTableOverviewRenderers>;
