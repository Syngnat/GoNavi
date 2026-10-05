/**
 * Local validation for a data sync task definition, shared by the editor, the
 * gateway, and the preflight panel. Split out of `model.ts` so the Cron grammar
 * and the growing rule set have a home; `model.ts` re-exports the public
 * entries for existing importers.
 */
import { inspectDataSyncCronExpression } from './dataSyncCronExpression';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';
import type {
  DataSyncTaskDefinition,
  DataSyncTaskStage,
  DataSyncValidationCode,
  DataSyncValidationIssue,
  DataSyncValidationSeverity,
} from './model';

const normalize = (value: unknown): string => String(value ?? '').trim();

const normalizeAtomicTargetType = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (['mssql', 'sql_server', 'sql-server'].includes(normalized)) return 'sqlserver';
  if (['kingbase8', 'kingbasees', 'kingbasev8'].includes(normalized)) return 'kingbase';
  if (['open_gauss', 'open-gauss'].includes(normalized)) return 'opengauss';
  if (['gauss_db', 'gauss-db'].includes(normalized)) return 'gaussdb';
  if (['intersystems', 'intersystemsiris', 'inter-systems', 'inter-systems-iris'].includes(normalized)) return 'iris';
  if (['cache', 'caché', 'intersystems cache', 'intersystems caché', 'intersystems-cache', 'intersystems-caché', 'intersystemscache', 'intersystemscaché', 'inter-systems-cache', 'inter-systems-caché', 'intersystems-cache-database', 'cache-db', 'cachedb'].includes(normalized)) return 'iris';
  if (['dm', 'dm8'].includes(normalized)) return 'dameng';
  if (normalized === 'sqlite3') return 'sqlite';
  if (['goldendb', 'greatdb', 'gdb'].includes(normalized)) return 'mysql';
  // 描述表类型与后端同步内核一致：声明了 sync 且借用方言的按被借用方言判断（TiDB → mysql、CockroachDB → postgres）。
  const registry = getDataSourceSpec(normalized);
  if (registry?.sync && registry.ddlDialect) return registry.ddlDialect;
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
  if (task.kind !== 'backup' && !normalize(task.target.connectionId)) {
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

  if (task.kind === 'backup' && !normalize(task.backup?.directory)) {
    issues.push(issue('backup_directory_required', 'blocker', 'delivery'));
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
    if (!targetObject && task.kind !== 'backup') {
      issues.push(
        issue('target_object_required', 'blocker', 'mappings', mapping.id),
      );
    } else if (targetObject) {
      const targetKey = targetObject.toLowerCase();
      if (targetKeys.has(targetKey)) {
        issues.push(
          issue('duplicate_target_object', 'blocker', 'mappings', mapping.id),
        );
      }
      targetKeys.add(targetKey);
    }
    if (
      (task.kind === 'cdc' || task.incremental.mode === 'cdc') &&
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
  if (task.kind !== 'compare' && task.kind !== 'backup' && task.delivery.writeMode === 'none') {
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
  if (task.delivery.writeMode === 'append' && task.resumePolicy !== 'never') {
    issues.push(issue('append_resume_unsafe', 'blocker', 'delivery'));
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
    const expression = normalize(task.trigger.expression);
    if (!expression) {
      issues.push(issue('cron_expression_required', 'blocker', 'trigger'));
    } else {
      // The scheduler rejects anything outside the five-field grammar, so
      // catching it here keeps the failure on the 运行方式 stage instead of
      // surfacing as a generic definition_invalid preflight blocker.
      const cronIssue = inspectDataSyncCronExpression(expression);
      if (cronIssue) {
        issues.push(issue(cronIssue, 'blocker', 'trigger'));
      }
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
