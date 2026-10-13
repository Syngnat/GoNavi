import React from 'react';
import { Empty, Input, Spin, Tooltip } from 'antd';
import { EyeOutlined, FunctionOutlined, ReloadOutlined, SearchOutlined, FieldTimeOutlined } from '@ant-design/icons';

import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { t } from '../../i18n';
import type { TabData } from '../../types';
import { useObjectOverviewState } from './hooks/useObjectOverviewState';
import './ObjectOverview.css';

export interface ObjectOverviewProps {
  tab: TabData;
}

/**
 * 「视图 / 函数」对象列表页（Navicat「对象」页签的对应物）。
 *
 * 与 TableOverview（表）平行的轻量列表：搜索 + 行列表，双击打开；
 * 表列表仍走 table-overview，这里不重复其卡片/统计能力。
 */
const ObjectOverview: React.FC<ObjectOverviewProps> = ({ tab }) => {
  const {
    kind, filteredRows, loading, unsupported, searchText, setSearchText,
    selectedName, setSelectedName, connection, schemaName, loadData, openObject, handleCopyName,
  } = useObjectOverviewState({ tab });

  if (loading) {
    return (
      <div className="gn-object-overview" data-object-kind={kind}>
        <div className="gn-object-overview-loading">
          <Spin size="large" />
        </div>
      </div>
    );
  }

  const headerTitle = [tab.dbName, schemaName].filter(Boolean).join(' · ');
  const kindIcon = kind === 'views' ? <EyeOutlined /> : kind === 'events' ? <FieldTimeOutlined /> : <FunctionOutlined />;

  return (
    <div className="gn-object-overview" data-object-kind={kind}>
      <div className="gn-object-overview-header">
        <span className="gn-object-overview-icon">
          {kindIcon}
        </span>
        <span className="gn-object-overview-title">{headerTitle}</span>
        <span className="gn-object-overview-summary">
          {t('object_overview.summary.count', { count: filteredRows.length })}
        </span>
        <div className="gn-object-overview-spacer" />
        <Input
          {...noAutoCapInputProps}
          placeholder={t('object_overview.placeholder.search')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
          size="small"
        />
        <Tooltip title={t('object_overview.tooltip.refresh')}>
          <ReloadOutlined className="gn-object-overview-refresh" onClick={loadData} />
        </Tooltip>
      </div>
      <div className="gn-object-overview-content">
        {unsupported ? (
          <Empty description={t('object_overview.empty.unsupported')} />
        ) : filteredRows.length === 0 ? (
          <Empty
            description={searchText
              ? t('object_overview.empty.no_matches')
              : t(kind === 'views' ? 'object_overview.empty.no_views' : kind === 'events' ? 'object_overview.empty.no_events' : 'object_overview.empty.no_routines')}
          />
        ) : (
          <div className="gn-object-overview-list" role="list">
            {filteredRows.map(row => (
              <div
                key={`${row.name}-${row.subType || ''}`}
                role="listitem"
                className={`gn-object-overview-row${selectedName === row.name ? ' is-selected' : ''}`}
                onClick={() => setSelectedName(row.name)}
                onDoubleClick={() => openObject(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') openObject(row);
                }}
                tabIndex={0}
                title={t('object_overview.row.open_hint', { name: row.name })}
              >
                <span className="gn-object-overview-row-icon">
                  {kindIcon}
                </span>
                <span className="gn-object-overview-row-name">{row.name}</span>
                {kind === 'routines' && row.subType && (
                  <span className={`gn-object-overview-row-type${row.subType === 'PROCEDURE' ? ' is-procedure' : ''}`}>
                    {t(row.subType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function')}
                  </span>
                )}
                <Tooltip title={t('object_overview.row.copy_name')}>
                  <span
                    role="button"
                    aria-label={t('object_overview.row.copy_name')}
                    className="gn-object-overview-row-copy"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCopyName(row);
                    }}
                  >
                    {t('object_overview.row.copy_name')}
                  </span>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>
      {!connection && (
        <div className="gn-object-overview-missing-connection">
          {t('object_overview.message.missing_connection')}
        </div>
      )}
    </div>
  );
};

export default ObjectOverview;
