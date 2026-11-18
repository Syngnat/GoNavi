import React from 'react';
import { Checkbox, Dropdown, Popover, Tooltip } from 'antd';
import {
  TableOutlined, ReloadOutlined, SortAscendingOutlined, DatabaseOutlined,
  AppstoreOutlined, UnorderedListOutlined, SettingOutlined,
} from '@ant-design/icons';

import { t } from '../../i18n';
import type { TabData } from '../../types';
import type { ViewMode } from './tableOverviewModel';
import type { TableOverviewStateApi } from './hooks/useTableOverviewState';
import type { TableOverviewTableActionsApi } from './hooks/useTableOverviewTableActions';
import { TableOverviewSearchInput } from './TableOverviewSearchInput';
import { TABLE_OVERVIEW_COMPACT_COLUMN_OPTIONS } from './tableOverviewCompactColumns';

type TableOverviewToolbarProps = {
  tab: TabData;
  state: TableOverviewStateApi;
  actions: TableOverviewTableActionsApi;
};

const TableOverviewToolbar: React.FC<TableOverviewToolbarProps> = ({ tab, state, actions }) => {
  const [columnPickerOpen, setColumnPickerOpen] = React.useState(false);
  const columnPickerId = React.useId();
  const viewSwitchClass = (mode: ViewMode) => (
    `gn-v2-table-overview-view-switch-btn${state.viewMode === mode ? ' is-active' : ''}`
  );
  const columnPicker = (
    <div
      id={columnPickerId}
      className="gn-v2-table-overview-column-picker"
      role="group"
      aria-label={t('table_overview.toolbar.columns_title')}
    >
      <div className="gn-v2-table-overview-column-picker-hint">
        {t('table_overview.toolbar.columns_hint')}
      </div>
      {TABLE_OVERVIEW_COMPACT_COLUMN_OPTIONS.map((column) => (
        <Checkbox
          key={column.key}
          data-table-overview-column={column.key}
          checked={state.compactColumns.includes(column.key)}
          disabled={column.key === 'name'}
          onChange={(event) => {
            const nextColumns = event.target.checked
              ? [...state.compactColumns, column.key]
              : state.compactColumns.filter((key) => key !== column.key);
            state.setCompactColumns(nextColumns);
          }}
        >
          {t(column.labelKey)}
        </Checkbox>
      ))}
    </div>
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
      <TableOverviewSearchInput
        value={state.searchText}
        onChange={state.setSearchText}
        placeholder={t('table_overview.placeholder.search')}
        ariaLabel={t('table_overview.placeholder.search')}
        iconColor={actions.textMuted}
      />
      <Dropdown menu={{ items: actions.sortMenuItems }} trigger={['click']}>
        <Tooltip title={t('table_overview.tooltip.sort')}>
          <SortAscendingOutlined style={{ fontSize: 16, color: actions.textSecondary, cursor: 'pointer' }} />
        </Tooltip>
      </Dropdown>
      {state.viewMode === 'table' && (
        <Popover
          content={columnPicker}
          title={t('table_overview.toolbar.columns_title')}
          trigger="click"
          placement="bottomRight"
          open={columnPickerOpen}
          onOpenChange={setColumnPickerOpen}
          rootClassName="gn-v2-table-overview-column-picker-popover"
        >
          <Tooltip title={t('table_overview.toolbar.columns')}>
            <button
              type="button"
              className="gn-v2-table-overview-column-picker-trigger"
              aria-label={t('table_overview.toolbar.columns')}
              aria-controls={columnPickerId}
              aria-expanded={columnPickerOpen}
            >
              <SettingOutlined style={{ fontSize: 15 }} />
            </button>
          </Tooltip>
        </Popover>
      )}
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
