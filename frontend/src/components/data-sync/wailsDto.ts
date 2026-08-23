import {
  DATA_SYNC_TASK_SCHEMA_VERSION,
  canUseDataSyncRowErrorIsolation,
  type DataSyncCdcSourceStatus,
  type DataSyncCheckpointSummary,
  type DataSyncDatabaseMetadata,
  type DataSyncErrorRow,
  type DataSyncFieldMetadata,
  type DataSyncObjectMetadata,
  type DataSyncIndexColumn,
  type DataSyncPreflightSnapshot,
  type DataSyncRouteCapability,
  type DataSyncRunRecord,
  type DataSyncSavedConnectionView,
  type DataSyncScheduleSummary,
  type DataSyncTableMapping,
  type DataSyncTaskDefinition,
  type DataSyncTaskLifecycle,
  type DataSyncUnmigratedIndex,
  type DataSyncValidationCode,
  type DataSyncValidationIssue,
} from './model';

export type WailsQueryResultLike = {
  success?: unknown;
  message?: unknown;
  data?: unknown;
};

export type WailsDataSyncJobDefinition = Record<string, unknown>;

export class DataSyncGatewayProtocolError extends Error {
  constructor(operation: string, detail: string) {
    super(`${operation}: ${detail}`);
    this.name = 'DataSyncGatewayProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new DataSyncGatewayProtocolError(path, 'expected object');
  return value;
};

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) throw new DataSyncGatewayProtocolError(path, 'expected array');
  return value;
};

const string = (value: unknown, path: string, allowEmpty = true): string => {
  if (typeof value !== 'string') {
    throw new DataSyncGatewayProtocolError(path, 'expected string');
  }
  if (!allowEmpty && !value.trim()) {
    throw new DataSyncGatewayProtocolError(path, 'expected non-empty string');
  }
  return value;
};

const optionalString = (value: unknown, path: string): string =>
  value === undefined || value === null ? '' : string(value, path);

const number = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataSyncGatewayProtocolError(path, 'expected finite number');
  }
  return value;
};

const optionalNumber = (value: unknown, path: string, fallback = 0): number =>
  value === undefined || value === null ? fallback : number(value, path);

const optionalMetadataNumber = (
  value: unknown,
  path: string,
): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const decoded =
    typeof value === 'string' && value.trim()
      ? Number(value)
      : number(value, path);
  if (!Number.isFinite(decoded) || decoded < 0 || !Number.isSafeInteger(decoded)) {
    throw new DataSyncGatewayProtocolError(
      path,
      'expected non-negative safe integer',
    );
  }
  return decoded;
};

const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new DataSyncGatewayProtocolError(path, 'expected boolean');
  }
  return value;
};

const optionalBoolean = (
  value: unknown,
  path: string,
  fallback = false,
): boolean => (value === undefined || value === null ? fallback : boolean(value, path));

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T => {
  const decoded = string(value, path);
  if (!allowed.includes(decoded as T)) {
    throw new DataSyncGatewayProtocolError(path, `unsupported value ${decoded}`);
  }
  return decoded as T;
};

const fromMillis = (value: unknown, path: string): string => {
  const millis = optionalNumber(value, path);
  if (millis <= 0) return '';
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) {
    throw new DataSyncGatewayProtocolError(path, 'invalid timestamp');
  }
  return date.toISOString();
};

const toMillis = (value: string): number => {
  if (!value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const rawJSONText = (value: unknown, path: string): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    if (!value.trim()) return '';
    try {
      JSON.parse(value);
      return value;
    } catch {
      throw new DataSyncGatewayProtocolError(path, 'invalid JSON string');
    }
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    try {
      const decoded = new TextDecoder().decode(new Uint8Array(value as number[]));
      JSON.parse(decoded);
      return decoded;
    } catch {
      throw new DataSyncGatewayProtocolError(path, 'invalid JSON bytes');
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new DataSyncGatewayProtocolError(path, 'JSON value is not serializable');
  }
};

const toRawJSON = (value: string, path: string): unknown => {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new DataSyncGatewayProtocolError(path, 'invalid JSON argument');
  }
};

export const requireWailsQueryData = (
  result: WailsQueryResultLike,
  operation: string,
): unknown => {
  const response = record(result, operation);
  if (response.success !== true) {
    const message = optionalString(response.message, `${operation}.message`).trim();
    throw new DataSyncGatewayProtocolError(operation, message || 'backend rejected request');
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
    throw new DataSyncGatewayProtocolError(operation, 'successful response omitted data');
  }
  return response.data;
};

export const requireWailsCommandSuccess = (
  result: WailsQueryResultLike,
  operation: string,
): void => {
  const response = record(result, operation);
  if (response.success !== true) {
    const message = optionalString(response.message, `${operation}.message`).trim();
    throw new DataSyncGatewayProtocolError(operation, message || 'backend rejected request');
  }
};

export const decodeSavedConnectionViews = (
  value: unknown,
): DataSyncSavedConnectionView[] =>
  array(value, 'GetSavedConnections').map((item, index) => {
    const view = record(item, `GetSavedConnections[${index}]`);
    const config = record(view.config, `GetSavedConnections[${index}].config`);
    const protection = isRecord(config.protection) ? config.protection : {};
    const readOnly = optionalBoolean(
      config.readOnly,
      `GetSavedConnections[${index}].config.readOnly`,
    );
    const restrictWrite =
      optionalBoolean(
        protection.restrictDataEdit,
        `GetSavedConnections[${index}].config.protection.restrictDataEdit`,
      ) ||
      optionalBoolean(
        protection.restrictDataImport,
        `GetSavedConnections[${index}].config.protection.restrictDataImport`,
      );
    return {
      id: string(view.id, `GetSavedConnections[${index}].id`, false),
      name: string(view.name, `GetSavedConnections[${index}].name`, false),
      type: string(config.type, `GetSavedConnections[${index}].config.type`, false),
      readable: true,
      writable: !readOnly && !restrictWrite,
    };
  });

export const decodeDatabaseMetadata = (value: unknown): DataSyncDatabaseMetadata[] =>
  array(value, 'DataSyncDatabaseList.data').map((item, index) => {
    const row = record(item, `DataSyncDatabaseList.data[${index}]`);
    const name = row.Database ?? row.database;
    return {
      name: string(name, `DataSyncDatabaseList.data[${index}].Database`, false),
    };
  });

export const decodeObjectMetadata = (
  value: unknown,
  connectionType: string,
): DataSyncObjectMetadata[] =>
  array(value, 'DataSyncObjectList.data').map((item, index) => {
    const row = record(item, `DataSyncObjectList.data[${index}]`);
    const name = row.Table ?? row.table ?? row.name;
    const rawKind = optionalString(row.type, `DataSyncObjectList.data[${index}].type`)
      .trim()
      .toLowerCase();
    const inferredKind = connectionType.toLowerCase().includes('mongo')
      ? 'collection'
      : 'table';
    const kind = rawKind === 'view' || rawKind === 'collection' ? rawKind : inferredKind;
    const rowCount = optionalMetadataNumber(
      row.Rows,
      `DataSyncObjectList.data[${index}].Rows`,
    );
    const dataBytes = optionalMetadataNumber(
      row.Data_length,
      `DataSyncObjectList.data[${index}].Data_length`,
    );
    const indexBytes = optionalMetadataNumber(
      row.Index_length,
      `DataSyncObjectList.data[${index}].Index_length`,
    );
    return {
      name: string(name, `DataSyncObjectList.data[${index}].Table`, false),
      kind,
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(dataBytes === undefined ? {} : { dataBytes }),
      ...(indexBytes === undefined ? {} : { indexBytes }),
    };
  });

export const decodeFieldMetadata = (value: unknown): DataSyncFieldMetadata[] =>
  array(value, 'DataSyncFieldList.data').map((item, index) => {
    const field = record(item, `DataSyncFieldList.data[${index}]`);
    const nullable = string(
      field.nullable,
      `DataSyncFieldList.data[${index}].nullable`,
    ).toLowerCase();
    const key = optionalString(field.key, `DataSyncFieldList.data[${index}].key`)
      .trim()
      .toUpperCase();
    return {
      name: string(field.name, `DataSyncFieldList.data[${index}].name`, false),
      type: string(field.type, `DataSyncFieldList.data[${index}].type`, false),
      nullable: nullable === 'yes' || nullable === 'true',
      ordinal: index + 1,
      key: key === 'PRI' || key === 'UNI' || key === 'PRIMARY' || key === 'UNIQUE',
    };
  });

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

const qualifiedObject = (schema: string, name: string): string =>
  schema.trim() ? `${schema.trim()}.${name.trim()}` : name.trim();

const splitQualifiedObject = (
  value: string,
  fallbackSchema: string,
): { schema: string; name: string } => {
  const normalized = value.trim();
  const separator = normalized.lastIndexOf('.');
  if (separator <= 0 || separator === normalized.length - 1) {
    return { schema: fallbackSchema.trim(), name: normalized };
  }
  return {
    schema: normalized.slice(0, separator).trim(),
    name: normalized.slice(separator + 1).trim(),
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
    keyColumns: keys,
    ...(watermark ? { watermark } : {}),
    fields: columns,
  };
};

const WRITE_MODES = ['insert_only', 'insert_update', 'full_overwrite'] as const;
const ERROR_POLICIES = ['stop', 'skip_row'] as const;
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
    ['migration', 'reconcile', 'query_sink', 'compare'] as const,
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
  const content = optionalString(options.content, 'job.options.content') || 'data';
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
      initialSnapshot: boolean(cdc.initialSnapshot, 'job.cdc.initialSnapshot'),
      startPosition: enumValue(
        cdc.startPosition || 'latest',
        ['latest', 'earliest', 'checkpoint'] as const,
        'job.cdc.startPosition',
      ),
      adapter: string(cdc.adapter, 'job.cdc.adapter'),
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
    name: string(job.name, 'job.name'),
    kind: uiKind,
    lifecycle,
    compareMode:
      kind === 'compare'
        ? enumValue(content, ['schema', 'data', 'both'] as const, 'job.options.content')
        : undefined,
    sourceMode: kind === 'query_sink' ? 'query' : 'tables',
    sourceQuery: optionalString(job.sourceQuery, 'job.sourceQuery'),
    source,
    target,
    mappings,
    delivery: {
      writeMode:
        kind === 'compare'
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
      autoAddColumns: optionalBoolean(options.autoAddColumns, 'job.options.autoAddColumns'),
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
  if (task.kind !== 'compare' && task.delivery.writeMode === 'none') {
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
    sourceQuery: task.kind === 'querySink' ? task.sourceQuery : '',
    mappings: task.mappings.map((mapping, index) =>
      tableMappingToWire(task, mapping, index),
    ),
    options: {
      content: task.kind === 'compare' ? task.compareMode || 'data' : task.kind === 'migration' ? 'both' : 'data',
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

export const decodeRouteCapability = (value: unknown): DataSyncRouteCapability => {
  const capability = record(value, 'DataSyncCapabilityResolve.data');
  const level = enumValue(
    capability.supportLevel,
    ['full', 'partial', 'planned', 'unsupported'] as const,
    'DataSyncCapabilityResolve.data.supportLevel',
  );
  return {
    level: level === 'planned' ? 'unsupported' : level,
    canExecute: boolean(capability.canExecute, 'DataSyncCapabilityResolve.data.canExecute'),
    supportsAutoCreate: boolean(
      capability.supportsAutoCreate,
      'DataSyncCapabilityResolve.data.supportsAutoCreate',
    ),
    supportsAutoAddColumns: optionalBoolean(
      capability.supportsAutoAddColumns,
      'DataSyncCapabilityResolve.data.supportsAutoAddColumns',
    ),
    requiresExistingTarget: optionalBoolean(
      capability.requiresExistingTarget,
      'DataSyncCapabilityResolve.data.requiresExistingTarget',
    ),
    supportsMutations: optionalBoolean(
      capability.supportsMutations,
      'DataSyncCapabilityResolve.data.supportsMutations',
    ),
    supportsCdc: false,
  };
};

export type DecodedDataSyncPreflight = {
  snapshot: DataSyncPreflightSnapshot;
  definition: WailsDataSyncJobDefinition;
  capability: DataSyncRouteCapability;
};

export const decodeDataSyncPreflight = (
  value: unknown,
  task: DataSyncTaskDefinition,
): DecodedDataSyncPreflight => {
  const payload = record(value, 'DataSyncJobPreflight.data');
  const status = enumValue(
    payload.status,
    ['blocked', 'warning', 'passed'] as const,
    'DataSyncJobPreflight.data.status',
  );
  const definition = record(payload.definition, 'DataSyncJobPreflight.data.definition');
  const definitionHash = optionalString(
    payload.definitionHash,
    'DataSyncJobPreflight.data.definitionHash',
  );
  if (status !== 'blocked' && !definitionHash) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobPreflight.data.definitionHash',
      'passed preflight omitted definition hash',
    );
  }
  const issues: DataSyncValidationIssue[] = array(
    payload.issues,
    'DataSyncJobPreflight.data.issues',
  ).map((item, index) => {
    const issue = record(item, `DataSyncJobPreflight.data.issues[${index}]`);
    const code = string(issue.code, `DataSyncJobPreflight.data.issues[${index}].code`, false);
    return {
      id: `${code}:${optionalString(issue.mappingId, 'issue.mappingId')}:${index}`,
      code: code as DataSyncValidationCode,
      severity: enumValue(
        issue.severity,
        ['blocker', 'warning', 'info'] as const,
        `DataSyncJobPreflight.data.issues[${index}].severity`,
      ),
      stage: enumValue(
        issue.stage,
        ['endpoints', 'mappings', 'delivery', 'trigger', 'preflight'] as const,
        `DataSyncJobPreflight.data.issues[${index}].stage`,
      ),
      mappingId: optionalString(issue.mappingId, 'issue.mappingId') || undefined,
      message: optionalString(issue.message, 'issue.message') || undefined,
      detail: isRecord(issue.detail) && issue.detail.unmigratedIndex
        ? {
            unmigratedIndex: decodeUnmigratedIndex(
              issue.detail.unmigratedIndex,
              `DataSyncJobPreflight.data.issues[${index}].detail.unmigratedIndex`,
            ),
          }
        : undefined,
    };
  });
  let capability: DataSyncRouteCapability;
  if (status === 'blocked') {
    try {
      capability = decodeRouteCapability(payload.capability);
    } catch {
      // Early validation/endpoint failures legitimately have no resolved
      // route capability. The blocked snapshot is still useful and remains
      // fail-closed; only passed/warning results require a complete contract.
      capability = {
        level: 'unknown',
        canExecute: false,
        supportsAutoCreate: false,
        supportsAutoAddColumns: false,
        requiresExistingTarget: false,
        supportsMutations: false,
        supportsCdc: false,
      };
    }
  } else {
    capability = decodeRouteCapability(payload.capability);
  }
  return {
    snapshot: {
      taskId: task.id,
      taskRevision: task.revision,
      status,
      issues,
      definitionHash,
      approvalRequired: boolean(
        payload.approvalRequired,
        'DataSyncJobPreflight.data.approvalRequired',
      ),
      // Approval evidence is intentionally backend-only. List/Get/Preflight
      // responses never expose it, so the UI can only trust a token minted in
      // this process for this exact definition hash.
      approvalSatisfied: false,
      checkedAt: fromMillis(payload.checkedAt, 'DataSyncJobPreflight.data.checkedAt'),
    },
    definition,
    capability,
  };
};

/**
 * Preflight is the sole command whose expected blocked result uses
 * QueryResult.success=false while still returning a structured payload.
 * Accept only that exact, decoded state; every other failure remains closed.
 */
export const decodeDataSyncPreflightQuery = (
  result: WailsQueryResultLike,
  task: DataSyncTaskDefinition,
): DecodedDataSyncPreflight => {
  const response = record(result, 'DataSyncJobPreflight');
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobPreflight',
      'response omitted data',
    );
  }
  const decoded = decodeDataSyncPreflight(response.data, task);
  if (response.success === true) {
    if (decoded.snapshot.status === 'blocked') {
      throw new DataSyncGatewayProtocolError(
        'DataSyncJobPreflight',
        'successful response reported blocked status',
      );
    }
    return decoded;
  }
  if (response.success === false && decoded.snapshot.status === 'blocked') {
    return decoded;
  }
  const message = optionalString(
    response.message,
    'DataSyncJobPreflight.message',
  ).trim();
  throw new DataSyncGatewayProtocolError(
    'DataSyncJobPreflight',
    message || 'inconsistent response status',
  );
};

export type DecodedDataSyncApproval = {
  token: string;
  expiresAt: string;
};

export type DecodedDataSyncApprovalChallenge = {
  challenge: string;
  notBefore: string;
  expiresAt: string;
};

export const decodeDataSyncApprovalChallenge = (
  value: unknown,
): DecodedDataSyncApprovalChallenge => {
  const challenge = record(value, 'DataSyncJobApprovalBegin.data');
  const notBefore = fromMillis(
    challenge.notBefore,
    'DataSyncJobApprovalBegin.data.notBefore',
  );
  const expiresAt = fromMillis(
    challenge.expiresAt,
    'DataSyncJobApprovalBegin.data.expiresAt',
  );
  if (!notBefore || !expiresAt || Date.parse(expiresAt) <= Date.parse(notBefore)) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobApprovalBegin.data',
      'invalid approval countdown window',
    );
  }
  return {
    challenge: string(
      challenge.challenge,
      'DataSyncJobApprovalBegin.data.challenge',
      false,
    ),
    notBefore,
    expiresAt,
  };
};

export const decodeDataSyncApproval = (
  value: unknown,
): DecodedDataSyncApproval => {
  const approval = record(value, 'DataSyncJobApprove.data');
  const expiresAt = fromMillis(
    approval.expiresAt,
    'DataSyncJobApprove.data.expiresAt',
  );
  if (!expiresAt) {
    throw new DataSyncGatewayProtocolError(
      'DataSyncJobApprove.data.expiresAt',
      'approval token expiry is missing',
    );
  }
  return {
    token: string(approval.token, 'DataSyncJobApprove.data.token', false),
    expiresAt,
  };
};

export const decodeCDCAdapters = (value: unknown): string[] =>
  array(value, 'DataSyncCDCAdapterList.data').map((item, index) =>
    string(item, `DataSyncCDCAdapterList.data[${index}]`, false),
  );

const RUN_STATUSES = [
  'queued',
  'running',
  'cancelling',
  'paused',
  'succeeded',
  'partial',
  'failed',
  'canceled',
  'interrupted',
] as const;

export const decodeRunRecord = (
  value: unknown,
  taskNames: ReadonlyMap<string, string>,
): DataSyncRunRecord => {
  const run = record(value, 'run');
  const taskId = string(run.jobId, 'run.jobId', false);
  const rowsWritten =
    optionalNumber(run.rowsInserted, 'run.rowsInserted') +
    optionalNumber(run.rowsUpdated, 'run.rowsUpdated') +
    optionalNumber(run.rowsDeleted, 'run.rowsDeleted');
  return {
    id: string(run.id, 'run.id', false),
    taskId,
    taskName: taskNames.get(taskId) || taskId,
    status: enumValue(run.status, RUN_STATUSES, 'run.status'),
    trigger: enumValue(
      run.trigger,
      ['manual', 'schedule', 'resume', 'retry'] as const,
      'run.trigger',
    ),
    attempt: optionalNumber(run.attempt, 'run.attempt'),
    resumable: optionalBoolean(run.resumable, 'run.resumable'),
    message: optionalString(run.message, 'run.message'),
    startedAt:
      fromMillis(run.startedAt, 'run.startedAt') || fromMillis(run.queuedAt, 'run.queuedAt'),
    finishedAt: fromMillis(run.finishedAt, 'run.finishedAt'),
    rowsRead: 0,
    rowsWritten,
    rowsFailed: optionalNumber(run.rowsFailed, 'run.rowsFailed'),
    throughput: 0,
    checkpoint: '',
  };
};

const previewJSON = (value: unknown, limit = 480): string => {
  const text = rawJSONText(value, 'payload');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const decodeIndexColumns = (value: unknown, path: string): DataSyncIndexColumn[] =>
  array(value, path).map((item, index) => {
    const column = record(item, `${path}[${index}]`);
    return {
      name: string(column.name, `${path}[${index}].name`, false),
      prefixLength:
        optionalNumber(column.prefixLength, `${path}[${index}].prefixLength`) || undefined,
    };
  });

const decodeUnmigratedIndex = (value: unknown, path: string): DataSyncUnmigratedIndex => {
  const index = record(value, path);
  return {
    name: string(index.name, `${path}.name`, false),
    columns: decodeIndexColumns(index.columns || [], `${path}.columns`),
    unique: boolean(index.unique, `${path}.unique`),
    indexType: optionalString(index.indexType, `${path}.indexType`) || '',
    reasonCode: optionalString(index.reasonCode, `${path}.reasonCode`) || undefined,
    reason: string(index.reason, `${path}.reason`, false),
    remediationStatements: array(
      index.remediationStatements || [],
      `${path}.remediationStatements`,
    ).map((statement, indexOffset) =>
      string(statement, `${path}.remediationStatements[${indexOffset}]`, false),
    ),
  };
};

export const decodeErrorRow = (value: unknown): DataSyncErrorRow => {
  const row = record(value, 'errorRow');
  const source = optionalString(row.sourceTable, 'errorRow.sourceTable');
  const target = optionalString(row.targetTable, 'errorRow.targetTable');
  return {
    id: string(row.id, 'errorRow.id', false),
    runId: string(row.runId, 'errorRow.runId', false),
    taskId: string(row.jobId, 'errorRow.jobId', false),
    mappingId: `${source} -> ${target}`,
    sourceObject: source,
    reason: string(row.error, 'errorRow.error'),
    payloadPreview: previewJSON(row.payload),
    retryable:
      optionalString(row.payloadPolicy, 'errorRow.payloadPolicy') === 'full',
    status: enumValue(
      row.status,
      ['pending', 'resolved', 'discarded'] as const,
      'errorRow.status',
    ),
    operation: optionalString(row.operation, 'errorRow.operation'),
  };
};

export const decodeCheckpoint = (value: unknown): DataSyncCheckpointSummary => {
  const checkpoint = record(value, 'checkpoint');
  return {
    taskId: string(checkpoint.jobId, 'checkpoint.jobId', false),
    runId: string(checkpoint.runId, 'checkpoint.runId'),
    kind: string(checkpoint.kind, 'checkpoint.kind'),
    phase: string(checkpoint.phase, 'checkpoint.phase'),
    cursorPreview: previewJSON(checkpoint.cursor),
    updatedAt: fromMillis(checkpoint.updatedAt, 'checkpoint.updatedAt'),
  };
};

export const decodeScheduleSummary = (
  jobValue: unknown,
): DataSyncScheduleSummary | null => {
  const job = record(jobValue, 'job');
  const schedule = record(job.schedule, 'job.schedule');
  const kind = enumValue(
    schedule.kind,
    ['manual', 'once', 'interval', 'cron', 'continuous'] as const,
    'job.schedule.kind',
  );
  if (kind === 'manual') return null;
  const expression =
    kind === 'cron'
      ? string(schedule.cronExpression, 'job.schedule.cronExpression')
      : kind === 'interval'
        ? `${number(schedule.intervalSeconds, 'job.schedule.intervalSeconds')}s`
        : kind === 'once'
          ? fromMillis(schedule.runAt, 'job.schedule.runAt')
          : 'continuous';
  return {
    id: `${string(job.id, 'job.id', false)}:schedule`,
    taskId: string(job.id, 'job.id', false),
    taskName: string(job.name, 'job.name'),
    enabled: optionalBoolean(job.enabled, 'job.enabled'),
    expression,
    timezone: optionalString(schedule.timezone, 'job.schedule.timezone') || 'Local',
    nextRunAt: fromMillis(job.nextRunAt, 'job.nextRunAt'),
  };
};

export type DataSyncCDCProbe = {
  adapter: string;
  supported: boolean;
  ready: boolean;
  reason: string;
};

export const decodeCDCProbe = (value: unknown): DataSyncCDCProbe => {
  const capability = record(value, 'DataSyncCDCProbe.data');
  return {
    adapter: string(capability.adapter, 'DataSyncCDCProbe.data.adapter', false),
    supported: boolean(capability.supported, 'DataSyncCDCProbe.data.supported'),
    ready: boolean(capability.ready, 'DataSyncCDCProbe.data.ready'),
    reason: optionalString(capability.reason, 'DataSyncCDCProbe.data.reason'),
  };
};

export const cdcSourceFromProbe = (
  task: DataSyncTaskDefinition,
  probe: DataSyncCDCProbe | null,
  checkpoint: DataSyncCheckpointSummary | null,
  reason = '',
): DataSyncCdcSourceStatus => {
  const adapter = task.incremental.mode === 'cdc' ? task.incremental.adapter : '';
  const status: DataSyncCdcSourceStatus['status'] = !probe
    ? 'unknown'
    : !probe.supported
      ? 'unsupported'
      : probe.ready
        ? 'ready'
        : 'unknown';
  return {
    taskId: task.id,
    connectionId: task.source.connectionId,
    connectionName: task.source.connectionName || task.source.connectionId,
    type: task.source.type,
    adapter,
    status,
    lagMs: null,
    checkpoint: checkpoint?.cursorPreview || '',
    reason: reason || probe?.reason || '',
  };
};
