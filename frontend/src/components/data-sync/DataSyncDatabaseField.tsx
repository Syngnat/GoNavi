import React, { useEffect, useState } from 'react';

import type { DataSyncDatabaseMetadata } from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

/** 下拉里「填写新库名」选项的哨兵值，不会作为库名提交。 */
export const DATA_SYNC_NEW_DATABASE_OPTION = '\u0000gonavi:new-database';

/**
 * Database / Catalog 选择。allowCreate 时可以填写一个尚不存在的库名，
 * 任务会在运行前创建它；不能建表的任务（如 CDC）只能从已有库里选。
 */
export const DataSyncDatabaseField: React.FC<{
  value: string;
  databases: DataSyncMetadataResult<DataSyncDatabaseMetadata>;
  allowCreate: boolean;
  t: DataSyncWorkbenchTranslate;
  onChange: (database: string) => void;
}> = ({ value, databases, allowCreate, t, onChange }) => {
  const known = databases.items.some((database) => database.name === value);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setCreating(false);
    setDraft('');
  }, [value]);

  const commitDraft = () => {
    const name = draft.trim();
    setCreating(false);
    if (name && name !== value) onChange(name);
  };

  const pendingCreate =
    allowCreate && Boolean(value) && !known && databases.status === 'ready';

  return (
    <>
      <select
        className="gn-data-sync-control gn-data-sync-mono"
        data-endpoint-control="database"
        value={creating ? DATA_SYNC_NEW_DATABASE_OPTION : value}
        disabled={databases.status === 'loading'}
        onChange={(event) => {
          if (event.target.value === DATA_SYNC_NEW_DATABASE_OPTION) {
            setDraft('');
            setCreating(true);
            return;
          }
          onChange(event.target.value);
        }}
      >
        {!value && !creating ? (
          <option value="" disabled hidden>
            {t('metadata.select_database')}
          </option>
        ) : null}
        {value && !known ? <option value={value}>{value}</option> : null}
        {databases.items.map((database) => (
          <option key={database.name} value={database.name}>
            {database.name}
          </option>
        ))}
        {allowCreate ? (
          <option value={DATA_SYNC_NEW_DATABASE_OPTION}>
            {t('metadata.new_database_option')}
          </option>
        ) : null}
      </select>
      {creating ? (
        <input
          className="gn-data-sync-control gn-data-sync-mono"
          data-endpoint-control="new-database"
          value={draft}
          autoFocus
          placeholder={t('metadata.new_database_placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft('');
              setCreating(false);
            }
          }}
        />
      ) : null}
      {pendingCreate ? (
        <small className="gn-data-sync-inline-hint" data-database-pending-create="true">
          {t('metadata.database_will_be_created', { database: value })}
        </small>
      ) : null}
    </>
  );
};
