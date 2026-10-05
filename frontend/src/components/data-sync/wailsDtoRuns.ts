import type {
  DataSyncCompareMode,
  DataSyncRunRecord,
  DataSyncRunPage,
  DataSyncRunCursor,
  DataSyncRunEvent,
  DataSyncErrorRow,
  DataSyncCompareResult,
  DataSyncCheckpointSummary,
  DataSyncScheduleSummary,
  DataSyncTaskDefinition,
  DataSyncCdcSourceStatus,
} from './model';
import {
  isRecord,
  record,
  string,
  optionalNumber,
  enumValue,
  optionalBoolean,
  optionalString,
  fromMillis,
  number,
  array,
  rawJSONText,
  boolean,
  optionalMetadataNumber,
} from './wailsDtoPrimitives';
import { COLUMN_STRUCTURE_DIFF_KINDS, COMPARE_MODES } from './wailsDtoJobDecode';

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

const decodeRunCompareMode = (value: unknown): DataSyncCompareMode | undefined => {
  if (!isRecord(value)) return undefined;
  const job = value;
  if (job.kind !== 'compare') return undefined;
  const options = isRecord(job.options) ? job.options : {};
  const content = options.content;
  if (content === 'schema' || content === 'data' || content === 'both') return content;
  return undefined;
};

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
  // 进度是「已处理/总对象数」：备份按表计，同步按映射计，二者共用
  // RunProgress.Current/Total。此前这一列被硬编码为空串，表格因此恒显示 —，
  // 而后端其实一直在上报这两个字段。
  const current = optionalNumber(run.currentItem, 'run.currentItem');
  const total = optionalNumber(run.totalItems, 'run.totalItems');
  const progress = total > 0 ? `${Math.min(current, total)}/${total}` : '';
  return {
    id: string(run.id, 'run.id', false),
    taskId,
    taskName: taskNames.get(taskId) || taskId,
    compareMode: decodeRunCompareMode(run.definitionSnapshot),
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
    checkpoint: progress,
  };
};

export const decodeRunPage = (
  value: unknown,
  taskNames: ReadonlyMap<string, string>,
): DataSyncRunPage => {
  const page = record(value, 'DataSyncRunPage.data');
  const nextCursorValue = page.nextCursor;
  let nextCursor: DataSyncRunCursor | null = null;
  if (nextCursorValue !== undefined && nextCursorValue !== null) {
    const cursor = record(nextCursorValue, 'DataSyncRunPage.data.nextCursor');
    nextCursor = {
      createdAt: number(cursor.createdAt, 'DataSyncRunPage.data.nextCursor.createdAt'),
      id: string(cursor.id, 'DataSyncRunPage.data.nextCursor.id', false),
    };
  }
  return {
    runs: array(page.runs, 'DataSyncRunPage.data.runs').map((run) =>
      decodeRunRecord(run, taskNames),
    ),
    nextCursor,
    total: number(page.total, 'DataSyncRunPage.data.total'),
  };
};

const previewJSON = (value: unknown, limit = 480): string => {
  const text = rawJSONText(value, 'payload');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

export const decodeRunEvent = (value: unknown, path: string): DataSyncRunEvent => {
  const event = record(value, path);
  const payload = event.payload;
  return {
    runId: string(event.runId, `${path}.runId`, false),
    sequence: number(event.sequence, `${path}.sequence`),
    type: enumValue(
      event.type,
      [
        'queued',
        'started',
        'progress',
        'checkpoint',
        'error_row',
        'log',
        'cancelling',
        'canceled',
        'succeeded',
        'partial',
        'failed',
        'interrupted',
      ] as const,
      `${path}.type`,
    ),
    message: optionalString(event.message, `${path}.message`),
    table: optionalString(event.table, `${path}.table`) || undefined,
    stage: optionalString(event.stage, `${path}.stage`) || undefined,
    payload: payload === undefined || payload === null ? undefined : payload,
    createdAt: fromMillis(event.createdAt, `${path}.createdAt`),
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

export const decodeCompareResult = (
  value: unknown,
  path: string,
): DataSyncCompareResult => {
  const result = record(value, path);
  const tablesValue = result.tables;
  const tables: DataSyncCompareResult['tables'] = Array.isArray(tablesValue)
    ? tablesValue.map((item, index) => {
        const summary = record(item, `${path}.tables[${index}]`);
        return {
          table: string(summary.table, `${path}.tables[${index}].table`),
          sourceObject:
            optionalString(summary.sourceObject, `${path}.tables[${index}].sourceObject`) ||
            undefined,
          targetObject:
            optionalString(summary.targetObject, `${path}.tables[${index}].targetObject`) ||
            undefined,
          pkColumn:
            optionalString(summary.pkColumn, `${path}.tables[${index}].pkColumn`) ||
            undefined,
          canSync: boolean(summary.canSync, `${path}.tables[${index}].canSync`),
          inserts: optionalNumber(summary.inserts, `${path}.tables[${index}].inserts`),
          updates: optionalNumber(summary.updates, `${path}.tables[${index}].updates`),
          deletes: optionalNumber(summary.deletes, `${path}.tables[${index}].deletes`),
          same: optionalNumber(summary.same, `${path}.tables[${index}].same`),
          schemaDiffCount: optionalMetadataNumber(
            summary.schemaDiffCount,
            `${path}.tables[${index}].schemaDiffCount`,
          ),
          missingColumns: Array.isArray(summary.missingColumns)
            ? summary.missingColumns.map((column, columnIndex) =>
                string(
                  column,
                  `${path}.tables[${index}].missingColumns[${columnIndex}]`,
                ),
              )
            : undefined,
          // Unknown kinds are dropped rather than thrown on: a newer backend
          // adding a diff kind must not make the whole compare result
          // undecodable for an older UI.
          columnDiffs: Array.isArray(summary.columnDiffs)
            ? summary.columnDiffs
                .map((entry, diffIndex) => {
                  const diffPath = `${path}.tables[${index}].columnDiffs[${diffIndex}]`;
                  const diff = record(entry, diffPath);
                  const rawKind = optionalString(diff.kind, `${diffPath}.kind`);
                  // find() over a literal tuple yields the narrowed union;
                  // excluding literals from `string` with !== would not.
                  const kind = COLUMN_STRUCTURE_DIFF_KINDS.find(
                    (candidate) => candidate === rawKind,
                  );
                  if (!kind) return null;
                  return {
                    column: string(diff.column, `${diffPath}.column`),
                    kind,
                    source:
                      optionalString(diff.source, `${diffPath}.source`) || undefined,
                    target:
                      optionalString(diff.target, `${diffPath}.target`) || undefined,
                  };
                })
                .filter(
                  (diff): diff is NonNullable<typeof diff> => diff !== null,
                )
            : undefined,
          hasSchema: summary.hasSchema === undefined
            ? undefined
            : boolean(summary.hasSchema, `${path}.tables[${index}].hasSchema`),
          message:
            optionalString(summary.message, `${path}.tables[${index}].message`) ||
            undefined,
          targetTableExists: summary.targetTableExists === undefined
            ? undefined
            : boolean(
                summary.targetTableExists,
                `${path}.tables[${index}].targetTableExists`,
              ),
          plannedAction:
            optionalString(summary.plannedAction, `${path}.tables[${index}].plannedAction`) ||
            undefined,
          warnings: Array.isArray(summary.warnings)
            ? summary.warnings.map((warning, warningIndex) =>
                string(
                  warning,
                  `${path}.tables[${index}].warnings[${warningIndex}]`,
                ),
              )
            : undefined,
        };
      })
    : [];
  return {
    success: boolean(result.success, `${path}.success`),
    message: optionalString(result.message, `${path}.message`),
    // Only a known mode is surfaced. The backend logs a warning but still
    // echoes an unrecognized content verbatim (analyze.go), and job validation
    // never enum-checks it, so passing it through would leave the view with a
    // mode that matches neither data nor schema — hiding both sections and
    // mislabelling a differing table as identical.
    content: COMPARE_MODES.find(
      (mode) => mode === optionalString(result.content, `${path}.content`),
    ),
    tables,
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
  const adapter = probe?.adapter || (task.incremental.mode === 'cdc' ? task.incremental.adapter : '');
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
