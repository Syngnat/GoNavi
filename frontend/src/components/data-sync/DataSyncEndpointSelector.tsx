import React, { useEffect, useState } from 'react';

import { DataSyncConnectionTreeSelect } from './DataSyncConnectionTreeSelect';
import type {
  DataSyncConnectionTreeItem,
  DataSyncDatabaseMetadata,
  DataSyncEndpointRef,
  DataSyncSavedConnectionView,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

const MetadataStatus: React.FC<{
  scope: string;
  state: Pick<DataSyncMetadataResult<never>, 'status' | 'reload'>;
  loadingText: string;
  t: DataSyncWorkbenchTranslate;
}> = ({ scope, state, loadingText, t }) => {
  if (state.status === 'idle' || state.status === 'ready') return null;
  return (
    <div
      className="gn-data-sync-metadata-status"
      data-metadata-scope={scope}
      data-status={state.status}
      role={state.status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span>
        {state.status === 'loading' ? loadingText : t('metadata.load_failed')}
      </span>
      {state.status === 'error' ? (
        <button
          type="button"
          className="gn-data-sync-link-button"
          onClick={state.reload}
        >
          {t('metadata.retry')}
        </button>
      ) : null}
    </div>
  );
};

export const DataSyncEndpointSelector: React.FC<{
  role: 'source' | 'target';
  title: string;
  endpoint: DataSyncEndpointRef;
  connections: DataSyncMetadataResult<DataSyncSavedConnectionView>;
  connectionTree: DataSyncConnectionTreeItem[];
  databases: DataSyncMetadataResult<DataSyncDatabaseMetadata>;
  t: DataSyncWorkbenchTranslate;
  onConnectionChange: (connection: DataSyncSavedConnectionView | null) => void;
  onDatabaseChange: (database: string) => void;
  onSchemaChange: (schema: string) => void;
}> = ({
  role,
  title,
  endpoint,
  connections,
  connectionTree,
  databases,
  t,
  onConnectionChange,
  onDatabaseChange,
  onSchemaChange,
}) => {
  const selectableConnections = connections.items.filter((connection) =>
    role === 'source' ? connection.readable : connection.writable,
  );
  const currentDatabaseKnown = databases.items.some(
    (database) => database.name === endpoint.database,
  );
  const [schemaDraft, setSchemaDraft] = useState(endpoint.schema);

  useEffect(() => {
    setSchemaDraft(endpoint.schema);
  }, [endpoint.connectionId, endpoint.database, endpoint.schema]);

  const commitSchema = () => {
    if (schemaDraft !== endpoint.schema) onSchemaChange(schemaDraft);
  };

  return (
    <fieldset
      className="gn-data-sync-endpoint-fields"
      data-endpoint-role={role}
      data-expanded={endpoint.connectionId ? 'true' : 'false'}
    >
      <legend>
        <span>{title}</span>
        {endpoint.connectionId && endpoint.type ? (
          <span
            className="gn-data-sync-endpoint-type"
            data-endpoint-control="type"
          >
            {endpoint.type}
          </span>
        ) : null}
      </legend>
      <div className="gn-data-sync-field-grid">
        <label className="gn-data-sync-field" data-wide="true">
          <span>{t('editor.connection')}</span>
          <DataSyncConnectionTreeSelect
            role={role}
            endpoint={endpoint}
            connections={connections.items}
            connectionTree={connectionTree}
            loading={connections.status === 'loading'}
            placeholder={t('metadata.select_connection')}
            emptyText={t('metadata.no_eligible_connections')}
            onChange={onConnectionChange}
          />
        </label>
        {endpoint.connectionId ? (
          <>
            <label className="gn-data-sync-field">
              <span>{t('editor.database')}</span>
              <select
                className="gn-data-sync-control gn-data-sync-mono"
                data-endpoint-control="database"
                value={endpoint.database}
                disabled={databases.status === 'loading'}
                onChange={(event) => onDatabaseChange(event.target.value)}
              >
                {!endpoint.database ? (
                  <option value="" disabled hidden>
                    {t('metadata.select_database')}
                  </option>
                ) : null}
                {endpoint.database && !currentDatabaseKnown ? (
                  <option value={endpoint.database}>{endpoint.database}</option>
                ) : null}
                {databases.items.map((database) => (
                  <option key={database.name} value={database.name}>
                    {database.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="gn-data-sync-field">
              <span>{t('editor.schema')}</span>
              <input
                className="gn-data-sync-control gn-data-sync-mono"
                data-endpoint-control="schema"
                value={schemaDraft}
                placeholder={t('metadata.schema_optional')}
                onChange={(event) => setSchemaDraft(event.target.value)}
                onBlur={commitSchema}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </label>
          </>
        ) : null}
      </div>
      <MetadataStatus
        scope={`${role}-connections`}
        state={connections}
        loadingText={t('metadata.loading_connections')}
        t={t}
      />
      <MetadataStatus
        scope={`${role}-databases`}
        state={databases}
        loadingText={t('metadata.loading_databases')}
        t={t}
      />
      {connections.status === 'ready' && selectableConnections.length === 0 ? (
        <p className="gn-data-sync-inline-hint" data-tone="warning">
          {t('metadata.no_eligible_connections')}
        </p>
      ) : null}
      {databases.status === 'ready' && endpoint.connectionId && databases.items.length === 0 ? (
        <p className="gn-data-sync-inline-hint">
          {t('metadata.no_databases')}
        </p>
      ) : null}
    </fieldset>
  );
};
