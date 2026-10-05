import {
  type DataSyncTableMapping,
  type DataSyncCompareMode,
  type DataSyncColumnStructureDiff,
  type DataSyncTaskLifecycle,
  type DataSyncTaskDefinition,
  DATA_SYNC_TASK_SCHEMA_VERSION,
} from './model';
import {
  record,
  string,
  optionalString,
  enumValue,
  optionalBoolean,
  array,
  isRecord,
  rawJSONText,
  boolean,
  fromMillis,
  number,
  DataSyncGatewayProtocolError,
  optionalNumber,
} from './wailsDtoPrimitives';
import { qualifiedObject } from './dataSyncMappingKey';

const endpointFromWire = (value: unknown, path: string) => {
  const endpoint = record(value, path);
  return {
    connectionId: string(endpoint.connectionId, `${path}.connectionId`),
    connectionName: optionalString(endpoint.connectionName, `${path}.connectionName`),
    type: optionalString(endpoint.connectionType, `${path}.connectionType`),
    database: optionalString(endpoint.database, `${path}.database`),
    schema: optionalString(endpoint.schema, `${path}.schema`),
  };
};

const TARGET_STRATEGIES = [
  '',
  'existing_only',
  'auto_create_if_missing',
  'smart',
] as const;

const tableMappingFromWire = (
  value: unknown,
  path: string,
  taskId: string,
  index: number,
): DataSyncTableMapping => {
  const mapping = record(value, path);
  const sourceSchema = optionalString(mapping.sourceSchema, `${path}.sourceSchema`);
  const sourceTable = string(mapping.sourceTable, `${path}.sourceTable`);
  const targetSchema = optionalString(mapping.targetSchema, `${path}.targetSchema`);
  const targetTable = string(mapping.targetTable, `${path}.targetTable`);
  const strategy = enumValue(
    mapping.targetTableStrategy ?? '',
    TARGET_STRATEGIES,
    `${path}.targetTableStrategy`,
  );
  const strategyExplicit = optionalBoolean(
    mapping.targetTableStrategyExplicit,
    `${path}.targetTableStrategyExplicit`,
    false,
  );
  const columns = array(mapping.columns ?? [], `${path}.columns`).map(
    (item, columnIndex) => {
      const column = record(item, `${path}.columns[${columnIndex}]`);
      const transform = isRecord(column.transform) ? column.transform : {};
      const kind = optionalString(
        transform.kind,
        `${path}.columns[${columnIndex}].transform.kind`,
      );
      return {
        id: `${taskId || 'job'}:mapping:${index + 1}:field:${columnIndex + 1}`,
        sourceField: optionalString(
          column.source,
          `${path}.columns[${columnIndex}].source`,
        ),
        targetField: string(
          column.target,
          `${path}.columns[${columnIndex}].target`,
          false,
        ),
        sourceType: '',
        targetType: '',
        transform: kind === 'identity' ? '' : kind,
        transformArgument: rawJSONText(
          transform.argument,
          `${path}.columns[${columnIndex}].transform.argument`,
        ),
        nullable: !optionalBoolean(
          column.required,
          `${path}.columns[${columnIndex}].required`,
        ),
      };
    },
  );
  const keys = array(mapping.keyColumns ?? [], `${path}.keyColumns`).map((item, keyIndex) =>
    string(item, `${path}.keyColumns[${keyIndex}]`, false),
  );
  const watermark = isRecord(mapping.watermark)
    ? {
        column: string(mapping.watermark.column, `${path}.watermark.column`, false),
        tieBreaker: array(
          mapping.watermark.tieBreakerColumns ?? [],
          `${path}.watermark.tieBreakerColumns`,
        )
          .map((item, tieIndex) =>
            string(
              item,
              `${path}.watermark.tieBreakerColumns[${tieIndex}]`,
              false,
            ),
          )
          .join(', '),
      }
    : undefined;
  return {
    id: `${taskId || 'job'}:mapping:${index + 1}`,
    enabled: boolean(mapping.enabled, `${path}.enabled`),
    sourceObject: qualifiedObject(sourceSchema, sourceTable),
    targetObject: qualifiedObject(targetSchema, targetTable),
    targetMode: strategy === 'existing_only' ? 'existing_only' : 'create_or_reuse',
    targetModeExplicit: strategyExplicit,
    keyColumns: keys,
    ...(watermark ? { watermark } : {}),
    fields: columns,
  };
};

const WRITE_MODES = ['insert_only', 'insert_update', 'full_overwrite'] as const;
const ERROR_POLICIES = ['stop', 'skip_row'] as const;
export const COMPARE_MODES = [
  'data',
  'schema',
  'both',
] as const satisfies readonly DataSyncCompareMode[];
// satisfies keeps this in sync with the model: dropping a kind from the union
// without dropping it here becomes a compile error.
export const COLUMN_STRUCTURE_DIFF_KINDS = [
  'missing_in_target',
  'extra_in_target',
  'type',
  'nullable',
] as const satisfies readonly DataSyncColumnStructureDiff['kind'][];
const LIFECYCLES: readonly DataSyncTaskLifecycle[] = [
  'draft',
  'ready',
  'enabled',
  'paused',
  'archived',
];

const scheduleFromWire = (
  value: unknown,
  concurrencyPolicy: 'forbid' | 'queue',
): DataSyncTaskDefinition['trigger'] => {
  const schedule = record(value, 'job.schedule');
  const kind = enumValue(
    schedule.kind,
    ['manual', 'once', 'interval', 'cron', 'continuous'] as const,
    'job.schedule.kind',
  );
  const timezone = optionalString(schedule.timezone, 'job.schedule.timezone') || 'Local';
  if (kind === 'once') {
    return { mode: 'once', runAt: fromMillis(schedule.runAt, 'job.schedule.runAt'), timezone };
  }
  if (kind === 'interval') {
    return {
      mode: 'interval',
      intervalSeconds: number(schedule.intervalSeconds, 'job.schedule.intervalSeconds'),
      timezone,
    };
  }
  if (kind === 'cron') {
    return {
      mode: 'cron',
      expression: string(schedule.cronExpression, 'job.schedule.cronExpression'),
      timezone,
      overlap: concurrencyPolicy === 'queue' ? 'queue' : 'skip',
    };
  }
  return { mode: kind };
};

export const decodeDataSyncJobDefinition = (
  value: unknown,
): DataSyncTaskDefinition => {
  const job = record(value, 'job');
  const version = number(job.version, 'job.version');
  if (version !== DATA_SYNC_TASK_SCHEMA_VERSION) {
    throw new DataSyncGatewayProtocolError('job.version', `unsupported version ${version}`);
  }
  const id = string(job.id, 'job.id', false);
  const kind = enumValue(
    job.kind,
    ['migration', 'reconcile', 'query_sink', 'compare', 'backup'] as const,
    'job.kind',
  );
  const incrementalMode = enumValue(
    job.incrementalMode,
    ['snapshot', 'watermark', 'cdc'] as const,
    'job.incrementalMode',
  );
  const concurrencyPolicy = enumValue(
    job.concurrencyPolicy,
    ['forbid', 'queue'] as const,
    'job.concurrencyPolicy',
  );
  const resumePolicy = enumValue(
    job.resumePolicy,
    ['never', 'manual', 'auto'] as const,
    'job.resumePolicy',
  );
  const source = endpointFromWire(job.source, 'job.source');
  const target = endpointFromWire(job.target, 'job.target');
  const mappings = array(job.mappings, 'job.mappings').map((mapping, index) =>
    tableMappingFromWire(mapping, `job.mappings[${index}]`, id, index),
  );
  const options = record(job.options, 'job.options');
  const syncMode = enumValue(options.syncMode, WRITE_MODES, 'job.options.syncMode');
  const errorPolicy = enumValue(
    options.errorPolicy,
    ERROR_POLICIES,
    'job.options.errorPolicy',
  );
  const content = enumValue(
    optionalString(options.content, 'job.options.content') || 'data',
    ['schema', 'data', 'both'] as const,
    'job.options.content',
  );
  const uiKind = incrementalMode === 'cdc' ? 'cdc' : kind === 'query_sink' ? 'querySink' : kind;
  let incremental: DataSyncTaskDefinition['incremental'];
  if (incrementalMode === 'watermark') {
    const specs = mappings
      .filter((mapping) => mapping.enabled && mapping.watermark)
      .map((mapping) => mapping.watermark!);
    const first = specs[0] || { column: '', tieBreaker: '' };
    incremental = {
      mode: 'watermark',
      column: first.column,
      tieBreaker: first.tieBreaker,
      overlapWindowMs: 0,
    };
  } else if (incrementalMode === 'cdc') {
    const cdc = record(job.cdc, 'job.cdc');
    incremental = {
      mode: 'cdc',
      initialSnapshot: optionalBoolean(
        cdc.initialSnapshot,
        'job.cdc.initialSnapshot',
        false,
      ),
      startPosition: enumValue(
        cdc.startPosition || 'latest',
        ['latest', 'earliest', 'checkpoint'] as const,
        'job.cdc.startPosition',
      ),
      // Adapter selection is server-owned and draft/legacy jobs may not have
      // been preflighted yet, so the persisted wire shape legitimately omits it.
      adapter: optionalString(cdc.adapter, 'job.cdc.adapter'),
      slotName: optionalString(cdc.slotName, 'job.cdc.slotName'),
      publicationName: optionalString(cdc.publicationName, 'job.cdc.publicationName'),
    };
  } else {
    incremental = { mode: 'snapshot' };
  }
  const lifecycle = enumValue(job.lifecycle, LIFECYCLES, 'job.lifecycle');
  return {
    schemaVersion: DATA_SYNC_TASK_SCHEMA_VERSION,
    id,
    revision: number(job.revision, 'job.revision'),
    editEpoch: 0,
    name: string(job.name, 'job.name'),
    kind: uiKind,
    lifecycle,
    content:
      kind === 'migration'
        ? enumValue(content, ['schema', 'data', 'both'] as const, 'job.options.content')
        : undefined,
    compareMode:
      kind === 'compare'
        ? content
        : undefined,
    backup: kind === 'backup' && isRecord(job.backup) ? { directory: optionalString(job.backup.directory, 'job.backup.directory'), content: enumValue(job.backup.content, ['schema', 'data', 'both'] as const, 'job.backup.content') } : undefined,
    sourceMode: kind === 'query_sink' ? 'query' : 'tables',
    sourceQuery: optionalString(job.sourceQuery, 'job.sourceQuery'),
    source,
    target,
    mappings,
    delivery: {
      writeMode:
        (kind === 'compare' || kind === 'backup')
          ? 'none'
          : syncMode === 'insert_only'
            ? 'append'
            : syncMode === 'full_overwrite'
              ? 'overwrite'
              : 'upsert',
      errorPolicy:
        errorPolicy === 'stop'
          ? 'stop'
          : optionalBoolean(options.captureErrorPayload, 'job.options.captureErrorPayload')
            ? 'quarantine'
            : 'skip',
      batchSize: number(options.batchSize, 'job.options.batchSize'),
      commitEvery: number(options.batchSize, 'job.options.batchSize'),
      retryLimit: optionalNumber(options.maxRetries, 'job.options.maxRetries'),
      retryBackoffMs: optionalNumber(
        options.retryBackoffMillis,
        'job.options.retryBackoffMillis',
        500,
      ),
      propagateDeletes: optionalBoolean(
        options.propagateDeletes,
        'job.options.propagateDeletes',
      ),
      autoAddColumns: optionalBoolean(
        options.autoAddColumns,
        'job.options.autoAddColumns',
        kind === 'migration' && (content === 'schema' || content === 'both'),
      ),
      createIndexes: optionalBoolean(options.createIndexes, 'job.options.createIndexes'),
      captureErrorPayload: optionalBoolean(
        options.captureErrorPayload,
        'job.options.captureErrorPayload',
      ),
    },
    trigger: scheduleFromWire(job.schedule, concurrencyPolicy),
    incremental,
    concurrencyPolicy,
    resumePolicy,
    createdAt: fromMillis(job.createdAt, 'job.createdAt'),
    updatedAt: fromMillis(job.updatedAt, 'job.updatedAt'),
  };
};
