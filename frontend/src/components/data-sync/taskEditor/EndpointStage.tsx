import React from 'react';
import { DataSyncEndpointSelector } from '../DataSyncEndpointSelector';
import { DataSyncField as Field } from '../DataSyncField';
import type { DataSyncWorkbenchGateway } from '../gateway';
import type {
  DataSyncTaskDefinition,
  DataSyncConnectionTreeItem,
  DataSyncSavedConnectionView,
} from '../model';
import { type DataSyncWorkbenchTranslate, dataSyncStageTextKey } from '../text';
import { useDataSyncSavedConnections, useDataSyncDatabases } from '../useDataSyncMetadata';
import { type TaskPatch, clearEndpointMappings } from './taskEditorModel';

export const EndpointStage: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  connectionTree: DataSyncConnectionTreeItem[];
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
  onContinue: () => void;
}> = ({ task, gateway, connectionTree, t, onPatch, onContinue }) => {
  const connections = useDataSyncSavedConnections(gateway);
  const sourceDatabases = useDataSyncDatabases(gateway, task.source.connectionId,
    connections.items.some((connection) => connection.id === task.source.connectionId));
  const targetDatabases = useDataSyncDatabases(gateway, task.target.connectionId,
    connections.items.some((connection) => connection.id === task.target.connectionId));

  const selectConnection = (
    side: 'source' | 'target',
    connection: DataSyncSavedConnectionView | null,
  ) => {
    const endpoint = connection
      ? {
          connectionId: connection.id,
          connectionName: connection.name,
          type: connection.type,
          database: '',
          schema: '',
        }
      : {
          connectionId: '',
          connectionName: '',
          type: '',
          database: '',
          schema: '',
        };
    onPatch({
      [side]: endpoint,
      mappings: clearEndpointMappings(task.mappings, side),
    });
  };

  const selectDatabase = (side: 'source' | 'target', database: string) => {
    onPatch({
      [side]: { ...task[side], database, schema: '' },
      mappings: clearEndpointMappings(task.mappings, side),
    });
  };

  const changeSchema = (side: 'source' | 'target', schema: string) => {
    onPatch({
      [side]: { ...task[side], schema },
      mappings: clearEndpointMappings(task.mappings, side),
    });
  };

  const sourceReady = connections.items.some((connection) => connection.id === task.source.connectionId && connection.readable);
  const targetReady = connections.items.some((connection) => connection.id === task.target.connectionId && connection.writable);
  const canContinue = sourceReady && targetReady;

  return (
  <section className="gn-data-sync-guide" data-data-sync-endpoints="true">
    <header className="gn-data-sync-guide__header">
      <h2>{t('stage.endpoints')}</h2>
      <p>{t('editor.endpoint_help')}</p>
    </header>
    <label className="gn-data-sync-field gn-data-sync-guide__name">
      <span>{t('editor.task_name')}</span>
      <input
        className="gn-data-sync-control"
        value={task.name}
        placeholder={t('editor.task_name_placeholder')}
        onChange={(event) => onPatch({ name: event.target.value })}
      />
    </label>
    <div
      className="gn-data-sync-guide__step"
      data-guide-step="source"
      data-complete={sourceReady ? 'true' : 'false'}
    >
      <span className="gn-data-sync-guide__index" aria-hidden="true">
        {sourceReady ? '✓' : '1'}
      </span>
      <div className="gn-data-sync-guide__step-body">
        <h3>{t('editor.guide.source_title')}</h3>
        <DataSyncEndpointSelector
          role="source"
          title={t('editor.source_endpoint')}
          hideLegend
          endpoint={task.source}
          connections={connections}
          connectionTree={connectionTree}
          databases={sourceDatabases}
          t={t}
          onConnectionChange={(connection) => selectConnection('source', connection)}
          onDatabaseChange={(database) => selectDatabase('source', database)}
          onSchemaChange={(schema) => changeSchema('source', schema)}
        />
      </div>
    </div>
    <div
      className="gn-data-sync-guide__step"
      data-guide-step="target"
      data-complete={targetReady ? 'true' : 'false'}
      data-locked={sourceReady ? 'false' : 'true'}
    >
      <span className="gn-data-sync-guide__index" aria-hidden="true">
        {targetReady ? '✓' : '2'}
      </span>
      <div className="gn-data-sync-guide__step-body">
        <h3>{t('editor.guide.target_title')}</h3>
        {sourceReady ? null : (
          <p className="gn-data-sync-guide__locked">{t('editor.guide.target_locked')}</p>
        )}
        <div
          className="gn-data-sync-guide__endpoint"
          data-visible={sourceReady ? 'true' : 'false'}
        >
          <DataSyncEndpointSelector
            role="target"
            title={t('editor.target_endpoint')}
            hideLegend
            endpoint={task.target}
            connections={connections}
            connectionTree={connectionTree}
            databases={targetDatabases}
            t={t}
            onConnectionChange={(connection) => selectConnection('target', connection)}
            onDatabaseChange={(database) => selectDatabase('target', database)}
            onSchemaChange={(schema) => changeSchema('target', schema)}
          />
        </div>
      </div>
    </div>
    {task.sourceMode === 'query' && sourceReady ? (
      <div className="gn-data-sync-query-field">
        <Field label={t('editor.source_query')} wide>
          <textarea
            className="gn-data-sync-control gn-data-sync-mono"
            rows={8}
            value={task.sourceQuery}
            placeholder={t('editor.source_query_placeholder')}
            onChange={(event) => onPatch({ sourceQuery: event.target.value })}
          />
        </Field>
      </div>
    ) : null}
    <div className="gn-data-sync-guide__actions">
      <button
        type="button"
        className="gn-data-sync-button gn-data-sync-button--primary"
        data-guide-continue="true"
        disabled={!canContinue}
        onClick={onContinue}
      >
        <span>
          {t('workbench.next_step', {
            stage: t(dataSyncStageTextKey('mappings', task.kind, task.compareMode)),
          })}
        </span>
      </button>
    </div>
  </section>
  );
};
