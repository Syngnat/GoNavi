import React from 'react';

import { t } from '../../i18n';
import { formatBytes } from '../../utils/jvmMonitoringPresentation';
import { useObjectInfo } from './hooks/useObjectInfo';
import './ObjectInfoPanel.css';

/**
 * 「信息」页签内容（侧栏底部面板）：跟随当前选中表展示
 * 名称/注释/引擎/编码/行格式/行数/大小/DDL。驱动不支持的
 * 字段逐项隐藏，方言完全不支持时降级为仅 DDL。
 * 面板外壳（页签/高度/显隐）由 SidebarInfoTabs 负责。
 */
export const ObjectInfoContent: React.FC = () => {
  const { target, details, unsupported, ddl, loadState, reload, connectionName } = useObjectInfo();

  if (!target) {
    return (
      <div className="gn-object-info-empty">
        {t('object_info.empty.no_table')}
      </div>
    );
  }

  const formatRows = (value?: number) => (
    value === undefined ? '' : value.toLocaleString()
  );

  const rows = details ? ([
    details.engine && { key: 'engine', label: t('object_info.field.engine'), value: details.engine },
    details.comment && { key: 'comment', label: t('object_info.field.comment'), value: details.comment },
    details.collation && { key: 'collation', label: t('object_info.field.collation'), value: details.collation },
    details.rowFormat && { key: 'rowFormat', label: t('object_info.field.row_format'), value: details.rowFormat },
    details.rows !== undefined && { key: 'rows', label: t('object_info.field.rows'), value: formatRows(details.rows) },
    details.dataLength !== undefined && { key: 'dataLength', label: t('object_info.field.data_size'), value: formatBytes(details.dataLength) },
    details.indexLength !== undefined && { key: 'indexLength', label: t('object_info.field.index_size'), value: formatBytes(details.indexLength) },
    details.autoIncrement && { key: 'autoIncrement', label: t('object_info.field.auto_increment'), value: details.autoIncrement },
    details.createTime && { key: 'createTime', label: t('object_info.field.create_time'), value: details.createTime },
    details.updateTime && { key: 'updateTime', label: t('object_info.field.update_time'), value: details.updateTime },
  ].filter(Boolean) as Array<{ key: string; label: string; value: string }>) : [];

  return (
    <div className="gn-object-info" data-object-info-loading={loadState === 'loading' ? 'true' : 'false'}>
      {loadState === 'loading' && <div className="gn-object-info-loading-dot" aria-hidden="true" />}
      <div className="gn-object-info-head">
        <div className="gn-object-info-head-name" title={target.tableName}>{target.tableName}</div>
        <button
          type="button"
          className="gn-object-info-reload"
          onClick={reload}
          aria-label={t('object_info.action.refresh')}
          title={t('object_info.action.refresh')}
        >⟳</button>
      </div>
      <div className="gn-object-info-meta">
        {[connectionName, target.dbName, target.schemaName].filter(Boolean).join(' · ')}
      </div>
      {unsupported ? (
        <div className="gn-object-info-unsupported">{t('object_info.message.unsupported')}</div>
      ) : rows.length > 0 && (
        <div className="gn-object-info-rows">
          {rows.map(row => (
            <div key={row.key} className="gn-object-info-row">
              <span className="gn-object-info-row-label">{row.label}</span>
              <span className="gn-object-info-row-value" title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
      {ddl && (
        <div className="gn-object-info-ddl">
          <div className="gn-object-info-ddl-title">{t('object_info.section.ddl')}</div>
          <pre className="gn-object-info-ddl-body">{ddl}</pre>
        </div>
      )}
    </div>
  );
};

export default ObjectInfoContent;
