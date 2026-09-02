import React, { useEffect, useRef, useState } from 'react';
import { isWebRPCAbortError } from '../../utils/webRpc';

import { DataSyncEndpointSelector } from './DataSyncEndpointSelector';
import { DataSyncFieldMappingEditor } from './DataSyncFieldMappingEditor';
import { DataSyncMappingTable } from './DataSyncMappingTable';
import { DataSyncRouteBar } from './DataSyncRouteBar';
import type { DataSyncWorkbenchGateway } from './gateway';
import {
  autoMatchDataSyncFields,
  buildDataSyncMappingsFromSelection,
  createDataSyncTableMapping,
  canUseDataSyncRowErrorIsolation,
  DATA_SYNC_TASK_STAGES,
  validateDataSyncTask,
  type DataSyncConnectionTreeItem,
  type DataSyncDeliveryPolicy,
  type DataSyncFieldMetadata,
  type DataSyncIncrementalPolicy,
  type DataSyncPreflightSnapshot,
  type DataSyncRouteCapability,
  type DataSyncTableMapping,
  type DataSyncTaskDefinition,
  type DataSyncTaskStage,
  type DataSyncTriggerPolicy,
  type DataSyncSavedConnectionView,
} from './model';
import {
  dataSyncValidationIssueText,
  type DataSyncWorkbenchTranslate,
} from './text';
import {
  useDataSyncDatabases,
  useDataSyncObjects,
  useDataSyncSavedConnections,
} from './useDataSyncMetadata';

type TaskPatch = Partial<
  Omit<
    DataSyncTaskDefinition,
    'id' | 'schemaVersion' | 'revision' | 'editEpoch' | 'createdAt'
  >
>;
type TaskPatchUpdater =
  | TaskPatch
  | ((currentTask: DataSyncTaskDefinition) => TaskPatch);

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}> = ({ label, children, wide = false }) => (
  <label className="gn-data-sync-field" data-wide={wide ? 'true' : 'false'}>
    <span>{label}</span>
    {children}
  </label>
);

const updateMapping = (
  task: DataSyncTaskDefinition,
  mapping: DataSyncTableMapping,
): DataSyncTableMapping[] =>
  task.mappings.map((item) => (item.id === mapping.id ? mapping : item));

const createTrigger = (
  mode: DataSyncTriggerPolicy['mode'],
): DataSyncTriggerPolicy => {
  if (mode === 'once') {
    return { mode, runAt: '', timezone: 'Local' };
  }
  if (mode === 'cron') {
    return {
      mode,
      expression: '',
      timezone: 'Asia/Shanghai',
      overlap: 'skip',
    };
  }
  if (mode === 'interval') {
    return { mode, intervalSeconds: 300, timezone: 'Asia/Shanghai' };
  }
  if (mode === 'manual') return { mode: 'manual' };
  return { mode: 'continuous' };
};

const toLocalDateTimeInput = (value: string): string => {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const fromLocalDateTimeInput = (value: string): string => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

const createIncremental = (
  mode: DataSyncIncrementalPolicy['mode'],
): DataSyncIncrementalPolicy => {
  if (mode === 'watermark') {
    return { mode, column: '', tieBreaker: '', overlapWindowMs: 0 };
  }
  if (mode === 'cdc') {
    return {
      mode,
      initialSnapshot: false,
      startPosition: 'latest',
      adapter: '',
      slotName: '',
      publicationName: '',
    };
  }
  return { mode };
};

const clearEndpointMappings = (
  mappings: DataSyncTableMapping[],
  side: 'source' | 'target',
): DataSyncTableMapping[] =>
  mappings.map((mapping) =>
    side === 'source'
      ? { ...mapping, sourceObject: '', keyColumns: [], fields: [] }
      : { ...mapping, targetObject: '', fields: [] },
  );

const EndpointStage: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  connectionTree: DataSyncConnectionTreeItem[];
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, gateway, connectionTree, t, onPatch }) => {
  const connections = useDataSyncSavedConnections(gateway);
  const sourceDatabases = useDataSyncDatabases(gateway, task.source.connectionId);
  const targetDatabases = useDataSyncDatabases(gateway, task.target.connectionId);

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

  return (
  <section className="gn-data-sync-section" data-data-sync-endpoints="true">
    <header className="gn-data-sync-section__header">
      <div>
        <h2>{t('stage.endpoints')}</h2>
        <p>{t('editor.endpoint_help')}</p>
      </div>
    </header>
    <div className="gn-data-sync-field-grid gn-data-sync-task-name-row">
      <Field label={t('editor.task_name')} wide>
        <input
          className="gn-data-sync-control"
          value={task.name}
          placeholder={t('editor.task_name_placeholder')}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
      </Field>
    </div>
    <div className="gn-data-sync-endpoints-grid">
      <DataSyncEndpointSelector
        role="source"
        title={t('editor.source_endpoint')}
        endpoint={task.source}
        connections={connections}
        connectionTree={connectionTree}
        databases={sourceDatabases}
        t={t}
        onConnectionChange={(connection) => selectConnection('source', connection)}
        onDatabaseChange={(database) => selectDatabase('source', database)}
        onSchemaChange={(schema) => changeSchema('source', schema)}
      />
      <DataSyncEndpointSelector
        role="target"
        title={t('editor.target_endpoint')}
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
    {task.sourceMode === 'query' ? (
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
  </section>
  );
};

const normalizeDataSyncObjectName = (value: string): string =>
  value
    .trim()
    .replace(/^[`"\[]/, '')
    .replace(/[`"\]]$/, '')
    .toLowerCase();

const resolveDataSyncObjectIdentity = (
  value: string,
  fallbackSchema: string,
): { schema: string; name: string } => {
  const parts = value
    .trim()
    .split('.')
    .map((part) => normalizeDataSyncObjectName(part))
    .filter(Boolean);
  const name = parts.pop() || '';
  return {
    name,
    schema:
      parts.length > 0
        ? parts.join('.')
        : normalizeDataSyncObjectName(fallbackSchema),
  };
};

const hasImplicitSameNameMappings = (task: DataSyncTaskDefinition): boolean => {
  const structureMigration =
    task.kind === 'migration' &&
    (task.content === 'schema' || task.content === 'both');
  const mappings = task.mappings;
  return (
    mappings.some((mapping) => mapping.enabled) &&
    mappings.every((mapping) => {
      if (
        mapping.fields.length > 0 ||
        (!structureMigration &&
          mapping.keyColumns.some((column) => column.trim().length > 0))
      ) {
        return false;
      }
      const source = resolveDataSyncObjectIdentity(
        mapping.sourceObject,
        task.source.schema,
      );
      const target = resolveDataSyncObjectIdentity(
        mapping.targetObject,
        task.target.schema,
      );
      return (
        Boolean(source.name) &&
        source.name === target.name
      );
    })
  );
};

const DeliveryStage: React.FC<{
  task: DataSyncTaskDefinition;
  capability: DataSyncRouteCapability;
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, capability, t, onPatch }) => {
  const patchDelivery = (patch: Partial<DataSyncDeliveryPolicy>) =>
    onPatch({ delivery: { ...task.delivery, ...patch } });
  const readOnly = task.kind === 'compare';
  const routeCanWrite =
    capability.level === 'unknown' ||
    (capability.canExecute &&
      (task.kind !== 'cdc' || capability.supportsCdc === true));
  const rowIsolationAvailable =
    routeCanWrite && canUseDataSyncRowErrorIsolation(task);
  const appendOnlyTarget =
    capability.level !== 'unknown' && capability.supportsMutations === false;
  const enabledMappings = task.mappings.filter((mapping) => mapping.enabled);
  const hasConfiguredMappings = enabledMappings.some(
    (mapping) =>
      mapping.sourceObject.trim().length > 0 &&
      mapping.targetObject.trim().length > 0,
  );
  const allEnabledMappingsHaveKeys =
    enabledMappings.length > 0 &&
    enabledMappings.every((mapping) =>
      mapping.keyColumns.some((column) => column.trim().length > 0),
    );
  const canPropagateDeletes =
    routeCanWrite &&
    !appendOnlyTarget &&
    task.delivery.writeMode === 'upsert' &&
    ((task.kind === 'reconcile' &&
      task.incremental.mode === 'snapshot' &&
      allEnabledMappingsHaveKeys) ||
      (task.kind === 'cdc' &&
        task.incremental.mode === 'cdc' &&
        allEnabledMappingsHaveKeys));
  const implicitSameNameMappings = hasImplicitSameNameMappings(task);
  const schemaOnlyMigration =
    task.kind === 'migration' && task.content === 'schema';
  const canConfigureMigrationStructure =
    task.kind === 'migration' &&
    capability.canExecute &&
    (implicitSameNameMappings || schemaOnlyMigration);
  const canAutoAddColumns =
    canConfigureMigrationStructure && capability.supportsAutoAddColumns === true;
  const canCreateIndexes =
    canConfigureMigrationStructure &&
    capability.supportsAutoCreate &&
    capability.requiresExistingTarget !== true &&
    enabledMappings.some((mapping) => mapping.targetMode === 'create_or_reuse');
  const showStructureOptions = canAutoAddColumns || canCreateIndexes;
  const writeModeDescription =
    task.delivery.writeMode === 'append'
      ? t('delivery.write.append_desc')
      : task.delivery.writeMode === 'overwrite'
        ? t('delivery.write.overwrite_desc')
        : t('delivery.write.upsert_desc');
  const structureCapabilityResolved = capability.level !== 'unknown';
  const errorPolicies: DataSyncDeliveryPolicy['errorPolicy'][] =
    rowIsolationAvailable ? ['stop', 'skip', 'quarantine'] : ['stop'];
  const errorPolicyCopy: Record<
    DataSyncDeliveryPolicy['errorPolicy'],
    { label: string; description: string }
  > = {
    stop: {
      label: t('delivery.error.stop'),
      description: t('delivery.error.stop_desc'),
    },
    skip: {
      label: t('delivery.error.skip'),
      description: t('delivery.error.skip_desc'),
    },
    quarantine: {
      label: t('delivery.error.quarantine'),
      description: t('delivery.error.quarantine_desc'),
    },
  };

  useEffect(() => {
    const patch: Partial<DataSyncDeliveryPolicy> = {};
    const effectiveErrorPolicy =
      readOnly || !rowIsolationAvailable ? 'stop' : task.delivery.errorPolicy;

    if (task.delivery.errorPolicy !== effectiveErrorPolicy) {
      patch.errorPolicy = effectiveErrorPolicy;
    }
    if (
      task.delivery.captureErrorPayload !==
      (effectiveErrorPolicy === 'quarantine')
    ) {
      patch.captureErrorPayload = effectiveErrorPolicy === 'quarantine';
    }
    if (!canPropagateDeletes && task.delivery.propagateDeletes) {
      patch.propagateDeletes = false;
    }
    if (appendOnlyTarget && task.delivery.writeMode !== 'append') {
      patch.writeMode = 'append';
      patch.retryLimit = 0;
    }
    if (
      hasConfiguredMappings &&
      structureCapabilityResolved &&
      !canAutoAddColumns &&
      task.delivery.autoAddColumns
    ) {
      patch.autoAddColumns = false;
    }
    if (
      hasConfiguredMappings &&
      structureCapabilityResolved &&
      !canCreateIndexes &&
      task.delivery.createIndexes
    ) {
      patch.createIndexes = false;
    }
    if (Object.keys(patch).length > 0) {
      onPatch({ delivery: { ...task.delivery, ...patch } });
    }
    if (task.delivery.writeMode === 'append' && task.resumePolicy !== 'never') {
      onPatch({ resumePolicy: 'never' });
    }
  }, [
    canAutoAddColumns,
    canCreateIndexes,
    canPropagateDeletes,
    appendOnlyTarget,
    hasConfiguredMappings,
    onPatch,
    readOnly,
    rowIsolationAvailable,
    structureCapabilityResolved,
    task.delivery.autoAddColumns,
    task.delivery.captureErrorPayload,
    task.delivery.createIndexes,
    task.delivery.errorPolicy,
    task.delivery.propagateDeletes,
    task.delivery.writeMode,
    task.resumePolicy,
  ]);

  if (readOnly) {
    return (
      <section className="gn-data-sync-section" data-data-sync-delivery="true">
        <header className="gn-data-sync-section__header">
          <div>
            <h2>{t('delivery.title')}</h2>
            <p>{t('delivery.help')}</p>
          </div>
        </header>
        <div
          className="gn-data-sync-delivery-main"
          data-data-sync-compare-mode="true"
        >
          <Field label={t('compare.mode.title')}>
            <select
              className="gn-data-sync-control"
              value={task.compareMode || 'data'}
              onChange={(event) =>
                onPatch({
                  compareMode: event.target
                    .value as DataSyncTaskDefinition['compareMode'],
                })
              }
            >
              <option value="data">{t('compare.mode.data')}</option>
              <option value="schema">{t('compare.mode.schema')}</option>
              <option value="both">{t('compare.mode.both')}</option>
            </select>
          </Field>
          <p className="gn-data-sync-inline-note" role="note">
            {t('compare.mode.help')}
          </p>
        </div>
        <div className="gn-data-sync-readonly-note" role="note">
          <strong>{t('delivery.read_only_title')}</strong>
          <span>{t('delivery.read_only_note')}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="gn-data-sync-section" data-data-sync-delivery="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('delivery.title')}</h2>
          <p>{t('delivery.help')}</p>
        </div>
      </header>
      <div className="gn-data-sync-delivery-main">
        {task.kind === 'migration' ? (
          <Field label={t('delivery.content_mode')}>
            <select
              className="gn-data-sync-control"
              value={task.content || 'both'}
              onChange={(event) =>
                onPatch({
                  content: event.target.value as NonNullable<
                    DataSyncTaskDefinition['content']
                  >,
                })
              }
            >
              <option value="schema">{t('delivery.content.schema')}</option>
              <option value="data">{t('delivery.content.data')}</option>
              <option value="both">{t('delivery.content.both')}</option>
            </select>
          </Field>
        ) : null}
        {schemaOnlyMigration ? (
          <p className="gn-data-sync-inline-note" role="note" data-schema-only-task="true">
            {t('delivery.schema_only_note')}
          </p>
        ) : null}
        {appendOnlyTarget ? (
          <p className="gn-data-sync-inline-note" role="note" data-append-only-target="true">
            {t('delivery.append_only_target_note')}
          </p>
        ) : null}
        <Field label={t('delivery.write_mode')}>
          <select
            className="gn-data-sync-control"
            value={task.delivery.writeMode}
            onChange={(event) => {
              const writeMode =
                event.target.value as DataSyncDeliveryPolicy['writeMode'];
              patchDelivery({
                writeMode,
                ...(writeMode === 'append' ? { retryLimit: 0 } : {}),
                ...(writeMode === 'overwrite'
                  ? { errorPolicy: 'stop' as const, captureErrorPayload: false }
                  : {}),
                ...(writeMode !== 'upsert' ? { propagateDeletes: false } : {}),
              });
              if (writeMode === 'append' && task.resumePolicy !== 'never') {
                onPatch({ resumePolicy: 'never' });
              }
            }}
          >
            <option
              value="append"
              disabled={task.incremental.mode === 'watermark'}
            >
              {t('delivery.write.append')}
            </option>
            <option value="upsert" disabled={appendOnlyTarget}>
              {appendOnlyTarget
                ? t('delivery.write.upsert_unavailable')
                : t('delivery.write.upsert')}
            </option>
            <option value="overwrite" disabled>
              {t('delivery.write.overwrite_unavailable')}
            </option>
          </select>
          <small className="gn-data-sync-mode-help">{writeModeDescription}</small>
        </Field>
        <div
          className="gn-data-sync-policy-field"
          role="radiogroup"
          aria-label={t('delivery.error_policy')}
          data-delivery-policy="error"
        >
          <span className="gn-data-sync-policy-field__label">
            {t('delivery.error_policy')}
          </span>
          <div className="gn-data-sync-policy-options">
            {errorPolicies.map((errorPolicy) => (
                <label
                  key={errorPolicy}
                  className="gn-data-sync-policy-option"
                  data-selected={
                    task.delivery.errorPolicy === errorPolicy ? 'true' : 'false'
                  }
                  data-error-policy-option={errorPolicy}
                >
                  <input
                    type="radio"
                    name={`data-sync-error-policy-${task.id}`}
                    value={errorPolicy}
                    checked={task.delivery.errorPolicy === errorPolicy}
                    onChange={() =>
                      patchDelivery({
                        errorPolicy,
                        captureErrorPayload: errorPolicy === 'quarantine',
                      })
                    }
                  />
                  <span className="gn-data-sync-policy-option__copy">
                    <strong>{errorPolicyCopy[errorPolicy].label}</strong>
                    <small>{errorPolicyCopy[errorPolicy].description}</small>
                  </span>
                </label>
              ))}
          </div>
        </div>
        {!rowIsolationAvailable && !readOnly ? (
          <p className="gn-data-sync-inline-note" role="note">
            {t('delivery.row_isolation_note')}
          </p>
        ) : null}
      </div>

      {canPropagateDeletes ? (
        <div
          className="gn-data-sync-delete-risk"
          data-delete-propagation="true"
          data-enabled={task.delivery.propagateDeletes ? 'true' : 'false'}
        >
          <div className="gn-data-sync-delete-risk__heading">
            <strong>{t('delivery.delete_policy_title')}</strong>
            <span>{t('delivery.delete_risk_badge')}</span>
          </div>
          <label className="gn-data-sync-option-row">
          <input
            type="checkbox"
            checked={task.delivery.propagateDeletes}
            onChange={(event) =>
              patchDelivery({
                propagateDeletes: event.target.checked,
                ...(event.target.checked && task.kind !== 'cdc'
                  ? {
                      errorPolicy: 'stop' as const,
                      captureErrorPayload: false,
                    }
                  : {}),
              })
            }
          />
            <span className="gn-data-sync-option-row__copy">
              <strong>
                {t(
                  task.kind === 'cdc'
                    ? 'delivery.delete.cdc_label'
                    : 'delivery.delete.snapshot_label',
                )}
              </strong>
              <small>
                {t(
                  task.kind === 'cdc'
                    ? 'delivery.delete.cdc_desc'
                    : 'delivery.delete.snapshot_desc',
                )}
              </small>
            </span>
          </label>
          <p>{t('delivery.delete_risk_note')}</p>
        </div>
      ) : null}

      <details className="gn-data-sync-advanced" data-delivery-advanced="true">
        <summary>
          <span>{t('delivery.advanced')}</span>
          <small>{t('delivery.advanced_help')}</small>
        </summary>
        <div className="gn-data-sync-advanced__body">
          <section className="gn-data-sync-advanced__section">
            <header>
              <h3>{t('delivery.performance_title')}</h3>
              <p>{t('delivery.performance_help')}</p>
            </header>
            <div className="gn-data-sync-field-grid gn-data-sync-field-grid--policy">
              <Field label={t('delivery.batch_size')}>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.batchSize}
                  onChange={(event) => {
                    const batchSize = Number(event.target.value);
                    patchDelivery({ batchSize, commitEvery: batchSize });
                  }}
                />
              </Field>
              <Field label={t('delivery.retry_limit')}>
                <input
                  type="number"
                  min={0}
                  max={20}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.retryLimit}
                  disabled={task.delivery.writeMode === 'append'}
                  onChange={(event) =>
                    patchDelivery({ retryLimit: Number(event.target.value) })
                  }
                />
              </Field>
              {task.delivery.writeMode === 'append' ? (
                <p className="gn-data-sync-inline-note" role="note">
                  {t('delivery.append_retry_note')}
                </p>
              ) : null}
              <Field label={t('delivery.recovery_policy')}>
                <select
                  className="gn-data-sync-control"
                  value={task.delivery.writeMode === 'append' ? 'never' : task.resumePolicy}
                  disabled={task.delivery.writeMode === 'append'}
                  data-delivery-recovery={task.delivery.writeMode}
                  onChange={(event) =>
                    onPatch({
                      resumePolicy: event.target.value as DataSyncTaskDefinition['resumePolicy'],
                    })
                  }
                >
                  <option value="never">{t('delivery.recovery.never')}</option>
                  <option value="manual">{t('delivery.recovery.manual')}</option>
                  <option value="auto">{t('delivery.recovery.auto')}</option>
                </select>
                {task.delivery.writeMode === 'append' ? (
                  <small className="gn-data-sync-mode-help">
                    {t('delivery.append_recovery_note')}
                  </small>
                ) : null}
              </Field>
              <Field label={t('delivery.retry_backoff')}>
                <input
                  type="number"
                  min={0}
                  className="gn-data-sync-control gn-data-sync-mono"
                  value={task.delivery.retryBackoffMs}
                  disabled={task.delivery.retryLimit === 0}
                  onChange={(event) =>
                    patchDelivery({ retryBackoffMs: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
          </section>
          {showStructureOptions ? (
            <section
              className="gn-data-sync-advanced__section"
              data-delivery-structure="true"
            >
              <header>
                <h3>{t('delivery.structure_title')}</h3>
                <p>{t('delivery.structure_help')}</p>
              </header>
              <div className="gn-data-sync-structure-options">
                {canAutoAddColumns ? (
                  <label
                    className="gn-data-sync-option-row"
                    data-structure-option="auto-add-columns"
                  >
                    <input
                      type="checkbox"
                      checked={task.delivery.autoAddColumns}
                      onChange={(event) =>
                        patchDelivery({
                          autoAddColumns: event.target.checked,
                          ...(event.target.checked
                            ? {
                                errorPolicy: 'stop' as const,
                                captureErrorPayload: false,
                              }
                            : {}),
                        })
                      }
                    />
                    <span className="gn-data-sync-option-row__copy">
                      <strong>{t('delivery.auto_add_columns')}</strong>
                      <small>{t('delivery.auto_add_columns_desc')}</small>
                    </span>
                  </label>
                ) : null}
                {canCreateIndexes ? (
                  <label
                    className="gn-data-sync-option-row"
                    data-structure-option="create-indexes"
                  >
                    <input
                      type="checkbox"
                      checked={task.delivery.createIndexes}
                      onChange={(event) =>
                        patchDelivery({
                          createIndexes: event.target.checked,
                          ...(event.target.checked
                            ? {
                                errorPolicy: 'stop' as const,
                                captureErrorPayload: false,
                              }
                            : {}),
                        })
                      }
                    />
                    <span className="gn-data-sync-option-row__copy">
                      <strong>{t('delivery.create_indexes')}</strong>
                      <small>{t('delivery.create_indexes_desc')}</small>
                    </span>
                  </label>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </details>
    </section>
  );
};

const TriggerStage: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  capability: DataSyncRouteCapability;
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, gateway, capability, t, onPatch }) => {
  const trigger = task.trigger;
  const incremental = task.incremental;
  const hasMixedWatermarks =
    incremental.mode === 'watermark' &&
    new Set(
      task.mappings
        .filter((mapping) => mapping.enabled && mapping.watermark)
        .map(
          (mapping) =>
            `${mapping.watermark!.column}\u0000${mapping.watermark!.tieBreaker}`,
        ),
    ).size > 1;
  const [cdcAdapterName, setCdcAdapterName] = useState('');
  const [cdcMetadataState, setCdcMetadataState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [checkpointAvailable, setCheckpointAvailable] = useState(false);

  useEffect(() => {
    if (incremental.mode !== 'cdc') {
      setCdcMetadataState('idle');
      setCdcAdapterName('');
      setCheckpointAvailable(false);
      return undefined;
    }
    let active = true;
    setCdcMetadataState('loading');
    void Promise.all([
      gateway.getCheckpoint(task.id),
    ])
      .then(([checkpoint]) => {
        if (!active) return;
        setCdcAdapterName(incremental.adapter || capability.cdcAdapter || '');
        setCheckpointAvailable(Boolean(checkpoint));
        setCdcMetadataState('ready');
      })
      .catch(() => {
        if (!active) return;
        setCdcAdapterName('');
        setCheckpointAvailable(false);
        setCdcMetadataState('error');
      });
    return () => {
      active = false;
    };
  }, [
    capability.cdcAdapter,
    gateway,
    incremental.mode === 'cdc' ? incremental.adapter : '',
    incremental.mode,
    task.id,
  ]);
  return (
  <section className="gn-data-sync-section" data-data-sync-trigger="true">
    <header className="gn-data-sync-section__header">
      <div>
        <h2>{t('trigger.title')}</h2>
        <p>{t('trigger.help')}</p>
      </div>
    </header>
    <div className="gn-data-sync-field-grid gn-data-sync-field-grid--policy">
      <Field label={t('trigger.mode')}>
        <select
          className="gn-data-sync-control"
          value={trigger.mode}
          onChange={(event) =>
            onPatch({
              trigger: createTrigger(event.target.value as DataSyncTriggerPolicy['mode']),
            })
          }
        >
          <option value="manual" disabled={task.kind === 'cdc'}>{t('trigger.manual')}</option>
          <option value="once" disabled={task.kind === 'cdc'}>{t('trigger.once')}</option>
          <option value="interval" disabled={task.kind === 'cdc'}>{t('trigger.interval')}</option>
          <option value="cron" disabled={task.kind === 'cdc'}>{t('trigger.cron')}</option>
          <option value="continuous" disabled={task.kind !== 'cdc'}>{t('trigger.continuous')}</option>
        </select>
      </Field>
      <Field label={t('incremental.mode')}>
        <select
          className="gn-data-sync-control"
          value={incremental.mode}
          onChange={(event) => {
            const mode = event.target.value as DataSyncIncrementalPolicy['mode'];
            onPatch({
              incremental: createIncremental(mode),
              ...(mode === 'watermark'
                ? {
                    mappings: task.mappings.map((mapping) => ({
                      ...mapping,
                      watermark: {
                        column:
                          mapping.watermark?.column ||
                          (incremental.mode === 'watermark'
                            ? incremental.column
                            : ''),
                        tieBreaker:
                          mapping.watermark?.tieBreaker ||
                          (incremental.mode === 'watermark'
                            ? incremental.tieBreaker
                            : ''),
                      },
                    })),
                  }
                : {}),
              ...(mode === 'watermark'
                ? {
                    delivery: {
                      ...task.delivery,
                      writeMode:
                        task.delivery.writeMode === 'append'
                          ? ('upsert' as const)
                          : task.delivery.writeMode,
                      errorPolicy: 'stop' as const,
                      captureErrorPayload: false,
                    },
                  }
                : {}),
            });
          }}
        >
          <option value="snapshot" disabled={task.kind === 'cdc'}>{t('incremental.snapshot')}</option>
          <option value="watermark" disabled={task.kind === 'cdc'}>{t('incremental.watermark')}</option>
          <option value="cdc" disabled={task.kind !== 'cdc'}>{t('incremental.cdc')}</option>
        </select>
      </Field>
      {trigger.mode === 'once' ? (
        <>
          <Field label={t('trigger.run_at')}>
            <input
              type="datetime-local"
              className="gn-data-sync-control gn-data-sync-mono"
              value={toLocalDateTimeInput(trigger.runAt)}
              onChange={(event) =>
                onPatch({
                  trigger: {
                    ...trigger,
                    runAt: fromLocalDateTimeInput(event.target.value),
                    timezone: 'Local',
                  },
                })
              }
            />
          </Field>
        </>
      ) : null}
      {trigger.mode === 'cron' ? (
        <>
          <Field label={t('trigger.cron_expression')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.expression}
              onChange={(event) =>
                onPatch({ trigger: { ...trigger, expression: event.target.value } })
              }
            />
          </Field>
          <Field label={t('trigger.timezone')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.timezone}
              onChange={(event) =>
                onPatch({ trigger: { ...trigger, timezone: event.target.value } })
              }
            />
          </Field>
          <Field label={t('trigger.overlap')}>
            <select
              className="gn-data-sync-control"
              value={trigger.overlap}
              onChange={(event) =>
                onPatch({
                  trigger: {
                    ...trigger,
                    overlap: event.target.value as 'skip' | 'queue',
                  },
                })
              }
            >
              <option value="skip">{t('trigger.overlap.skip')}</option>
              <option value="queue">{t('trigger.overlap.queue')}</option>
            </select>
          </Field>
        </>
      ) : null}
      {trigger.mode === 'interval' ? (
        <>
          <Field label={t('trigger.interval_seconds')}>
            <input
              type="number"
              min={60}
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.intervalSeconds}
              onChange={(event) =>
                onPatch({
                  trigger: {
                    ...trigger,
                    intervalSeconds: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
          <Field label={t('trigger.timezone')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={trigger.timezone}
              onChange={(event) =>
                onPatch({ trigger: { ...trigger, timezone: event.target.value } })
              }
            />
          </Field>
        </>
      ) : null}
      {incremental.mode === 'watermark' ? (
        <>
          <Field label={t('incremental.watermark_column')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={incremental.column}
              onChange={(event) =>
                onPatch({
                  incremental: { ...incremental, column: event.target.value },
                  mappings: task.mappings.map((mapping) => ({
                    ...mapping,
                    watermark: {
                      column: event.target.value,
                      tieBreaker:
                        mapping.watermark?.tieBreaker || incremental.tieBreaker,
                    },
                  })),
                })
              }
            />
          </Field>
          <Field label={t('incremental.tie_breaker')}>
            <input
              className="gn-data-sync-control gn-data-sync-mono"
              value={incremental.tieBreaker}
              onChange={(event) =>
                onPatch({
                  incremental: {
                    ...incremental,
                    tieBreaker: event.target.value,
                  },
                  mappings: task.mappings.map((mapping) => ({
                    ...mapping,
                    watermark: {
                      column: mapping.watermark?.column || incremental.column,
                      tieBreaker: event.target.value,
                    },
                  })),
                })
              }
            />
          </Field>
          <p className="gn-data-sync-inline-note" role="note">
            {t('incremental.watermark_delivery_note')}
          </p>
          {hasMixedWatermarks ? (
            <p className="gn-data-sync-inline-note" role="note">
              {t('incremental.watermark_mixed_note')}
            </p>
          ) : null}
        </>
      ) : null}
      {incremental.mode === 'cdc' ? (
        <>
          <Field label={t('incremental.cdc_adapter')}>
            <output className="gn-data-sync-control gn-data-sync-control--read-only gn-data-sync-mono">
              {cdcMetadataState === 'loading'
                ? t('metadata.loading_cdc_adapters')
                : cdcAdapterName || t('incremental.select_cdc_adapter')}
            </output>
          </Field>
          {capability.cdcAdapter && capability.cdcProbeReady === true ? (
            <p
              className="gn-data-sync-inline-note"
              role="status"
              data-cdc-probe-status="ready"
            >
              {t('incremental.cdc_probe_ready')}
            </p>
          ) : null}
          {capability.cdcAdapter && capability.cdcProbeReady === false ? (
            <div
              className="gn-data-sync-safety-note"
              role="alert"
              data-cdc-probe-status="blocked"
            >
              <strong>{t('incremental.cdc_probe_unready')}</strong>
              {capability.cdcProbeReason ? <p>{capability.cdcProbeReason}</p> : null}
            </div>
          ) : null}
          <Field label={t('incremental.start_position')}>
            <select
              className="gn-data-sync-control"
              value={incremental.startPosition}
              onChange={(event) =>
                onPatch({
                  incremental: {
                    ...incremental,
                    startPosition: event.target.value as
                      | 'latest'
                      | 'earliest'
                      | 'checkpoint',
                  },
                })
              }
            >
              <option value="latest">{t('incremental.position.latest')}</option>
              <option value="earliest" disabled>{t('incremental.position.earliest')}</option>
              <option value="checkpoint" disabled={!checkpointAvailable}>
                {t('incremental.position.checkpoint')}
              </option>
            </select>
          </Field>
          <div className="gn-data-sync-safety-note" role="note">
            <strong>{t('incremental.cdc_safety_title')}</strong>
            <p>{t('incremental.cdc_safety_note')}</p>
            <p>{t('incremental.cdc_snapshot_gap_warning')}</p>
            {!checkpointAvailable ? (
              <p>{t('incremental.cdc_checkpoint_unavailable')}</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  </section>
  );
};

const PreflightStage: React.FC<{
  task: DataSyncTaskDefinition;
  snapshot: DataSyncPreflightSnapshot | null;
  stale: boolean;
  t: DataSyncWorkbenchTranslate;
  onLocate: (stage: DataSyncTaskStage) => void;
}> = ({ task, snapshot, stale, t, onLocate }) => {
  const hasCurrentSnapshot = Boolean(snapshot && !stale);
  const issues = hasCurrentSnapshot ? snapshot!.issues : validateDataSyncTask(task);
  return (
    <section className="gn-data-sync-section" data-data-sync-preflight-stage="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('preflight.title')}</h2>
          <p>
            {stale
              ? t('preflight.stale')
              : hasCurrentSnapshot
                ? t('preflight.empty')
                : t('preflight.not_run')}
          </p>
        </div>
      </header>
      {!stale && snapshot && snapshot.approvalRequired !== false ? (
        <div
          className="gn-data-sync-approval-state"
          data-approval-required="true"
          role="alert"
        >
          <strong>{t('preflight.approval_required')}</strong>
          <span>{t('preflight.approval_fail_closed')}</span>
        </div>
      ) : null}
      <ol className="gn-data-sync-preflight-checklist">
        {issues.length === 0 ? (
          <li data-severity="info">
            {hasCurrentSnapshot ? t('preflight.passed') : t('preflight.not_run')}
          </li>
        ) : (
          issues.map((item) => (
            <li key={item.id} data-severity={item.severity}>
              <span>{t(`preflight.severity.${item.severity}`)}</span>
              <p title={item.message || undefined}>
                {dataSyncValidationIssueText(item, t)}
              </p>
              <button
                type="button"
                className="gn-data-sync-link-button"
                onClick={() => onLocate(item.stage)}
              >
                {t('preflight.open_issue')}
              </button>
            </li>
          ))
        )}
      </ol>
    </section>
  );
};

export const DataSyncTaskEditor: React.FC<{
  task: DataSyncTaskDefinition;
  gateway: DataSyncWorkbenchGateway;
  connectionTree?: DataSyncConnectionTreeItem[];
  capability: DataSyncRouteCapability;
  activeStage: DataSyncTaskStage;
  preflight: DataSyncPreflightSnapshot | null;
  preflightStale: boolean;
  preflightContent?: React.ReactNode;
  t: DataSyncWorkbenchTranslate;
  onStageChange: (stage: DataSyncTaskStage) => void;
  onPatch: (patch: TaskPatchUpdater) => void;
}> = ({
  task,
  gateway,
  connectionTree = [],
  capability,
  activeStage,
  preflight,
  preflightStale,
  preflightContent,
  t,
  onStageChange,
  onPatch,
}) => {
  const sourceObjects = useDataSyncObjects(gateway, task.source);
  const targetObjects = useDataSyncObjects(gateway, task.target);
  const navigationIssues =
    preflight && !preflightStale ? preflight.issues : validateDataSyncTask(task);
  const currentTaskRef = useRef(task);
  const stageNavRef = useRef<HTMLElement | null>(null);
  currentTaskRef.current = task;
  const [inspectedMappingId, setInspectedMappingId] = useState('');
  const mappingProbeEpochRef = useRef(0);
  const mappingProbeAbortRef = useRef<AbortController | null>(null);
  const [mappingProbe, setMappingProbe] = useState<{
    taskId: string;
    epoch: number;
    completed: number;
    total: number;
  } | null>(null);
  const inspectedMapping =
    task.mappings.find((mapping) => mapping.id === inspectedMappingId) || null;

  useEffect(() => {
    setInspectedMappingId('');
    mappingProbeEpochRef.current += 1;
    mappingProbeAbortRef.current?.abort();
    mappingProbeAbortRef.current = null;
    setMappingProbe(null);
    return () => {
      mappingProbeEpochRef.current += 1;
      mappingProbeAbortRef.current?.abort();
      mappingProbeAbortRef.current = null;
    };
  }, [
    task.id,
    task.source.connectionId,
    task.source.type,
    task.source.database,
    task.source.schema,
    task.target.connectionId,
    task.target.type,
    task.target.database,
    task.target.schema,
  ]);

  useEffect(() => {
    if (inspectedMappingId && !inspectedMapping) setInspectedMappingId('');
  }, [inspectedMapping, inspectedMappingId]);

  useEffect(() => {
    const navigation = stageNavRef.current;
    if (!navigation) return undefined;
    const activeButton = navigation.querySelector<HTMLElement>(
      `button[data-stage="${activeStage}"]`,
    );
    if (!activeButton) return undefined;

    const keepActiveStageVisible = () => {
      const navigationBounds = navigation.getBoundingClientRect();
      const buttonBounds = activeButton.getBoundingClientRect();
      const hidden =
        buttonBounds.left < navigationBounds.left + 6 ||
        buttonBounds.right > navigationBounds.right - 6;
      if (!hidden) return;
      const buttonLeftInsideNavigation =
        navigation.scrollLeft + buttonBounds.left - navigationBounds.left;
      const left = Math.min(
        Math.max(0, navigation.scrollWidth - navigation.clientWidth),
        Math.max(
          0,
          buttonLeftInsideNavigation -
            (navigation.clientWidth - buttonBounds.width) / 2,
        ),
      );
      const reduceMotion =
        typeof globalThis.matchMedia === 'function' &&
        globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof navigation.scrollTo === 'function') {
        navigation.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
      } else {
        navigation.scrollLeft = left;
      }
    };

    keepActiveStageVisible();
    if (typeof globalThis.ResizeObserver !== 'function') return undefined;
    const observer = new globalThis.ResizeObserver(keepActiveStageVisible);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [activeStage]);

  const changeMapping = (mapping: DataSyncTableMapping) =>
    onPatch({ mappings: updateMapping(task, mapping) });

  const addSelectedObjects = (sourceNames: string[]) => {
    const requestTask = task;
    const requestSourceScope = JSON.stringify([
      requestTask.source.connectionId,
      requestTask.source.type,
      requestTask.source.database,
      requestTask.source.schema,
    ]);
    const requestTargetScope = JSON.stringify([
      requestTask.target.connectionId,
      requestTask.target.type,
      requestTask.target.database,
      requestTask.target.schema,
    ]);
    const buildMappings = (existingMappings: DataSyncTableMapping[]) =>
      buildDataSyncMappingsFromSelection({
        taskId: requestTask.id,
        taskKind: requestTask.kind,
        sourceNames,
        targetObjects: targetObjects.items,
        existingMappings,
        allowTargetCreate:
          requestTask.kind === 'migration' &&
          capability.canExecute &&
          capability.supportsAutoCreate &&
          capability.requiresExistingTarget !== true,
      });
    const mappings = buildMappings(requestTask.mappings);
    onPatch({ mappings });
    if (requestTask.kind !== 'reconcile' && requestTask.kind !== 'cdc') {
      setMappingProbe(null);
      return;
    }

    const selectedSources = new Set(
      sourceNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
    );
    const addedMappings = mappings.filter((mapping) =>
      selectedSources.has(mapping.sourceObject.trim().toLowerCase()),
    );
    if (addedMappings.length === 0) return;
    const probeEpoch = ++mappingProbeEpochRef.current;
    mappingProbeAbortRef.current?.abort();
    const probeController = new AbortController();
    mappingProbeAbortRef.current = probeController;
    setMappingProbe({
      taskId: requestTask.id,
      epoch: probeEpoch,
      completed: 0,
      total: addedMappings.length,
    });
    type DetectedMappingMetadata = {
      keyColumns: string[];
      sourceFields: DataSyncFieldMetadata[];
      targetFields: DataSyncFieldMetadata[];
      targetObject: string;
    };
    const detectInBackground = async () => {
      const metadataByMappingId = new Map<string, DetectedMappingMetadata>();
      const progressStride = Math.max(1, Math.ceil(addedMappings.length / 40));
      let completedCount = 0;
      let publishedCount = 0;
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(4, addedMappings.length) },
        async () => {
          while (
            cursor < addedMappings.length &&
            mappingProbeEpochRef.current === probeEpoch
          ) {
            const index = cursor;
            cursor += 1;
            const mapping = addedMappings[index];
            try {
              const sourceFields = await gateway.listFields(
                requestTask.source,
                mapping.sourceObject,
                { signal: probeController.signal },
              );
              let targetFields: DataSyncFieldMetadata[] = [];
              if (requestTask.kind === 'cdc' && mapping.targetObject.trim()) {
                try {
                  targetFields = await gateway.listFields(
                    requestTask.target,
                    mapping.targetObject,
                    { signal: probeController.signal },
                  );
                } catch (error) {
                  if (
                    probeController.signal.aborted ||
                    isWebRPCAbortError(error) ||
                    mappingProbeEpochRef.current !== probeEpoch
                  ) {
                    return;
                  }
                  targetFields = [];
                }
              }
              metadataByMappingId.set(mapping.id, {
                keyColumns: sourceFields
                  .filter((field) => field.key)
                  .sort((left, right) => left.ordinal - right.ordinal)
                  .map((field) => field.name),
                sourceFields,
                targetFields,
                targetObject: mapping.targetObject,
              });
            } catch (error) {
              if (
                probeController.signal.aborted ||
                isWebRPCAbortError(error) ||
                mappingProbeEpochRef.current !== probeEpoch
              ) {
                return;
              }
              metadataByMappingId.set(mapping.id, {
                keyColumns: [],
                sourceFields: [],
                targetFields: [],
                targetObject: mapping.targetObject,
              });
            } finally {
              completedCount += 1;
              if (
                completedCount === addedMappings.length ||
                completedCount - publishedCount >= progressStride
              ) {
                publishedCount = completedCount;
                setMappingProbe((current) =>
                  current?.epoch === probeEpoch
                    ? {
                        ...current,
                        completed: Math.min(current.total, completedCount),
                      }
                    : current,
                );
              }
            }
          }
        },
      );
      await Promise.all(workers);
      if (mappingProbeAbortRef.current === probeController) {
        mappingProbeAbortRef.current = null;
      }
      if (
        probeController.signal.aborted ||
        mappingProbeEpochRef.current !== probeEpoch
      ) {
        return;
      }

      const currentTask = currentTaskRef.current;
      const currentSourceScope = JSON.stringify([
        currentTask.source.connectionId,
        currentTask.source.type,
        currentTask.source.database,
        currentTask.source.schema,
      ]);
      const currentTargetScope = JSON.stringify([
        currentTask.target.connectionId,
        currentTask.target.type,
        currentTask.target.database,
        currentTask.target.schema,
      ]);
      if (
        currentTask.id !== requestTask.id ||
        currentTask.kind !== requestTask.kind ||
        currentSourceScope !== requestSourceScope ||
        currentTargetScope !== requestTargetScope
      ) {
        setMappingProbe((current) =>
          current?.epoch === probeEpoch ? null : current,
        );
        return;
      }

      onPatch((latestTask) => ({
        mappings: latestTask.mappings.map((mapping) => {
          const detected = metadataByMappingId.get(mapping.id);
          if (!detected) return mapping;
          const sameTarget =
            detected.targetObject.trim().toLowerCase() ===
            mapping.targetObject.trim().toLowerCase();
          return {
            ...mapping,
            keyColumns:
              mapping.keyColumns.length > 0
                ? mapping.keyColumns
                : detected.keyColumns,
            fields:
              requestTask.kind === 'cdc' &&
              sameTarget &&
              mapping.fields.length === 0 &&
              detected.sourceFields.length > 0 &&
              detected.targetFields.length > 0
                ? autoMatchDataSyncFields(
                    mapping.id,
                    detected.sourceFields,
                    detected.targetFields,
                    mapping.fields,
                  )
                : mapping.fields,
          };
        }),
      }));
    };
    void detectInBackground();
  };

  const mappingProbeRunning = Boolean(
    mappingProbe?.taskId === task.id && mappingProbe.completed < mappingProbe.total,
  );
  const editEndpoints = () => {
    const endpointStageButton = stageNavRef.current?.querySelector<HTMLButtonElement>(
      'button[data-stage="endpoints"]',
    );
    onStageChange('endpoints');
    endpointStageButton?.focus();
  };

  const moveStageFromKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const targetIndex =
      event.key === 'ArrowRight'
        ? Math.min(DATA_SYNC_TASK_STAGES.length - 1, currentIndex + 1)
        : event.key === 'ArrowLeft'
          ? Math.max(0, currentIndex - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? DATA_SYNC_TASK_STAGES.length - 1
              : -1;
    if (targetIndex < 0) return;

    event.preventDefault();
    const targetStage = DATA_SYNC_TASK_STAGES[targetIndex];
    onStageChange(targetStage);
    stageNavRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-stage="${targetStage}"]`)
      ?.focus();
  };

  return (
  <div className="gn-data-sync-task-editor" data-data-sync-task-editor="true">
    <nav
      ref={stageNavRef}
      className="gn-data-sync-stage-nav"
      aria-label={t('workbench.task_steps')}
    >
      {DATA_SYNC_TASK_STAGES.map((stage, index) => {
        const issues = navigationIssues.filter((issue) => issue.stage === stage);
        const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
        const warnings = issues.filter((issue) => issue.severity === 'warning').length;
        const isFutureStage = index > DATA_SYNC_TASK_STAGES.indexOf(activeStage);
        const status =
          stage === 'preflight'
            ? preflightStale
              ? 'warning'
              : !preflight
                ? 'pending'
                : preflight.status === 'passed'
                  ? 'ready'
                  : preflight.status
            : blockers > 0
              ? 'blocked'
              : warnings > 0
                ? 'warning'
                : isFutureStage
                  ? 'pending'
                  : 'ready';
        const statusLabel =
          stage === 'preflight' && preflightStale
            ? t('preflight.stale')
            : status === 'ready'
              ? stage === 'preflight'
                ? t('preflight.passed')
                : t('workbench.stage_ready')
              : status === 'blocked'
                ? t('preflight.blocked', { count: blockers || 1 })
                : status === 'warning'
                  ? t('preflight.warning', { count: warnings || 1 })
                  : stage === 'preflight'
                    ? t('preflight.not_run')
                    : t('workbench.stage_pending');
        return (
          <button
            key={stage}
            type="button"
            data-stage={stage}
            data-active={stage === activeStage ? 'true' : 'false'}
            data-status={status}
            aria-current={stage === activeStage ? 'step' : undefined}
            aria-label={`${t(`stage.${stage}`)} · ${statusLabel}`}
            title={statusLabel}
            onClick={() => onStageChange(stage)}
            onKeyDown={(event) => moveStageFromKeyboard(event, index)}
          >
            <span className="gn-data-sync-stage-nav__node" aria-hidden="true">
              {status === 'ready' ? '✓' : index + 1}
            </span>
            <span className="gn-data-sync-stage-nav__label">
              <span className="gn-data-sync-stage-nav__label-full">
                {t(`stage.${stage}`)}
              </span>
              <span className="gn-data-sync-stage-nav__label-short" aria-hidden="true">
                {t(`stage_short.${stage}`)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
    <div
      className="gn-data-sync-task-editor__body"
      data-data-sync-stage-content="true"
    >
      {activeStage !== 'endpoints' ? (
        <DataSyncRouteBar
          source={task.source}
          target={task.target}
          capability={capability}
          t={t}
          onEditEndpoints={editEndpoints}
        />
      ) : null}
      {activeStage === 'endpoints' ? (
        <EndpointStage
          task={task}
          gateway={gateway}
          connectionTree={connectionTree}
          t={t}
          onPatch={onPatch}
        />
      ) : null}
      {activeStage === 'mappings' ? (
        <>
          {mappingProbe?.taskId === task.id ? (
            <div
              className="gn-data-sync-mapping-probe"
              data-mapping-probe={
                mappingProbe.completed >= mappingProbe.total ? 'complete' : 'running'
              }
              role="status"
              aria-live="polite"
            >
              <span>
                {t(
                  mappingProbe.completed >= mappingProbe.total
                    ? 'mapping.probe_complete'
                    : 'mapping.probe_running',
                )}
              </span>
              <strong>
                {t('mapping.probe_progress', {
                  completed: mappingProbe.completed,
                  total: mappingProbe.total,
                })}
              </strong>
            </div>
          ) : null}
          <DataSyncMappingTable
            key={task.id}
            mappings={task.mappings}
            taskKind={task.kind}
            sourceObjects={sourceObjects}
            targetObjects={targetObjects}
            endpointsReady={Boolean(
              task.source.connectionId.trim() && task.target.connectionId.trim(),
            )}
            selectionBusy={mappingProbeRunning}
            t={t}
            onAdd={() =>
              onPatch({
                mappings: [
                  ...task.mappings,
                  createDataSyncTableMapping(
                    `${task.id}:mapping:${task.mappings.length + 1}:${task.editEpoch + 1}`,
                  ),
                ],
              })
            }
            onAddMany={addSelectedObjects}
            onChange={changeMapping}
            onRemove={(mappingId) =>
              onPatch({
                mappings: task.mappings.filter((mapping) => mapping.id !== mappingId),
              })
            }
            onInspectFields={setInspectedMappingId}
          />
          {inspectedMapping ? (
            <DataSyncFieldMappingEditor
              gateway={gateway}
              source={task.source}
              target={task.target}
              mapping={inspectedMapping}
              t={t}
              onChange={changeMapping}
              onClose={() => setInspectedMappingId('')}
            />
          ) : null}
        </>
      ) : null}
      {activeStage === 'delivery' ? (
        <DeliveryStage
          task={task}
          capability={capability}
          t={t}
          onPatch={onPatch}
        />
      ) : null}
      {activeStage === 'trigger' ? (
        <TriggerStage
          task={task}
          gateway={gateway}
          capability={capability}
          t={t}
          onPatch={onPatch}
        />
      ) : null}
      {activeStage === 'preflight' ? (
        preflightContent || (
          <PreflightStage
            task={task}
            snapshot={preflight}
            stale={preflightStale}
            t={t}
            onLocate={onStageChange}
          />
        )
      ) : null}
    </div>
  </div>
  );
};
