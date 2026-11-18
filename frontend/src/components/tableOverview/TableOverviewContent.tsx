import React from 'react';
import { Button, Empty } from 'antd';

import { t } from '../../i18n';
import { TABLE_OVERVIEW_RENDER_BATCH_SIZE } from '../../utils/tableOverviewFilter';
import type { TableOverviewStateApi } from './hooks/useTableOverviewState';
import type { TableOverviewTableActionsApi } from './hooks/useTableOverviewTableActions';
import type { useTableOverviewInteraction } from './hooks/useTableOverviewInteraction';
import TableOverviewRows from './TableOverviewRows';

type TableOverviewContentProps = {
  state: TableOverviewStateApi;
  actions: TableOverviewTableActionsApi;
  interaction: ReturnType<typeof useTableOverviewInteraction>;
};

const TableOverviewContent: React.FC<TableOverviewContentProps> = ({ state, actions, interaction }) => {
  const { contentRef, selection, openTableByDefaultAction } = interaction;

  return (
    <div ref={contentRef} className="gn-v2-table-overview-content" tabIndex={-1} data-view-mode={state.viewMode} style={{ flex: 1, minHeight: 0 }}>
      {state.sortedFiltered.length > 0 && (state.isSearchPending || state.visibleOverview.hiddenCount > 0 || state.deferredSearchText.trim()) && (
        <div className="gn-v2-table-overview-filter-bar" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 12, flexShrink: 0,
        }}>
          <span>{state.isSearchPending ? t('table_overview.status.updating_filter') : t('table_overview.status.matching_rendered', {
            matched: state.sortedFiltered.length, rendered: state.visibleTables.length,
          })}</span>
          {state.visibleOverview.hiddenCount > 0 && (
            <span>{t('table_overview.status.hidden_count_hint', { count: state.visibleOverview.hiddenCount })}</span>
          )}
        </div>
      )}
      {state.sortedFiltered.length === 0 ? (
        <Empty description={state.searchText ? t('table_overview.empty.no_matches') : t('table_overview.empty.no_tables')} style={{ marginTop: 80 }} />
      ) : (
        <TableOverviewRows
          sections={state.visibleTableSections}
          showSectionTitles={state.pinnedOverview.pinnedRows.length > 0}
          viewMode={state.viewMode}
          textMuted={actions.textMuted}
          textSecondary={actions.textSecondary}
          textPrimary={actions.textPrimary}
          darkMode={state.darkMode}
          openTableByDefaultAction={openTableByDefaultAction}
          openV2OverviewContextMenu={state.openV2OverviewContextMenu}
          accentColor={actions.accentColor}
          metadataDialect={state.metadataDialect}
          maxCombinedSize={actions.maxCombinedSize}
          hasKnownTableSize={actions.hasKnownTableSize}
          getCombinedTableSize={actions.getCombinedTableSize}
          sortField={state.sortField}
          toggleSort={actions.toggleSort}
          sortOrder={state.sortOrder}
          isOverviewTableSelected={selection.isSelected}
        />
      )}
      {state.sortedFiltered.length > 0 && state.visibleOverview.hiddenCount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 4px' }}>
          <Button size="small" onClick={() => state.setVisibleTableLimit((limit) => limit + TABLE_OVERVIEW_RENDER_BATCH_SIZE)}>
            {t('table_overview.action.show_more', { count: state.visibleOverview.hiddenCount })}
          </Button>
        </div>
      )}
    </div>
  );
};

export default TableOverviewContent;
