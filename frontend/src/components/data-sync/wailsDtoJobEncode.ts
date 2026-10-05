import {
  type DataSyncTaskDefinition,
  type DataSyncTableMapping,
  canUseDataSyncRowErrorIsolation,
  DATA_SYNC_TASK_SCHEMA_VERSION,
} from './model';
import {
  DataSyncGatewayProtocolError,
  toRawJSON,
  isRecord,
  toMillis,
  optionalString,
} from './wailsDtoPrimitives';
import { splitQualifiedObject } from './dataSyncMappingKey';

export type WailsDataSyncJobDefinition = Record<string, unknown>;

const TRANSFORMS = new Set([
  '',
  'identity',
  'trim',
  'lower',
  'upper',
  'string',
  'int64',
  'bool',
  'date',
  'timestamp',
  'json',
]);

const tableMappingToWire = (
  task: DataSyncTaskDefinition,
  mapping: DataSyncTableMapping,
  index: number,
): Record<string, unknown> => {
  const source = splitQualifiedObject(mapping.sourceObject, task.source.schema);
  const target = splitQualifiedObject(mapping.targetObject, task.target.schema);
  return {
    sourceSchema: source.schema,
    sourceTable: source.name,
    targetSchema: target.schema,
    targetTable: target.name,
    targetTableStrategy:
      mapping.targetMode === 'existing_only' ? 'existing_only' : 'smart',
    ...(mapping.targetModeExplicit === true
      ? { targetTableStrategyExplicit: true }
      : {}),
    keyColumns: mapping.keyColumns,
    columns: mapping.fields.map((field, fieldIndex) => {
      const kind = field.transform.trim().toLowerCase();
      if (!TRANSFORMS.has(kind)) {
        throw new DataSyncGatewayProtocolError(
          `task.mappings[${index}].fields[${fieldIndex}].transform`,
          `unsupported transform ${field.transform}`,
        );
      }
      const argument = toRawJSON(
        field.transformArgument || '',
        `task.mappings[${index}].fields[${fieldIndex}].transformArgument`,
      );
      if (argument !== undefined && !isRecord(argument)) {
        throw new DataSyncGatewayProtocolError(
          `task.mappings[${index}].fields[${fieldIndex}].transformArgument`,
          'transform argument must be a JSON object',
        );
      }
      return {
        source: field.sourceField,
        target: field.targetField,
        transform: {
          kind: kind || 'identity',
          ...(argument === undefined ? {} : { argument }),
        },
        required: !field.nullable,
      };
    }),
    ...(task.incremental.mode === 'watermark'
      ? {
          watermark: {
            column: mapping.watermark?.column || task.incremental.column,
            tieBreakerColumns: (mapping.watermark?.tieBreaker || task.incremental.tieBreaker)
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          },
        }
      : {}),
    enabled: mapping.enabled,
  };
};

const scheduleToWire = (
  task: DataSyncTaskDefinition,
): Record<string, unknown> => {
  const trigger = task.trigger;
  if (trigger.mode === 'once') {
    return {
      kind: 'once',
      runAt: toMillis(trigger.runAt),
      timezone: trigger.timezone,
      misfirePolicy: 'skip',
    };
  }
  if (trigger.mode === 'interval') {
    return {
      kind: 'interval',
      intervalSeconds: trigger.intervalSeconds,
      timezone: trigger.timezone,
      misfirePolicy: 'skip',
    };
  }
  if (trigger.mode === 'cron') {
    return {
      kind: 'cron',
      cronExpression: trigger.expression,
      timezone: trigger.timezone,
      misfirePolicy: 'skip',
    };
  }
  return { kind: trigger.mode, timezone: 'Local', misfirePolicy: 'skip' };
};

export const isLocalDataSyncTaskId = (taskId: string): boolean =>
  taskId.startsWith('data-sync-local-');

export const encodeDataSyncJobDefinition = (
  task: DataSyncTaskDefinition,
  previous?: WailsDataSyncJobDefinition,
): WailsDataSyncJobDefinition => {
  if (task.kind !== 'compare' && task.kind !== 'backup' && task.delivery.writeMode === 'none') {
    throw new DataSyncGatewayProtocolError(
      'task.delivery.writeMode',
      'a writable data sync task requires an explicit delivery mode',
    );
  }
  if (
    task.delivery.errorPolicy !== 'stop' &&
    !canUseDataSyncRowErrorIsolation(task)
  ) {
    throw new DataSyncGatewayProtocolError(
      'task.delivery.errorPolicy',
      'row isolation requires a data-only snapshot/query or CDC task, existing targets, atomic SQL writes, and no schema/delete side effects',
    );
  }
  if (task.delivery.writeMode === 'append' && task.delivery.retryLimit !== 0) {
    throw new DataSyncGatewayProtocolError(
      'task.delivery.retryLimit',
      'append mode requires retryLimit 0 to avoid duplicate writes',
    );
  }
  if (
    task.incremental.mode === 'watermark' &&
    task.delivery.writeMode === 'append'
  ) {
    throw new DataSyncGatewayProtocolError(
      'task.delivery.writeMode',
      'watermark append requires delivery semantics that are not implemented',
    );
  }
  if (
    task.kind === 'cdc' &&
    task.incremental.mode === 'cdc' &&
    (task.incremental.initialSnapshot || task.incremental.startPosition === 'earliest')
  ) {
    throw new DataSyncGatewayProtocolError(
      'task.incremental',
      'CDC initial snapshot and earliest position are not supported safely',
    );
  }
  const previousSource = isRecord(previous?.source) ? previous?.source : {};
  const previousTarget = isRecord(previous?.target) ? previous?.target : {};
  const kind = task.kind === 'querySink' ? 'query_sink' : task.kind === 'cdc' ? 'reconcile' : task.kind;
  const incrementalMode = task.kind === 'cdc' ? 'cdc' : task.incremental.mode;
  const syncMode =
    task.delivery.writeMode === 'append'
      ? 'insert_only'
      : task.delivery.writeMode === 'overwrite'
        ? 'full_overwrite'
        : 'insert_update';
  const targetTableStrategy = task.mappings.some(
    (mapping) => mapping.targetMode === 'create_or_reuse',
  )
    ? 'smart'
    : 'existing_only';
  return {
    version: DATA_SYNC_TASK_SCHEMA_VERSION,
    id: isLocalDataSyncTaskId(task.id) ? '' : task.id,
    name: task.name,
    description: optionalString(previous?.description, 'previous.description'),
    lifecycle: task.lifecycle,
    enabled: task.lifecycle === 'enabled',
    kind,
    incrementalMode,
    source: {
      connectionId: task.source.connectionId,
      connectionType: task.source.type,
      connectionName: task.source.connectionName,
      database: task.source.database,
      schema: task.source.schema,
      fingerprint: optionalString(previousSource.fingerprint, 'previous.source.fingerprint'),
    },
    target: {
      connectionId: task.target.connectionId,
      connectionType: task.target.type,
      connectionName: task.target.connectionName,
      database: task.target.database,
      schema: task.target.schema,
      fingerprint: optionalString(previousTarget.fingerprint, 'previous.target.fingerprint'),
    },
    ...(task.kind === 'backup' ? { backup: task.backup } : {}),
    sourceQuery: task.kind === 'querySink' ? task.sourceQuery : '',
    mappings: task.mappings.map((mapping, index) =>
      tableMappingToWire(task, mapping, index),
    ),
    options: {
      content:
        task.kind === 'compare'
          ? task.compareMode || 'data'
          : task.kind === 'migration'
            ? task.content || 'data'
            : 'data',
      syncMode,
      targetTableStrategy,
      autoAddColumns: task.delivery.autoAddColumns,
      createIndexes: task.delivery.createIndexes,
      propagateDeletes: task.delivery.propagateDeletes,
      batchSize: task.delivery.batchSize,
      errorPolicy: task.delivery.errorPolicy === 'stop' ? 'stop' : 'skip_row',
      maxRetries: task.delivery.retryLimit,
      retryBackoffMillis: task.delivery.retryBackoffMs,
      captureErrorPayload:
        task.delivery.errorPolicy === 'quarantine' || task.delivery.captureErrorPayload,
    },
    schedule: scheduleToWire(task),
    ...(task.kind === 'cdc' && task.incremental.mode === 'cdc'
      ? {
          cdc: {
            adapter: task.incremental.adapter,
            startPosition: task.incremental.startPosition,
            initialSnapshot: false,
            slotName: task.incremental.slotName,
            publicationName: task.incremental.publicationName,
          },
        }
      : {}),
    concurrencyPolicy:
      task.trigger.mode === 'continuous'
        ? 'forbid'
        : task.trigger.mode === 'cron'
          ? task.trigger.overlap === 'queue'
            ? 'queue'
            : 'forbid'
          : task.concurrencyPolicy,
    resumePolicy: task.resumePolicy,
    revision: isLocalDataSyncTaskId(task.id) ? 0 : task.revision,
    createdAt: isLocalDataSyncTaskId(task.id) ? 0 : toMillis(task.createdAt),
    updatedAt: isLocalDataSyncTaskId(task.id) ? 0 : toMillis(task.updatedAt),
  };
};
