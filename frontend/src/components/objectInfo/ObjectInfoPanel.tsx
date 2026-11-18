import React from 'react';

import { t } from '../../i18n';
import { formatBytes } from '../../utils/jvmMonitoringPresentation';
import { useObjectInfo } from './hooks/useObjectInfo';
import { ObjectInfoDdlBlock } from './ObjectInfoDdlBlock';
import './ObjectInfoPanel.css';

// 「信息」页签内容（侧栏底部面板）：跟随当前选中表或数据库展示
// 名称/元数据/DDL。表与库共用 DDL 区域，库显示建库 SQL。
// 面板外壳（页签/高度/显隐）由 SidebarInfoTabs 负责。
export const ObjectInfoContent: React.FC = () => {
  const {
    target, details, unsupported, ddl, loadState, reload, connectionName,
    databaseDdlUnsupported, loadError,
  } = useObjectInfo();

  if (!target) {
    return (
      <div className="gn-object-info-empty">
        {t('object_info.empty.no_object')}
      </div>
    );
  }
  const isDatabase = target.kind === 'database';
  const objectName = isDatabase ? target.dbName : target.tableName;
  const metaParts = isDatabase
    ? [connectionName, target.schemaName].filter(Boolean)
    : [connectionName, target.dbName, target.schemaName].filter(Boolean);
  const databaseDdlEmpty = isDatabase
    && loadState === 'ready'
    && !ddl
    && !databaseDdlUnsupported
    && !loadError;

  const formatRows = (value?: number) => (
    value === undefined ? '' : value.toLocaleString()
  );

  // 驱动返回的创建/更新时间是 ISO 串（如 2026-09-11T16:19:52+08:00），
  // 展示为 YYYY-MM-DD HH:mm:ss；解析失败时原样返回。
  const formatDateTime = (value?: string) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} `
      + `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  };

  const rows = !isDatabase && details ? ([
    details.engine && { key: 'engine', label: t('object_info.field.engine'), value: details.engine },
    details.comment && { key: 'comment', label: t('object_info.field.comment'), value: details.comment },
    details.collation && { key: 'collation', label: t('object_info.field.collation'), value: details.collation },
    details.rowFormat && { key: 'rowFormat', label: t('object_info.field.row_format'), value: details.rowFormat },
    details.rows !== undefined && { key: 'rows', label: t('object_info.field.rows'), value: formatRows(details.rows) },
    details.dataLength !== undefined && { key: 'dataLength', label: t('object_info.field.data_size'), value: formatBytes(details.dataLength) },
    details.indexLength !== undefined && { key: 'indexLength', label: t('object_info.field.index_size'), value: formatBytes(details.indexLength) },
    details.autoIncrement && { key: 'autoIncrement', label: t('object_info.field.auto_increment'), value: details.autoIncrement },
    details.createTime && { key: 'createTime', label: t('object_info.field.create_time'), value: formatDateTime(details.createTime) },
    details.updateTime && { key: 'updateTime', label: t('object_info.field.update_time'), value: formatDateTime(details.updateTime) },
  ].filter(Boolean) as Array<{ key: string; label: string; value: string }>) : [];

  return (
    <div className="gn-object-info" data-object-info-loading={loadState === 'loading' ? 'true' : 'false'}>
      {loadState === 'loading' && <div className="gn-object-info-loading-dot" aria-hidden="true" />}
      <div className="gn-object-info-head">
        <div className="gn-object-info-head-name" title={objectName}>{objectName}</div>
        <button
          type="button"
          className="gn-object-info-reload"
          onClick={reload}
          aria-label={t('object_info.action.refresh')}
          title={t('object_info.action.refresh')}
        >⟳</button>
      </div>
      <div className="gn-object-info-meta">
        {metaParts.join(' · ')}
      </div>
      {isDatabase && databaseDdlUnsupported ? (
        <div className="gn-object-info-unsupported">{t('object_info.message.database_ddl_unsupported')}</div>
      ) : !isDatabase && unsupported ? (
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
      {isDatabase && loadError && (
        <div className="gn-object-info-unsupported">
          {t('object_info.message.database_ddl_failed', { error: loadError })}
        </div>
      )}
      {databaseDdlEmpty && (
        <div className="gn-object-info-unsupported">
          {t('object_info.message.database_ddl_empty')}
        </div>
      )}
      {ddl && (
        <ObjectInfoDdlBlock ddl={ddl} database={isDatabase} />
      )}
    </div>
  );
};

export default ObjectInfoContent;
