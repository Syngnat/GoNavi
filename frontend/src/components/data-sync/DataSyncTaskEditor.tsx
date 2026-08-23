import React, { useEffect, useRef, useState } from 'react';

import { DataSyncEndpointSelector } from './DataSyncEndpointSelector';
import { DataSyncFieldMappingEditor } from './DataSyncFieldMappingEditor';
import { DataSyncMappingTable } from './DataSyncMappingTable';
import type { DataSyncWorkbenchGateway } from './gateway';
import {
  autoMatchDataSyncFields,
  buildDataSyncMappingsFromSelection,
  createDataSyncTableMapping,
  canUseDataSyncRowErrorIsolation,
  validateDataSyncTask,
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

const STAGES: DataSyncTaskStage[] = [
  'endpoints',
  'mappings',
  'delivery',
  'trigger',
  'preflight',
];

type TaskPatch = Partial<
  Omit<DataSyncTaskDefinition, 'id' | 'schemaVersion' | 'revision' | 'createdAt'>
>;

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
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, gateway, t, onPatch }) => {
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
  const mappings = task.mappings;
  return (
    mappings.some((mapping) => mapping.enabled) &&
    mappings.every((mapping) => {
      if (
        mapping.fields.length > 0 ||
        mapping.keyColumns.some((column) => column.trim().length > 0)
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
        source.name === target.name &&
        source.schema === target.schema
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
  const canConfigureMigrationStructure =
    task.kind === 'migration' && capability.canExecute && implicitSameNameMappings;
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
      structureCapabilityResolved &&
      !canAutoAddColumns &&
      task.delivery.autoAddColumns
    ) {
      patch.autoAddColumns = false;
    }
    if (
      structureCapabilityResolved &&
      !canCreateIndexes &&
      task.delivery.createIndexes
    ) {
      patch.createIndexes = false;
    }
    if (Object.keys(patch).length > 0) {
      onPatch({ delivery: { ...task.delivery, ...patch } });
    }
  }, [
    canAutoAddColumns,
    canCreateIndexes,
    canPropagateDeletes,
    appendOnlyTarget,
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
  t: DataSyncWorkbenchTranslate;
  onPatch: (patch: TaskPatch) => void;
}> = ({ task, gateway, t, onPatch }) => {
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
  const [cdcAdapters, setCdcAdapters] = useState<string[]>([]);
  const [cdcMetadataState, setCdcMetadataState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [checkpointAvailable, setCheckpointAvailable] = useState(false);

  useEffect(() => {
    if (incremental.mode !== 'cdc') {
      setCdcMetadataState('idle');
      setCdcAdapters([]);
      setCheckpointAvailable(false);
      return undefined;
    }
    let active = true;
    setCdcMetadataState('loading');
    void Promise.all([
      gateway.listCdcAdapters(),
      gateway.getCheckpoint(task.id),
    ])
      .then(([adapters, checkpoint]) => {
        if (!active) return;
        setCdcAdapters(adapters);
        setCheckpointAvailable(Boolean(checkpoint));
        setCdcMetadataState('ready');
      })
      .catch(() => {
        if (!active) return;
        setCdcAdapters([]);
        setCheckpointAvailable(false);
        setCdcMetadataState('error');
      });
    return () => {
      active = false;
    };
  }, [gateway, incremental.mode, task.id]);
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
            <select
              className="gn-data-sync-control"
              value={incremental.adapter}
              disabled={cdcMetadataState === 'loading'}
              onChange={(event) =>
                onPatch({
                  incremental: { ...incremental, adapter: event.target.value },
                })
              }
            >
              <option value="">
                {cdcMetadataState === 'loading'
                  ? t('metadata.loading_cdc_adapters')
                  : t('incremental.select_cdc_adapter')}
              </option>
              {cdcAdapters.map((adapter) => (
                <option key={adapter} value={adapter}>{adapter}</option>
              ))}
            </select>
          </Field>
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
  const issues = !stale && snapshot ? snapshot.issues : validateDataSyncTask(task);
  return (
    <section className="gn-data-sync-section" data-data-sync-preflight-stage="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('preflight.title')}</h2>
          <p>{stale ? t('preflight.stale') : t('preflight.empty')}</p>
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
          <li data-severity="info">{t('preflight.passed')}</li>
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
  capability: DataSyncRouteCapability;
  activeStage: DataSyncTaskStage;
  preflight: DataSyncPreflightSnapshot | null;
  preflightStale: boolean;
  t: DataSyncWorkbenchTranslate;
  onStageChange: (stage: DataSyncTaskStage) => void;
  onPatch: (patch: TaskPatch) => void;
}> = ({
  task,
  gateway,
  capability,
  activeStage,
  preflight,
  preflightStale,
  t,
  onStageChange,
  onPatch,
}) => {
  const sourceObjects = useDataSyncObjects(gateway, task.source);
  const targetObjects = useDataSyncObjects(gateway, task.target);
  const currentTaskRef = useRef(task);
  currentTaskRef.current = task;
  const [inspectedMappingId, setInspectedMappingId] = useState('');
  const inspectedMapping =
    task.mappings.find((mapping) => mapping.id === inspectedMappingId) || null;

  useEffect(() => {
    setInspectedMappingId('');
  }, [task.id]);

  useEffect(() => {
    if (inspectedMappingId && !inspectedMapping) setInspectedMappingId('');
  }, [inspectedMapping, inspectedMappingId]);

  const changeMapping = (mapping: DataSyncTableMapping) =>
    onPatch({ mappings: updateMapping(task, mapping) });

  const addSelectedObjects = async (sourceNames: string[]) => {
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
    let mappings = buildMappings(requestTask.mappings);
    if (requestTask.kind !== 'reconcile' && requestTask.kind !== 'cdc') {
      onPatch({ mappings });
      return;
    }

    const selectedSources = new Set(
      sourceNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
    );
    const addedMappings = mappings.filter((mapping) =>
      selectedSources.has(mapping.sourceObject.trim().toLowerCase()),
    );
    type DetectedMappingMetadata = {
      keyColumns: string[];
      sourceFields: DataSyncFieldMetadata[];
      targetFields: DataSyncFieldMetadata[];
      targetObject: string;
    };
    const metadataBySource = new Map<string, DetectedMappingMetadata>();
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(4, addedMappings.length) },
      async () => {
        while (cursor < addedMappings.length) {
          const index = cursor;
          cursor += 1;
          const mapping = addedMappings[index];
          try {
            const sourceFields = await gateway.listFields(
              requestTask.source,
              mapping.sourceObject,
            );
            let targetFields: DataSyncFieldMetadata[] = [];
            if (requestTask.kind === 'cdc' && mapping.targetObject.trim()) {
              try {
                targetFields = await gateway.listFields(
                  requestTask.target,
                  mapping.targetObject,
                );
              } catch {
                targetFields = [];
              }
            }
            metadataBySource.set(mapping.sourceObject.trim().toLowerCase(), {
              keyColumns: sourceFields
                .filter((field) => field.key)
                .sort((left, right) => left.ordinal - right.ordinal)
                .map((field) => field.name),
              sourceFields,
              targetFields,
              targetObject: mapping.targetObject,
            });
          } catch {
            metadataBySource.set(mapping.sourceObject.trim().toLowerCase(), {
              keyColumns: [],
              sourceFields: [],
              targetFields: [],
              targetObject: mapping.targetObject,
            });
          }
        }
      },
    );
    await Promise.all(workers);

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
      return;
    }

    mappings = buildMappings(currentTask.mappings).map((mapping) => {
      const detected = metadataBySource.get(
        mapping.sourceObject.trim().toLowerCase(),
      );
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
    });
    onPatch({ mappings });
  };

  return (
  <div className="gn-data-sync-task-editor" data-data-sync-task-editor="true">
    <nav className="gn-data-sync-stage-nav" aria-label={t('preflight.title')}>
      {STAGES.map((stage, index) => (
        <button
          key={stage}
          type="button"
          data-active={stage === activeStage ? 'true' : 'false'}
          onClick={() => onStageChange(stage)}
        >
          <span>{index + 1}</span>
          {t(`stage.${stage}`)}
        </button>
      ))}
    </nav>
    <div className="gn-data-sync-task-editor__body">
      {activeStage === 'endpoints' ? (
        <EndpointStage task={task} gateway={gateway} t={t} onPatch={onPatch} />
      ) : null}
      {activeStage === 'mappings' ? (
        <>
          <DataSyncMappingTable
            mappings={task.mappings}
            taskKind={task.kind}
            sourceObjects={sourceObjects}
            targetObjects={targetObjects}
            t={t}
            onAdd={() =>
              onPatch({
                mappings: [
                  ...task.mappings,
                  createDataSyncTableMapping(
                    `${task.id}:mapping:${task.mappings.length + 1}:${task.revision + 1}`,
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
        <TriggerStage task={task} gateway={gateway} t={t} onPatch={onPatch} />
      ) : null}
      {activeStage === 'preflight' ? (
        <PreflightStage
          task={task}
          snapshot={preflight}
          stale={preflightStale}
          t={t}
          onLocate={onStageChange}
        />
      ) : null}
    </div>
  </div>
  );
};
