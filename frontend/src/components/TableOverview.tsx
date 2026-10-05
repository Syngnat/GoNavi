import React from 'react';
import { createPortal } from 'react-dom';
import { Input, Spin, Empty, Dropdown, Tooltip, Button } from 'antd';
import {
  TableOutlined, SearchOutlined, ReloadOutlined, SortAscendingOutlined, DatabaseOutlined,
  AppstoreOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import type { TabData } from '../types';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { TABLE_OVERVIEW_RENDER_BATCH_SIZE } from '../utils/tableOverviewFilter';
import { t } from '../i18n';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import {
  type ViewMode,
  OVERVIEW_CONTEXT_MENU_WIDTH,
  TABLE_OVERVIEW_CARD_HEIGHT,
} from './tableOverview/tableOverviewModel';
import { useTableOverviewState } from './tableOverview/hooks/useTableOverviewState';
import { useTableOverviewTableActions } from './tableOverview/hooks/useTableOverviewTableActions';
import { useTableOverviewRenderers } from './tableOverview/hooks/useTableOverviewRenderers';

export interface TableOverviewProps {
    tab: TabData;
}

const TableOverview: React.FC<TableOverviewProps> = ({ tab }) => {
    const {
      addTab, setAIPanelVisible, addAIContext, pinnedSidebarTables, setSidebarTablePinned, darkMode,
      activeShortcutPlatform, tables, loading, searchText, setSearchText, sortField, setSortField,
      sortOrder, setSortOrder, viewMode, setViewMode, v2ContextMenu, setV2ContextMenu,
      v2ContextMenuPortalRef, setVisibleTableLimit, deferredSearchText, isSearchPending, connection,
      metadataDialect, schemaName, overviewSchemaName, supportsCopyTable, allowClear, loadData,
      sortedFiltered, pinnedOverview, visibleOverview, visibleTables, visibleTableSections,
      v2ContextMenuTable, openV2OverviewContextMenu, openTable, openDesign,
      openTableByDefaultAction, openTableDdl, openQueryForTable, openTableInER, buildConfig,
      handleCopyStructure, handleCopyTableName, handleCopyTable,
    } = useTableOverviewState({ tab });

    const {
      textPrimary, textSecondary, textMuted, accentColor, containerBg, toggleSort, sortMenuItems,
      hasKnownTableSize, getCombinedTableSize, maxCombinedSize, renderToolbarSummary,
      renderV2OverviewTableContextMenu,
    } = useTableOverviewTableActions({
      tab, addTab, schemaName, buildConfig, connection, loadData, allowClear, pinnedSidebarTables,
      setSidebarTablePinned, addAIContext, setAIPanelVisible, sortField, setSortField, setSortOrder,
      sortOrder, tables, sortedFiltered, openTable, openDesign, openQueryForTable, openTableDdl,
      openTableInER, handleCopyTableName, handleCopyStructure, handleCopyTable,
      activeShortcutPlatform, supportsCopyTable, metadataDialect, setV2ContextMenu,
    });

    const {
      renderOverviewSectionTitle, renderCardTable, renderListTable, renderCompactTableHeader,
      renderCompactTableRow,
    } = useTableOverviewRenderers({
      textMuted, textSecondary, textPrimary, darkMode, openTableByDefaultAction,
      openV2OverviewContextMenu, accentColor, metadataDialect, maxCombinedSize, hasKnownTableSize,
      getCombinedTableSize, sortField, toggleSort, sortOrder,
    });

    if (loading) {
        return (
            <div className="gn-table-overview gn-v2-table-overview gn-v2-table-overview-loading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: containerBg }}>
                <Spin size="large" tip={t('table_overview.status.loading_tables')} />
            </div>
        );
    }

    const viewSwitchBtnClass = (mode: ViewMode) => (
        `gn-v2-table-overview-view-switch-btn${viewMode === mode ? ' is-active' : ''}`
    );

    return (
        <div className="gn-table-overview gn-v2-table-overview" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: containerBg, overflow: 'hidden' }}>
            {/* Toolbar */}
            <div className="gn-table-overview-header gn-v2-table-overview-header" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', flexShrink: 0 }}>
                <span className="gn-v2-table-overview-icon">
                    <DatabaseOutlined style={{ fontSize: 16 }} />
                </span>
                <span className={'gn-v2-table-overview-title'} style={{ fontSize: 14, fontWeight: 600, color: textPrimary }}>
                    {[tab.dbName, overviewSchemaName].filter(Boolean).join(' · ')}
                </span>
                <span className={'gn-table-overview-summary gn-v2-table-overview-summary'} style={{ fontSize: 12, color: textMuted }}>
                    {renderToolbarSummary()}
                </span>
                <div style={{ flex: 1 }} />
                <Input
                    {...noAutoCapInputProps}
                    placeholder={t('table_overview.placeholder.search')}
                    prefix={<SearchOutlined style={{ color: textMuted }} />}
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    allowClear
                    style={{ width: 240 }}
                    size="small"
                />
                <Dropdown menu={{ items: sortMenuItems }} trigger={['click']}>
                    <Tooltip title={t('table_overview.tooltip.sort')}><SortAscendingOutlined style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
                </Dropdown>
                <div
                    className="gn-v2-table-overview-view-switch"
                >
                    <Tooltip title={t('table_overview.tooltip.card_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('card')}
                            data-table-overview-view-mode="card"
                            aria-label={t('table_overview.tooltip.card_view')}
                            aria-pressed={viewMode === 'card'}
                            onClick={() => setViewMode('card')}
                        >
                            <AppstoreOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                    <Tooltip title={t('table_overview.tooltip.list_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('list')}
                            data-table-overview-view-mode="list"
                            aria-label={t('table_overview.tooltip.list_view')}
                            aria-pressed={viewMode === 'list'}
                            onClick={() => setViewMode('list')}
                        >
                            <UnorderedListOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                    <Tooltip title={t('table_overview.tooltip.table_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('table')}
                            data-table-overview-view-mode="table"
                            aria-label={t('table_overview.tooltip.table_view')}
                            aria-pressed={viewMode === 'table'}
                            onClick={() => setViewMode('table')}
                        >
                            <TableOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                </div>
                <Tooltip title={t('table_overview.tooltip.refresh')}><ReloadOutlined onClick={loadData} style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
            </div>

            {/* Content Area */}
            <div
                className={'gn-v2-table-overview-content'}
                data-view-mode={viewMode}
                style={{
                    flex: 1,
                    minHeight: 0,
                }}
            >
                {sortedFiltered.length > 0 && (isSearchPending || visibleOverview.hiddenCount > 0 || deferredSearchText.trim()) && (
                    <div
                        className={'gn-v2-table-overview-filter-bar'}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            fontSize: 12,
                            flexShrink: 0,
                        }}
                    >
                        <span>
                            {isSearchPending
                                ? t('table_overview.status.updating_filter')
                                : t('table_overview.status.matching_rendered', {
                                    matched: sortedFiltered.length,
                                    rendered: visibleTables.length,
                                })}
                        </span>
                        {visibleOverview.hiddenCount > 0 && (
                            <span>{t('table_overview.status.hidden_count_hint', { count: visibleOverview.hiddenCount })}</span>
                        )}
                    </div>
                )}
                {sortedFiltered.length === 0 ? (
                    <Empty description={searchText ? t('table_overview.empty.no_matches') : t('table_overview.empty.no_tables')} style={{ marginTop: 80 }} />
                ) : (
                    viewMode === 'table' ? (
                        <div
                            className="gn-table-overview-compact-scroll"
                            role="table"
                            aria-label={t('table_overview.tooltip.table_view')}
                        >
                            {renderCompactTableHeader()}
                            {visibleTableSections.map((section) => (
                                <React.Fragment key={section.key}>
                                    {pinnedOverview.pinnedRows.length > 0 && (
                                        <div className="gn-table-overview-compact-section">
                                            {renderOverviewSectionTitle(section)}
                                        </div>
                                    )}
                                    {section.rows.map(renderCompactTableRow)}
                                </React.Fragment>
                            ))}
                        </div>
                    ) : (
                    <div className={'gn-v2-table-overview-sections'}>
                        {visibleTableSections.map((section) => (
                            <section key={section.key} className={'gn-v2-table-overview-section'}>
                                {pinnedOverview.pinnedRows.length > 0 && renderOverviewSectionTitle(section)}
                                {viewMode === 'card' ? (
                                    <div className={'gn-v2-table-card-grid'} style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                                        gridAutoRows: TABLE_OVERVIEW_CARD_HEIGHT,
                                        gap: 12,
                                    }}>
                                        {section.rows.map(renderCardTable)}
                                    </div>
                                ) : (
                                    <div
                                        className={'gn-v2-table-row-list'}
                                        style={{ display: 'flex', flexDirection: 'column', gap: 0 }}
                                    >
                                        {section.rows.map(renderListTable)}
                                    </div>
                                )}
                            </section>
                        ))}
                    </div>
                    )
                )}
                {sortedFiltered.length > 0 && visibleOverview.hiddenCount > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 4px' }}>
                        <Button
                            size="small"
                            onClick={() => setVisibleTableLimit(limit => limit + TABLE_OVERVIEW_RENDER_BATCH_SIZE)}
                        >
                            {t('table_overview.action.show_more', { count: visibleOverview.hiddenCount })}
                        </Button>
                    </div>
                )}
            </div>
            {v2ContextMenu && v2ContextMenuTable && typeof document !== 'undefined' && createPortal(
                <div
                    ref={v2ContextMenuPortalRef}
                    className="gn-v2-table-overview-context-menu-portal gn-v2-table-context-menu-popup"
                    data-gonavi-close-shortcut-guard="true"
                    data-gonavi-close-shortcut-blocks-background="true"
                    style={{
                        position: 'fixed',
                        left: v2ContextMenu.x,
                        top: v2ContextMenu.y,
                        zIndex: APP_POPUP_Z_INDEX,
                        width: OVERVIEW_CONTEXT_MENU_WIDTH,
                        maxWidth: 'calc(100vw - 24px)',
                        ['--gn-v2-context-menu-max-height' as any]: `${v2ContextMenu.maxHeight}px`,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {renderV2OverviewTableContextMenu(v2ContextMenuTable)}
                </div>,
                document.body,
            )}
        </div>
    );
};

export default TableOverview;
