import React from 'react';
import { Input, Dropdown, Tooltip } from 'antd';
import {
  TableOutlined, SearchOutlined, ReloadOutlined, SortAscendingOutlined, DatabaseOutlined,
  AppstoreOutlined, UnorderedListOutlined,
} from '@ant-design/icons';

import { t } from '../../i18n';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import type { TabData } from '../../types';
import type { ViewMode } from './tableOverviewModel';
import type { TableOverviewStateApi } from './hooks/useTableOverviewState';
import type { TableOverviewTableActionsApi } from './hooks/useTableOverviewTableActions';

type TableOverviewToolbarProps = {
  tab: TabData;
  state: TableOverviewStateApi;
  actions: TableOverviewTableActionsApi;
};

const TableOverviewToolbar: React.FC<TableOverviewToolbarProps> = ({ tab, state, actions }) => {
  const viewSwitchClass = (mode: ViewMode) => (
    `gn-v2-table-overview-view-switch-btn${state.viewMode === mode ? ' is-active' : ''}`
  );

  return (
    <div className="gn-table-overview-header gn-v2-table-overview-header" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', flexShrink: 0 }}>
      <span className="gn-v2-table-overview-icon"><DatabaseOutlined style={{ fontSize: 16 }} /></span>
      <span className="gn-v2-table-overview-title" style={{ fontSize: 14, fontWeight: 600, color: actions.textPrimary }}>
        {[tab.dbName, state.overviewSchemaName].filter(Boolean).join(' · ')}
      </span>
      <span className="gn-table-overview-summary gn-v2-table-overview-summary" style={{ fontSize: 12, color: actions.textMuted }}>
        {actions.renderToolbarSummary()}
      </span>
      <div style={{ flex: 1 }} />
      <Input
        {...noAutoCapInputProps}
        placeholder={t('table_overview.placeholder.search')}
        aria-label={t('table_overview.placeholder.search')}
        prefix={<SearchOutlined style={{ color: actions.textMuted }} />}
        value={state.searchText}
        onChange={(event) => state.setSearchText(event.target.value)}
        allowClear
        style={{ width: 240 }}
        size="small"
      />
      <Dropdown menu={{ items: actions.sortMenuItems }} trigger={['click']}>
        <Tooltip title={t('table_overview.tooltip.sort')}>
          <SortAscendingOutlined style={{ fontSize: 16, color: actions.textSecondary, cursor: 'pointer' }} />
        </Tooltip>
      </Dropdown>
      <div className="gn-v2-table-overview-view-switch">
        <Tooltip title={t('table_overview.tooltip.card_view')}>
          <button type="button" className={viewSwitchClass('card')} data-table-overview-view-mode="card"
            aria-label={t('table_overview.tooltip.card_view')} aria-pressed={state.viewMode === 'card'}
            onClick={() => state.setViewMode('card')}>
            <AppstoreOutlined style={{ fontSize: 14 }} />
          </button>
        </Tooltip>
        <Tooltip title={t('table_overview.tooltip.list_view')}>
          <button type="button" className={viewSwitchClass('list')} data-table-overview-view-mode="list"
            aria-label={t('table_overview.tooltip.list_view')} aria-pressed={state.viewMode === 'list'}
            onClick={() => state.setViewMode('list')}>
            <UnorderedListOutlined style={{ fontSize: 14 }} />
          </button>
        </Tooltip>
        <Tooltip title={t('table_overview.tooltip.table_view')}>
          <button type="button" className={viewSwitchClass('table')} data-table-overview-view-mode="table"
            aria-label={t('table_overview.tooltip.table_view')} aria-pressed={state.viewMode === 'table'}
            onClick={() => state.setViewMode('table')}>
            <TableOutlined style={{ fontSize: 14 }} />
          </button>
        </Tooltip>
      </div>
      <Tooltip title={t('table_overview.tooltip.refresh')}>
        <ReloadOutlined spin={state.loading} onClick={state.loadData} style={{ fontSize: 16, color: actions.textSecondary, cursor: 'pointer' }} />
      </Tooltip>
    </div>
  );
};

export default TableOverviewToolbar;
