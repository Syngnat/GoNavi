import React from 'react';

import type {
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
  databases,
  t,
  onConnectionChange,
  onDatabaseChange,
  onSchemaChange,
}) => {
  const selectableConnections = connections.items.filter((connection) =>
    role === 'source' ? connection.readable : connection.writable,
  );
  const currentConnection = connections.items.find(
    (connection) => connection.id === endpoint.connectionId,
  );
  const currentConnectionSelectable = selectableConnections.some(
    (connection) => connection.id === endpoint.connectionId,
  );
  const currentDatabaseKnown = databases.items.some(
    (database) => database.name === endpoint.database,
  );

  return (
    <fieldset
      className="gn-data-sync-endpoint-fields"
      data-endpoint-role={role}
    >
      <legend>{title}</legend>
      <div className="gn-data-sync-field-grid">
        <label className="gn-data-sync-field" data-wide="true">
          <span>{t('editor.connection')}</span>
          <select
            className="gn-data-sync-control"
            data-endpoint-control="connection"
            value={endpoint.connectionId}
            disabled={connections.status === 'loading'}
            onChange={(event) => {
              const selected = connections.items.find(
                (connection) => connection.id === event.target.value,
              );
              onConnectionChange(selected || null);
            }}
          >
            {!endpoint.connectionId ? (
              <option value="" disabled hidden>
                {t('metadata.select_connection')}
              </option>
            ) : null}
            {endpoint.connectionId && !currentConnectionSelectable ? (
              <option value={endpoint.connectionId}>
                {currentConnection?.name || endpoint.connectionName || endpoint.connectionId}
              </option>
            ) : null}
            {selectableConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {connection.type}
              </option>
            ))}
          </select>
        </label>
        <label className="gn-data-sync-field">
          <span>{t('editor.database_type')}</span>
          <output
            className="gn-data-sync-control gn-data-sync-control--read-only gn-data-sync-mono"
            data-endpoint-control="type"
          >
            {endpoint.type || t('metadata.not_selected')}
          </output>
        </label>
        <label className="gn-data-sync-field">
          <span>{t('editor.database')}</span>
          <select
            className="gn-data-sync-control gn-data-sync-mono"
            data-endpoint-control="database"
            value={endpoint.database}
            disabled={!endpoint.connectionId || databases.status === 'loading'}
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
            value={endpoint.schema}
            placeholder={t('metadata.schema_optional')}
            disabled={!endpoint.connectionId}
            onChange={(event) => onSchemaChange(event.target.value)}
          />
        </label>
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
