export const DATA_SYNC_TASK_SCHEMA_VERSION = 1 as const;

export type DataSyncTaskKind =
  | 'migration'
  | 'reconcile'
  | 'querySink'
  | 'compare'
  | 'cdc';

export type DataSyncTaskLifecycle =
  | 'draft'
  | 'ready'
  | 'enabled'
  | 'paused'
  | 'archived';

export type DataSyncTaskStage =
  | 'endpoints'
  | 'mappings'
  | 'delivery'
  | 'trigger'
  | 'preflight';

export type DataSyncCompareMode = 'schema' | 'data' | 'both';

export type DataSyncEndpointRef = {
  connectionId: string;
  connectionName: string;
  type: string;
  database: string;
  schema: string;
};

/**
 * Credential-free connection data that is safe to expose to the workbench.
 * Concrete gateways must never add usernames, passwords, DSNs, or SSH secrets.
 */
export type DataSyncSavedConnectionView = {
  id: string;
  name: string;
  type: string;
  readable: boolean;
  writable: boolean;
};

export type DataSyncDatabaseMetadata = {
  name: string;
};

export type DataSyncObjectMetadata = {
  name: string;
  kind: 'table' | 'view' | 'collection';
  rowCount?: number;
  dataBytes?: number;
  indexBytes?: number;
};

export type DataSyncFieldMetadata = {
  name: string;
  type: string;
  nullable: boolean;
  ordinal: number;
  key: boolean;
};

export type DataSyncFieldMapping = {
  id: string;
  sourceField: string;
  targetField: string;
  sourceType: string;
  targetType: string;
  transform: string;
  transformArgument?: string;
  nullable: boolean;
};

export type DataSyncTableMapping = {
  id: string;
  enabled: boolean;
  sourceObject: string;
  targetObject: string;
  targetMode: 'create_or_reuse' | 'existing_only';
  keyColumns: string[];
  watermark?: {
    column: string;
    tieBreaker: string;
  };
  fields: DataSyncFieldMapping[];
};

export type DataSyncDeliveryPolicy = {
  writeMode: 'none' | 'append' | 'upsert' | 'overwrite';
  errorPolicy: 'stop' | 'skip' | 'quarantine';
  batchSize: number;
  commitEvery: number;
  retryLimit: number;
  retryBackoffMs: number;
  propagateDeletes: boolean;
  autoAddColumns: boolean;
  createIndexes: boolean;
  captureErrorPayload: boolean;
};

export type DataSyncTriggerPolicy =
  | { mode: 'manual' }
  | { mode: 'once'; runAt: string; timezone: string }
  | { mode: 'interval'; intervalSeconds: number; timezone: string }
  | {
      mode: 'cron';
      expression: string;
      timezone: string;
      overlap: 'skip' | 'queue';
    }
  | { mode: 'continuous' };

export type DataSyncIncrementalPolicy =
  | { mode: 'snapshot' }
  | {
      mode: 'watermark';
      column: string;
      tieBreaker: string;
      overlapWindowMs: number;
    }
  | {
      mode: 'cdc';
      initialSnapshot: boolean;
      startPosition: 'latest' | 'earliest' | 'checkpoint';
      adapter: string;
      slotName: string;
      publicationName: string;
    };

export type DataSyncTaskDefinition = {
  schemaVersion: typeof DATA_SYNC_TASK_SCHEMA_VERSION;
  id: string;
  revision: number;
  name: string;
  kind: DataSyncTaskKind;
  lifecycle: DataSyncTaskLifecycle;
  compareMode?: DataSyncCompareMode;
  sourceMode: 'tables' | 'query';
  sourceQuery: string;
  source: DataSyncEndpointRef;
  target: DataSyncEndpointRef;
  mappings: DataSyncTableMapping[];
  delivery: DataSyncDeliveryPolicy;
  trigger: DataSyncTriggerPolicy;
  incremental: DataSyncIncrementalPolicy;
  concurrencyPolicy: 'forbid' | 'queue';
  resumePolicy: 'never' | 'manual' | 'auto';
  createdAt: string;
  updatedAt: string;
};

export type DataSyncValidationSeverity = 'blocker' | 'warning' | 'info';

export type DataSyncValidationCode =
  | 'definition_invalid'
  | 'definition_hash_failed'
  | 'task_name_required'
  | 'source_connection_required'
  | 'target_connection_required'
  | 'source_connection_failed'
  | 'target_connection_failed'
  | 'source_connect_failed'
  | 'source_ping_failed'
  | 'target_connect_failed'
  | 'target_ping_failed'
  | 'same_endpoint'
  | 'same_object'
  | 'route_unsupported'
  | 'source_query_required'
  | 'source_query_not_read_only'
  | 'mapping_required'
  | 'source_object_required'
  | 'target_object_required'
  | 'duplicate_source_object'
  | 'duplicate_target_object'
  | 'mapping_compile_failed'
  | 'source_columns_failed'
  | 'target_columns_failed'
  | 'source_column_missing'
  | 'target_column_missing'
  | 'key_column_missing'
  | 'watermark_column_missing'
  | 'target_table_check_failed'
  | 'target_table_missing'
  | 'target_table_will_be_created'
  | 'key_columns_required'
  | 'batch_size_invalid'
  | 'commit_every_invalid'
  | 'write_mode_required'
  | 'target_protection_blocked'
  | 'row_error_isolation_unsupported'
  | 'append_retry_unsupported'
  | 'append_retry_unsafe'
  | 'append_resume_unsafe'
  | 'full_overwrite_non_atomic'
  | 'watermark_append_unsupported'
  | 'watermark_tie_breaker_required'
  | 'watermark_initial_value_unsupported'
  | 'watermark_runtime_unsupported'
  | 'watermark_overwrite_unsupported'
  | 'watermark_delete_unsupported'
  | 'query_sink_single_mapping_required'
  | 'query_key_required'
  | 'query_target_pk_mismatch'
  | 'query_schema_runtime_validation'
  | 'watermark_column_required'
  | 'cron_expression_required'
  | 'timezone_required'
  | 'interval_invalid'
  | 'cdc_incremental_required'
  | 'cdc_trigger_required'
  | 'cdc_adapter_required'
  | 'cdc_initial_snapshot_unsupported'
  | 'cdc_initial_snapshot_handoff_unsupported'
  | 'cdc_earliest_unsupported'
  | 'cdc_probe_failed'
  | 'cdc_adapter_not_ready'
  | 'cdc_existing_target_required'
  | 'cdc_upsert_required'
  | 'cdc_target_non_atomic'
  | 'cdc_authoritative_columns_required'
  | 'cdc_checkpoint_unavailable'
  | 'cdc_checkpoint_required'
  | 'cdc_checkpoint_incompatible'
  | 'compare_route_unsupported'
  | 'index_inspection_failed'
  | 'unmigrated_index'
  | 'capability_unverified';

export type DataSyncIndexColumn = {
  name: string;
  prefixLength?: number;
};

export type DataSyncUnmigratedIndex = {
  name: string;
  columns: DataSyncIndexColumn[];
  unique: boolean;
  indexType: string;
  reasonCode?: string;
  reason: string;
  remediationStatements?: string[];
};

export type DataSyncValidationIssue = {
  id: string;
  severity: DataSyncValidationSeverity;
  code: DataSyncValidationCode;
  stage: DataSyncTaskStage;
  mappingId?: string;
  message?: string;
  detail?: {
    unmigratedIndex?: DataSyncUnmigratedIndex;
  };
};

export type DataSyncPreflightStatus =
  | 'stale'
  | 'running'
  | 'blocked'
  | 'warning'
  | 'passed';

export type DataSyncPreflightSnapshot = {
  taskId: string;
  taskRevision: number;
  status: Exclude<DataSyncPreflightStatus, 'stale' | 'running'>;
  issues: DataSyncValidationIssue[];
  /** Backend-owned hash of the exact definition that was checked. */
  definitionHash: string;
  /** Production writes remain disabled until an explicit approval grants a token. */
  approvalRequired: boolean;
  /** True only when the exact enriched definition already carries a valid approval. */
  approvalSatisfied: boolean;
  checkedAt: string;
};

export type DataSyncApprovalChallenge = {
  definitionHash: string;
  notBefore: string;
  expiresAt: string;
};

export type DataSyncApprovalGrant = {
  definitionHash: string;
  expiresAt: string;
};

export type DataSyncRouteCapability = {
  level: 'full' | 'partial' | 'unsupported' | 'unknown';
  canExecute: boolean;
  supportsAutoCreate: boolean;
  supportsAutoAddColumns?: boolean;
  requiresExistingTarget?: boolean;
  supportsMutations?: boolean;
  supportsCdc: boolean;
};

export type DataSyncRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'preflighting'
  | 'snapshotting'
  | 'catching_up'
  | 'streaming'
  | 'paused'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'canceled'
  | 'cancelled'
  | 'interrupted';

export type DataSyncRunRecord = {
  id: string;
  taskId: string;
  taskName: string;
  status: DataSyncRunStatus;
  trigger: 'manual' | 'schedule' | 'resume' | 'retry' | 'once' | 'cron' | 'continuous';
  attempt: number;
  resumable: boolean;
  message: string;
  startedAt: string;
  finishedAt: string;
  rowsRead: number;
  rowsWritten: number;
  rowsFailed: number;
  throughput: number;
  checkpoint: string;
};

export type DataSyncErrorRow = {
  id: string;
  runId: string;
  taskId: string;
  mappingId: string;
  sourceObject: string;
  reason: string;
  payloadPreview: string;
  retryable: boolean;
  status: 'pending' | 'resolved' | 'discarded' | 'unknown';
  operation: string;
};

export type DataSyncScheduleSummary = {
  id: string;
  taskId: string;
  taskName: string;
  enabled: boolean;
  expression: string;
  timezone: string;
  nextRunAt: string;
};

export type DataSyncCdcSourceStatus = {
  taskId: string;
  connectionId: string;
  connectionName: string;
  type: string;
  adapter: string;
  status: 'ready' | 'probing' | 'lagging' | 'offline' | 'unsupported' | 'unknown';
  lagMs: number | null;
  checkpoint: string;
  reason: string;
};

export type DataSyncCheckpointSummary = {
  taskId: string;
  runId: string;
  kind: string;
  phase: string;
  cursorPreview: string;
  updatedAt: string;
};

type CreateDataSyncTaskInput = {
  id: string;
  kind: DataSyncTaskKind;
  name?: string;
  now?: string;
  compareMode?: DataSyncCompareMode;
  sourceConnectionId?: string;
};

const emptyEndpoint = (connectionId = ''): DataSyncEndpointRef => ({
  connectionId,
  connectionName: '',
  type: '',
  database: '',
  schema: '',
});

export const createDataSyncTableMapping = (
  id: string,
  sourceObject = '',
  targetObject = '',
): DataSyncTableMapping => ({
  id,
  enabled: true,
  sourceObject,
  targetObject,
  targetMode: 'existing_only',
  keyColumns: [],
  fields: [],
});

const normalizeMetadataName = (value: string): string =>
  value.trim().toLowerCase();

const metadataObjectBaseName = (value: string): string => {
  const parts = value.trim().split('.');
  return (parts[parts.length - 1] || '')
    .trim()
    .replace(/^[`"\[]/, '')
    .replace(/[`"\]]$/, '');
};

const pristineDataSyncMapping = (mapping: DataSyncTableMapping): boolean =>
  !mapping.sourceObject.trim() &&
  !mapping.targetObject.trim() &&
  mapping.keyColumns.length === 0 &&
  mapping.fields.length === 0;

type BuildDataSyncMappingsInput = {
  taskId: string;
  taskKind: DataSyncTaskKind;
  sourceNames: string[];
  targetObjects: DataSyncObjectMetadata[];
  existingMappings: DataSyncTableMapping[];
  keyColumnsBySource?: Record<string, string[]>;
  allowTargetCreate?: boolean;
};

/**
 * Turns a user's object selection into safe, editable mappings. Existing work is
 * retained, duplicate sources are ignored, and only one unconfigured starter row
 * is replaced. Missing targets are auto-created only for one-time migrations.
 */
export const buildDataSyncMappingsFromSelection = ({
  taskId,
  taskKind,
  sourceNames,
  targetObjects,
  existingMappings,
  keyColumnsBySource = {},
  allowTargetCreate,
}: BuildDataSyncMappingsInput): DataSyncTableMapping[] => {
  const retained = existingMappings.filter((mapping) => !pristineDataSyncMapping(mapping));
  const seenSources = new Set(
    retained
      .map((mapping) => normalizeMetadataName(mapping.sourceObject))
      .filter(Boolean),
  );
  const usedMappingIds = new Set(retained.map((mapping) => mapping.id));
  const targetCandidates = targetObjects.filter((object) => object.kind !== 'view');

  const matchTarget = (sourceName: string): string => {
    const sourceFull = normalizeMetadataName(sourceName);
    const sourceBase = normalizeMetadataName(metadataObjectBaseName(sourceName));
    const exact = targetCandidates.find(
      (candidate) => normalizeMetadataName(candidate.name) === sourceFull,
    );
    if (exact) return exact.name;
    const baseMatches = targetCandidates.filter(
      (candidate) =>
        normalizeMetadataName(metadataObjectBaseName(candidate.name)) === sourceBase,
    );
    return baseMatches.length === 1 ? baseMatches[0].name : '';
  };

  const additions = sourceNames.flatMap((rawName, selectionIndex) => {
    const sourceObject = rawName.trim();
    const sourceKey = normalizeMetadataName(sourceObject);
    if (!sourceKey || seenSources.has(sourceKey)) return [];
    seenSources.add(sourceKey);

    const matchedTarget = matchTarget(sourceObject);
    const canCreateTarget =
      (allowTargetCreate ?? taskKind === 'migration') && !matchedTarget;
    const idStem = sourceKey.replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    let mappingId = `${taskId}:mapping:${idStem || selectionIndex + 1}`;
    let suffix = 2;
    while (usedMappingIds.has(mappingId)) {
      mappingId = `${taskId}:mapping:${idStem || selectionIndex + 1}:${suffix}`;
      suffix += 1;
    }
    usedMappingIds.add(mappingId);
    const mapping = createDataSyncTableMapping(
      mappingId,
      sourceObject,
      matchedTarget || (canCreateTarget ? metadataObjectBaseName(sourceObject) : ''),
    );
    mapping.targetMode = canCreateTarget ? 'create_or_reuse' : 'existing_only';
    mapping.keyColumns = [
      ...(keyColumnsBySource[sourceKey] ||
        keyColumnsBySource[normalizeMetadataName(metadataObjectBaseName(sourceObject))] ||
        []),
    ];
    return [mapping];
  });

  return [...retained, ...additions];
};

/**
 * Produces a deterministic, editable mapping for fields that share a name.
 * Existing transforms are retained so refreshing metadata never discards work.
 */
export const autoMatchDataSyncFields = (
  mappingId: string,
  sourceFields: DataSyncFieldMetadata[],
  targetFields: DataSyncFieldMetadata[],
  existing: DataSyncFieldMapping[] = [],
): DataSyncFieldMapping[] => {
  const targetByName = new Map(
    targetFields.map((field) => [normalizeMetadataName(field.name), field] as const),
  );
  const existingByPair = new Map<string, DataSyncFieldMapping>(
    existing.map((field) => [
      `${normalizeMetadataName(field.sourceField)}\u0000${normalizeMetadataName(
        field.targetField,
      )}`,
      field,
    ] as const),
  );

  return sourceFields.flatMap((sourceField, index) => {
    const targetField = targetByName.get(normalizeMetadataName(sourceField.name));
    if (!targetField) return [];
    const pairKey = `${normalizeMetadataName(sourceField.name)}\u0000${normalizeMetadataName(
      targetField.name,
    )}`;
    const previous = existingByPair.get(pairKey);
    return [
      {
        id: previous?.id || `${mappingId}:field:${index + 1}`,
        sourceField: sourceField.name,
        targetField: targetField.name,
        sourceType: sourceField.type,
        targetType: targetField.type,
        transform: previous?.transform || '',
        transformArgument: previous?.transformArgument || '',
        nullable: targetField.nullable,
      },
    ];
  });
};

const defaultWriteMode = (
  kind: DataSyncTaskKind,
): DataSyncDeliveryPolicy['writeMode'] => {
  if (kind === 'compare') return 'none';
  if (kind === 'querySink') return 'append';
  return 'upsert';
};

export const createDataSyncTaskDraft = ({
  id,
  kind,
  name = '',
  now = new Date().toISOString(),
  compareMode,
  sourceConnectionId = '',
}: CreateDataSyncTaskInput): DataSyncTaskDefinition => ({
  schemaVersion: DATA_SYNC_TASK_SCHEMA_VERSION,
  id,
  revision: 1,
  name,
  kind,
  lifecycle: 'draft',
  compareMode: kind === 'compare' ? compareMode || 'data' : undefined,
  sourceMode: kind === 'querySink' ? 'query' : 'tables',
  sourceQuery: '',
  source: emptyEndpoint(sourceConnectionId),
  target: emptyEndpoint(),
  mappings:
    kind === 'querySink'
      ? [createDataSyncTableMapping(`${id}:mapping:1`)]
      : [],
  delivery: {
    writeMode: defaultWriteMode(kind),
    errorPolicy: 'stop',
    batchSize: 1_000,
    commitEvery: 1_000,
    retryLimit: kind === 'querySink' ? 0 : 3,
    retryBackoffMs: 500,
    propagateDeletes: false,
    autoAddColumns: false,
    createIndexes: false,
    captureErrorPayload: false,
  },
  trigger: kind === 'cdc' ? { mode: 'continuous' } : { mode: 'manual' },
  incremental:
    kind === 'cdc'
      ? {
          mode: 'cdc',
          initialSnapshot: false,
          startPosition: 'latest',
          adapter: '',
          slotName: '',
          publicationName: '',
        }
      : { mode: 'snapshot' },
  concurrencyPolicy: 'forbid',
  resumePolicy: 'manual',
  createdAt: now,
  updatedAt: now,
});

export const reviseDataSyncTask = (
  task: DataSyncTaskDefinition,
  patch: Partial<Omit<DataSyncTaskDefinition, 'id' | 'schemaVersion' | 'revision' | 'createdAt'>>,
  now = new Date().toISOString(),
): DataSyncTaskDefinition => ({
  ...task,
  ...patch,
  revision: task.revision + 1,
  updatedAt: now,
});

const normalize = (value: unknown): string => String(value ?? '').trim();

const normalizeAtomicTargetType = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (['mssql', 'sql_server', 'sql-server'].includes(normalized)) return 'sqlserver';
  if (['kingbase8', 'kingbasees', 'kingbasev8'].includes(normalized)) return 'kingbase';
  if (['open_gauss', 'open-gauss'].includes(normalized)) return 'opengauss';
  if (['gauss_db', 'gauss-db'].includes(normalized)) return 'gaussdb';
  if (['intersystems', 'intersystemsiris', 'inter-systems', 'inter-systems-iris'].includes(normalized)) return 'iris';
  if (['dm', 'dm8'].includes(normalized)) return 'dameng';
  if (normalized === 'sqlite3') return 'sqlite';
  if (['goldendb', 'greatdb', 'gdb'].includes(normalized)) return 'mysql';
  return normalized;
};

const ATOMIC_ROW_ISOLATION_TARGETS = new Set([
  'mysql',
  'mariadb',
  'oceanbase',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'oracle',
  'sqlserver',
  'dameng',
  'sqlite',
  'duckdb',
  'iris',
]);

/** Mirrors the backend's fail-closed snapshot/query row-isolation contract. */
export const canUseDataSyncRowErrorIsolation = (
  task: DataSyncTaskDefinition,
): boolean => {
  if (task.kind === 'cdc') return true;
  if (
    (task.kind !== 'reconcile' && task.kind !== 'querySink') ||
    task.incremental.mode !== 'snapshot' ||
    task.delivery.writeMode === 'overwrite' ||
    task.delivery.autoAddColumns ||
    task.delivery.createIndexes ||
    task.delivery.propagateDeletes ||
    !ATOMIC_ROW_ISOLATION_TARGETS.has(normalizeAtomicTargetType(task.target.type))
  ) {
    return false;
  }
  const enabledMappings = task.mappings.filter((mapping) => mapping.enabled);
  return (
    enabledMappings.length > 0 &&
    enabledMappings.every((mapping) => mapping.targetMode === 'existing_only')
  );
};

const issue = (
  code: DataSyncValidationCode,
  severity: DataSyncValidationSeverity,
  stage: DataSyncTaskStage,
  mappingId?: string,
): DataSyncValidationIssue => ({
  id: mappingId ? `${code}:${mappingId}` : code,
  code,
  severity,
  stage,
  ...(mappingId ? { mappingId } : {}),
});

export const validateDataSyncTask = (
  task: DataSyncTaskDefinition,
): DataSyncValidationIssue[] => {
  const issues: DataSyncValidationIssue[] = [];
  if (!normalize(task.name)) {
    issues.push(issue('task_name_required', 'blocker', 'endpoints'));
  }
  if (!normalize(task.source.connectionId)) {
    issues.push(issue('source_connection_required', 'blocker', 'endpoints'));
  }
  if (!normalize(task.target.connectionId)) {
    issues.push(issue('target_connection_required', 'blocker', 'endpoints'));
  }
  if (
    normalize(task.source.connectionId) &&
    normalize(task.source.connectionId) === normalize(task.target.connectionId) &&
    normalize(task.source.database).toLowerCase() ===
      normalize(task.target.database).toLowerCase()
  ) {
    issues.push(issue('same_endpoint', 'warning', 'endpoints'));
  }
  if (task.sourceMode === 'query' && !normalize(task.sourceQuery)) {
    issues.push(issue('source_query_required', 'blocker', 'endpoints'));
  }

  const enabledMappings = task.mappings.filter((mapping) => mapping.enabled);
  if (enabledMappings.length === 0) {
    issues.push(issue('mapping_required', 'blocker', 'mappings'));
  }
  if (task.kind === 'querySink' && task.mappings.length !== 1) {
    issues.push(
      issue('query_sink_single_mapping_required', 'blocker', 'mappings'),
    );
  }
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  enabledMappings.forEach((mapping) => {
    if (task.kind !== 'querySink') {
      const sourceObject = normalize(mapping.sourceObject);
      if (!sourceObject) {
        issues.push(
          issue('source_object_required', 'blocker', 'mappings', mapping.id),
        );
      } else {
        const sourceKey = sourceObject.toLowerCase();
        if (sourceKeys.has(sourceKey)) {
          issues.push(
            issue('duplicate_source_object', 'blocker', 'mappings', mapping.id),
          );
        }
        sourceKeys.add(sourceKey);
      }
    }
    const targetObject = normalize(mapping.targetObject);
    if (!targetObject) {
      issues.push(
        issue('target_object_required', 'blocker', 'mappings', mapping.id),
      );
    } else {
      const targetKey = targetObject.toLowerCase();
      if (targetKeys.has(targetKey)) {
        issues.push(
          issue('duplicate_target_object', 'blocker', 'mappings', mapping.id),
        );
      }
      targetKeys.add(targetKey);
    }
    if (
      (task.kind === 'reconcile' || task.kind === 'cdc') &&
      mapping.keyColumns.map(normalize).filter(Boolean).length === 0
    ) {
      issues.push(
        issue('key_columns_required', 'blocker', 'mappings', mapping.id),
      );
    }
  });

  if (
    !Number.isInteger(task.delivery.batchSize) ||
    task.delivery.batchSize < 1 ||
    task.delivery.batchSize > 10_000
  ) {
    issues.push(issue('batch_size_invalid', 'blocker', 'delivery'));
  }
  if (
    !Number.isInteger(task.delivery.commitEvery) ||
    task.delivery.commitEvery < task.delivery.batchSize
  ) {
    issues.push(issue('commit_every_invalid', 'blocker', 'delivery'));
  }
  if (task.kind !== 'compare' && task.delivery.writeMode === 'none') {
    issues.push(issue('write_mode_required', 'blocker', 'delivery'));
  }
  if (
    task.delivery.errorPolicy !== 'stop' &&
    !canUseDataSyncRowErrorIsolation(task)
  ) {
    issues.push(
      issue('row_error_isolation_unsupported', 'blocker', 'delivery'),
    );
  }
  if (task.delivery.writeMode === 'append' && task.delivery.retryLimit !== 0) {
    issues.push(issue('append_retry_unsupported', 'blocker', 'delivery'));
  }
  if (
    task.incremental.mode === 'watermark' &&
    task.delivery.writeMode === 'append'
  ) {
    issues.push(issue('watermark_append_unsupported', 'blocker', 'delivery'));
  }

  if (
    task.incremental.mode === 'watermark' &&
    !normalize(task.incremental.column)
  ) {
    issues.push(issue('watermark_column_required', 'blocker', 'trigger'));
  }
  if (task.trigger.mode === 'cron') {
    if (!normalize(task.trigger.expression)) {
      issues.push(issue('cron_expression_required', 'blocker', 'trigger'));
    }
    if (!normalize(task.trigger.timezone)) {
      issues.push(issue('timezone_required', 'blocker', 'trigger'));
    }
  }
  if (
    task.trigger.mode === 'interval' &&
    (!Number.isInteger(task.trigger.intervalSeconds) || task.trigger.intervalSeconds < 60)
  ) {
    issues.push(issue('interval_invalid', 'blocker', 'trigger'));
  }
  if (task.kind === 'cdc') {
    if (task.incremental.mode !== 'cdc') {
      issues.push(issue('cdc_incremental_required', 'blocker', 'trigger'));
    }
    if (task.trigger.mode !== 'continuous') {
      issues.push(issue('cdc_trigger_required', 'blocker', 'trigger'));
    }
    if (task.incremental.mode === 'cdc') {
      if (!normalize(task.incremental.adapter)) {
        issues.push(issue('cdc_adapter_required', 'blocker', 'trigger'));
      }
      if (task.incremental.initialSnapshot) {
        issues.push(
          issue('cdc_initial_snapshot_unsupported', 'blocker', 'trigger'),
        );
      }
      if (task.incremental.startPosition === 'earliest') {
        issues.push(issue('cdc_earliest_unsupported', 'blocker', 'trigger'));
      }
    }
  }

  return issues;
};

export const resolveDataSyncPreflightStatus = (
  issues: DataSyncValidationIssue[],
): DataSyncPreflightSnapshot['status'] => {
  if (issues.some((item) => item.severity === 'blocker')) return 'blocked';
  if (issues.some((item) => item.severity === 'warning')) return 'warning';
  return 'passed';
};

export const isDataSyncPreflightCurrent = (
  task: DataSyncTaskDefinition,
  preflight: DataSyncPreflightSnapshot | null,
): boolean =>
  Boolean(
    preflight &&
      preflight.taskId === task.id &&
      preflight.taskRevision === task.revision,
  );

export const canStartDataSyncTask = (
  task: DataSyncTaskDefinition,
  preflight: DataSyncPreflightSnapshot | null,
  approval: DataSyncApprovalGrant | null = null,
  now = Date.now(),
): boolean =>
  (task.lifecycle === 'ready' || task.lifecycle === 'enabled') &&
  isDataSyncPreflightCurrent(task, preflight) &&
  (preflight?.approvalRequired === false ||
    preflight?.approvalSatisfied === true ||
    Boolean(
      approval &&
        approval.definitionHash === preflight?.definitionHash &&
        Date.parse(approval.expiresAt) > now,
    )) &&
  (preflight?.status === 'passed' || preflight?.status === 'warning');
