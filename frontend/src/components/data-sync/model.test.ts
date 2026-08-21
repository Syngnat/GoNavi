import { describe, expect, it } from 'vitest';

import {
  autoMatchDataSyncFields,
  aggregateDataSyncScheduleSummaries,
  canUseDataSyncRowErrorIsolation,
  canStartDataSyncTask,
  buildDataSyncMappingsFromSelection,
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  isDataSyncPreflightCurrent,
  resolveDataSyncPreflightStatus,
  reviseDataSyncTask,
  summarizeDataSyncRunMessage,
  validateDataSyncTask,
  type DataSyncPreflightSnapshot,
} from './model';

describe('data sync task model', () => {
  it('redacts and bounds schedule error summaries', () => {
    const message =
      'connect failed: postgres://alice:secret@example.test/db?token=abc password=top-secret; ' +
      'x'.repeat(300);

    const summary = summarizeDataSyncRunMessage(message, 80);

    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('abc');
    expect(summary).not.toContain('top-secret');
    expect(summary).toContain('[REDACTED]');
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('redacts quoted credential values that contain spaces', () => {
    const summary = summarizeDataSyncRunMessage(
      'target rejected password="top secret"; token: \'one time token\'; api_key = "blue green"',
    );

    expect(summary).toBe(
      'target rejected password=[REDACTED]; token: [REDACTED]; api_key = [REDACTED]',
    );
  });

  it('redacts unquoted credential values with spaces up to the next field', () => {
    const summary = summarizeDataSyncRunMessage(
      'target rejected password=top secret; retryable=true; token=one time token',
    );

    expect(summary).toBe(
      'target rejected password=[REDACTED]; retryable=true; token=[REDACTED]',
    );
    expect(summary).not.toContain('top secret');
    expect(summary).not.toContain('one time token');
  });

  it('redacts authorization schemes and URL userinfo edge cases', () => {
    const summary = summarizeDataSyncRunMessage(
      'Authorization: Basic dXNlcjpzZWNyZXQ=; ' +
      'postgres://:empty-user-password@example.test/db; ' +
      'postgres://alice:p@ss@example.test/db',
    );

    expect(summary).not.toContain('dXNlcjpzZWNyZXQ=');
    expect(summary).not.toContain('empty-user-password');
    expect(summary).not.toContain('p@ss');
    expect(summary).toContain('Authorization: [REDACTED]');
    expect(summary).toContain('postgres://[REDACTED]@example.test/db');
  });

  it('redacts quoted query credentials without leaving value fragments', () => {
    const summary = summarizeDataSyncRunMessage(
      'request failed: https://example.test/api?password="top secret"&token=one%20time',
    );

    expect(summary).toBe(
      'request failed: https://example.test/api?password=[REDACTED]&token=[REDACTED]',
    );
    expect(summary).not.toContain('top secret');
    expect(summary).not.toContain('one%20time');
  });

  it('redacts composite OAuth and client credential keys in schedule summaries', () => {
    const summary = summarizeDataSyncRunMessage(
      'authorization failed: access_token=access-value; refresh_token: refresh-value; client_secret = client-value; Access-Token: header-value',
    );

    for (const value of [
      'access-value',
      'refresh-value',
      'client-value',
      'header-value',
    ]) {
      expect(summary).not.toContain(value);
    }
    expect((summary.match(/\[REDACTED\]/g) || [])).toHaveLength(4);
  });

  it('redacts credential values in JSON-shaped error messages', () => {
    const summary = summarizeDataSyncRunMessage(
      '{"access_token":"access-value","refresh_token":"refresh-value","client_secret":"client-value","password":"top-secret"}',
    );

    for (const value of [
      'access-value',
      'refresh-value',
      'client-value',
      'top-secret',
    ]) {
      expect(summary).not.toContain(value);
    }
    expect((summary.match(/\[REDACTED\]/g) || [])).toHaveLength(4);
  });

  it('aggregates the latest run and lifecycle state for scheduled tasks', () => {
    const scheduled = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'scheduled-task',
        kind: 'reconcile',
        name: 'Scheduled orders',
      }),
      {
        lifecycle: 'paused',
        trigger: {
          mode: 'cron',
          expression: '0 * * * *',
          timezone: 'Asia/Shanghai',
          overlap: 'skip',
        },
      },
    );
    const manual = createDataSyncTaskDraft({
      id: 'manual-task',
      kind: 'migration',
      name: 'Manual migration',
    });
    const summaries = aggregateDataSyncScheduleSummaries(
      [scheduled, manual],
      [
        {
          id: 'old-failure',
          taskId: scheduled.id,
          taskName: scheduled.name,
          status: 'failed',
          trigger: 'schedule',
          attempt: 1,
          resumable: false,
          message: 'old failure',
          startedAt: '2026-08-08T00:00:00.000Z',
          finishedAt: '2026-08-08T00:01:00.000Z',
          rowsRead: 0,
          rowsWritten: 0,
          rowsFailed: 1,
          throughput: 0,
          checkpoint: '',
        },
        {
          id: 'latest-failure',
          taskId: scheduled.id,
          taskName: scheduled.name,
          status: 'failed',
          trigger: 'schedule',
          attempt: 1,
          resumable: true,
          message: 'password=latest-secret',
          startedAt: '2026-08-08T01:00:00.000Z',
          finishedAt: '2026-08-08T01:02:00.000Z',
          rowsRead: 3,
          rowsWritten: 2,
          rowsFailed: 1,
          throughput: 1,
          checkpoint: '',
        },
      ],
      [
        {
          id: 'scheduled-task:schedule',
          taskId: scheduled.id,
          taskName: scheduled.name,
          enabled: true,
          expression: 'old-expression',
          timezone: 'UTC',
          nextRunAt: '2026-08-08T02:00:00.000Z',
        },
      ],
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      taskId: scheduled.id,
      lifecycle: 'paused',
      enabled: false,
      expression: '0 * * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: '',
      latestRun: {
        id: 'latest-failure',
        status: 'failed',
        errorSummary: 'password=[REDACTED]',
      },
    });
  });

  it('shows sanitized messages for canceled and interrupted latest runs', () => {
    const scheduled = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'scheduled-terminal-task',
        kind: 'reconcile',
        name: 'Scheduled terminal state',
      }),
      {
        lifecycle: 'enabled',
        trigger: {
          mode: 'interval',
          intervalSeconds: 60,
          timezone: 'UTC',
        },
      },
    );

    const [summary] = aggregateDataSyncScheduleSummaries([scheduled], [
      {
        id: 'interrupted-run',
        taskId: scheduled.id,
        taskName: scheduled.name,
        status: 'interrupted',
        trigger: 'schedule',
        attempt: 1,
        resumable: true,
        message: 'authorization=secret-value',
        startedAt: '2026-08-08T02:00:00.000Z',
        finishedAt: '2026-08-08T02:01:00.000Z',
        rowsRead: 1,
        rowsWritten: 0,
        rowsFailed: 1,
        throughput: 0,
        checkpoint: '',
      },
    ]);

    expect(summary.latestRun?.errorSummary).toBe('authorization=[REDACTED]');
  });

  it('uses the latest run start time when completion order differs', () => {
    const scheduled = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'scheduled-order-task',
        kind: 'reconcile',
        name: 'Scheduled order check',
      }),
      {
        lifecycle: 'enabled',
        trigger: {
          mode: 'interval',
          intervalSeconds: 300,
          timezone: 'UTC',
        },
      },
    );
    const summaries = aggregateDataSyncScheduleSummaries([scheduled], [
      {
        id: 'older-start-finished-last',
        taskId: scheduled.id,
        taskName: scheduled.name,
        status: 'failed',
        trigger: 'schedule',
        attempt: 1,
        resumable: false,
        message: 'older start',
        startedAt: '2026-08-08T01:00:00.000Z',
        finishedAt: '2026-08-08T03:00:00.000Z',
        rowsRead: 0,
        rowsWritten: 0,
        rowsFailed: 1,
        throughput: 0,
        checkpoint: '',
      },
      {
        id: 'newer-start-finished-first',
        taskId: scheduled.id,
        taskName: scheduled.name,
        status: 'succeeded',
        trigger: 'schedule',
        attempt: 1,
        resumable: false,
        message: '',
        startedAt: '2026-08-08T02:00:00.000Z',
        finishedAt: '2026-08-08T02:30:00.000Z',
        rowsRead: 1,
        rowsWritten: 1,
        rowsFailed: 0,
        throughput: 1,
        checkpoint: '',
      },
    ]);

    expect(summaries[0]?.latestRun).toMatchObject({
      id: 'newer-start-finished-first',
      status: 'succeeded',
    });
  });

  it('treats a queued retry as the latest schedule result', () => {
    const scheduled = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'scheduled-retry-task',
        kind: 'reconcile',
        name: 'Scheduled retry check',
      }),
      {
        lifecycle: 'enabled',
        trigger: {
          mode: 'interval',
          intervalSeconds: 300,
          timezone: 'UTC',
        },
      },
    );
    const summaries = aggregateDataSyncScheduleSummaries([scheduled], [
      {
        id: 'failed-before-retry',
        taskId: scheduled.id,
        taskName: scheduled.name,
        status: 'failed',
        trigger: 'schedule',
        attempt: 1,
        resumable: true,
        message: 'target write failed',
        startedAt: '2026-08-08T01:00:00.000Z',
        finishedAt: '2026-08-08T01:01:00.000Z',
        rowsRead: 1,
        rowsWritten: 0,
        rowsFailed: 1,
        throughput: 0,
        checkpoint: '',
      },
      {
        id: 'queued-retry',
        taskId: scheduled.id,
        taskName: scheduled.name,
        status: 'queued',
        trigger: 'retry',
        attempt: 2,
        resumable: false,
        message: '',
        startedAt: '',
        finishedAt: '',
        queuedAt: '2026-08-08T02:00:00.000Z',
        rowsRead: 0,
        rowsWritten: 0,
        rowsFailed: 0,
        throughput: 0,
        checkpoint: '',
      },
    ]);

    expect(summaries[0]?.latestRun).toMatchObject({
      id: 'queued-retry',
      status: 'queued',
    });
  });

  it('creates versioned defaults for compare and CDC tasks', () => {
    const compare = createDataSyncTaskDraft({
      id: 'compare-1',
      kind: 'compare',
      compareMode: 'schema',
      now: '2026-08-08T00:00:00.000Z',
    });
    const cdc = createDataSyncTaskDraft({
      id: 'cdc-1',
      kind: 'cdc',
      now: '2026-08-08T00:00:00.000Z',
    });

    expect(compare).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      compareMode: 'schema',
      delivery: { writeMode: 'none' },
      trigger: { mode: 'manual' },
      incremental: { mode: 'snapshot' },
    });
    expect(cdc).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      delivery: { writeMode: 'upsert' },
      trigger: { mode: 'continuous' },
      incremental: {
        mode: 'cdc',
        initialSnapshot: false,
        startPosition: 'latest',
        adapter: '',
      },
    });
  });

  it('increments revisions and makes an older preflight stale', () => {
    const task = createDataSyncTaskDraft({
      id: 'task-1',
      kind: 'migration',
      now: '2026-08-08T00:00:00.000Z',
    });
    const snapshot: DataSyncPreflightSnapshot = {
      taskId: task.id,
      taskRevision: task.revision,
      status: 'passed',
      issues: [],
      definitionHash: 'hash-1',
      approvalRequired: false,
      approvalSatisfied: false,
      checkedAt: '2026-08-08T00:01:00.000Z',
    };
    const revised = reviseDataSyncTask(
      task,
      { name: 'Customer migration' },
      '2026-08-08T00:02:00.000Z',
    );

    expect(revised.revision).toBe(2);
    expect(revised.createdAt).toBe(task.createdAt);
    expect(revised.updatedAt).toBe('2026-08-08T00:02:00.000Z');
    expect(isDataSyncPreflightCurrent(task, snapshot)).toBe(true);
    expect(isDataSyncPreflightCurrent(revised, snapshot)).toBe(false);
    expect(canStartDataSyncTask(revised, snapshot)).toBe(false);
    expect(canStartDataSyncTask(task, { ...snapshot, approvalRequired: true })).toBe(
      false,
    );
  });

  it('reports endpoint, mapping, key, and delivery blockers by stage', () => {
    const task = createDataSyncTaskDraft({ id: 'task-2', kind: 'reconcile' });
    const issues = validateDataSyncTask(task);

    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'task_name_required',
        'source_connection_required',
        'target_connection_required',
        'mapping_required',
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'source_object_required' }),
        expect.objectContaining({ code: 'target_object_required' }),
      ]),
    );
    expect(resolveDataSyncPreflightStatus(issues)).toBe('blocked');
  });

  it('builds multiple mappings with safe same-name target suggestions', () => {
    const existing = [createDataSyncTableMapping('empty-row')];
    const migration = buildDataSyncMappingsFromSelection({
      taskId: 'migration-1',
      taskKind: 'migration',
      sourceNames: ['sales.Orders', 'customers', 'CUSTOMERS'],
      targetObjects: [
        { name: 'orders', kind: 'table' },
        { name: 'archive', kind: 'table' },
      ],
      existingMappings: existing,
      keyColumnsBySource: { 'sales.orders': ['id'] },
    });

    expect(migration).toHaveLength(2);
    expect(migration[0]).toMatchObject({
      sourceObject: 'sales.Orders',
      targetObject: 'orders',
      targetMode: 'existing_only',
      keyColumns: ['id'],
    });
    expect(migration[1]).toMatchObject({
      sourceObject: 'customers',
      targetObject: 'customers',
      targetMode: 'create_or_reuse',
    });

    const reconcile = buildDataSyncMappingsFromSelection({
      taskId: 'reconcile-1',
      taskKind: 'reconcile',
      sourceNames: ['missing_target'],
      targetObjects: [],
      existingMappings: [],
    });
    expect(reconcile[0]).toMatchObject({
      sourceObject: 'missing_target',
      targetObject: '',
      targetMode: 'existing_only',
    });
  });

  it('accepts a complete reconcile task and detects duplicate targets', () => {
    const base = createDataSyncTaskDraft({ id: 'task-3', kind: 'reconcile' });
    const first = {
      ...createDataSyncTableMapping('map-1', 'sales.orders', 'ods.orders'),
      keyColumns: ['id'],
    };
    const configured = reviseDataSyncTask(base, {
      name: 'Orders sync',
      source: { ...base.source, connectionId: 'mysql-prod' },
      target: { ...base.target, connectionId: 'pg-warehouse' },
      mappings: [first],
    });

    expect(validateDataSyncTask(configured)).toEqual([]);

    const duplicate = reviseDataSyncTask(configured, {
      mappings: [
        first,
        {
          ...createDataSyncTableMapping('map-2', 'sales.order_lines', 'ODS.ORDERS'),
          keyColumns: ['id'],
        },
      ],
    });
    expect(validateDataSyncTask(duplicate).map((item) => item.code)).toContain(
      'duplicate_target_object',
    );

    const duplicateSource = reviseDataSyncTask(configured, {
      mappings: [
        first,
        {
          ...createDataSyncTableMapping('map-3', 'SALES.ORDERS', 'ods.orders_copy'),
          keyColumns: ['id'],
        },
      ],
    });
    expect(validateDataSyncTask(duplicateSource).map((item) => item.code)).toContain(
      'duplicate_source_object',
    );
  });

  it('requires Cron and watermark configuration without weakening CDC invariants', () => {
    const base = createDataSyncTaskDraft({ id: 'task-4', kind: 'cdc' });
    const invalid = reviseDataSyncTask(base, {
      trigger: { mode: 'cron', expression: '', timezone: '', overlap: 'skip' },
      incremental: {
        mode: 'watermark',
        column: '',
        tieBreaker: '',
        overlapWindowMs: 0,
      },
    });
    const codes = validateDataSyncTask(invalid).map((item) => item.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'cron_expression_required',
        'timezone_required',
        'watermark_column_required',
        'cdc_incremental_required',
        'cdc_trigger_required',
      ]),
    );
  });

  it('auto-matches field names case-insensitively and keeps existing transforms', () => {
    const matched = autoMatchDataSyncFields(
      'orders-map',
      [
        { name: 'ID', type: 'bigint', nullable: false, ordinal: 1, key: true },
        { name: 'amount', type: 'decimal', nullable: false, ordinal: 2, key: false },
        { name: 'source_only', type: 'text', nullable: true, ordinal: 3, key: false },
      ],
      [
        { name: 'id', type: 'int8', nullable: false, ordinal: 1, key: true },
        { name: 'AMOUNT', type: 'numeric', nullable: true, ordinal: 2, key: false },
      ],
      [
        {
          id: 'keep-transform',
          sourceField: 'amount',
          targetField: 'amount',
          sourceType: 'old',
          targetType: 'old',
          transform: 'upper',
          nullable: false,
        },
      ],
    );

    expect(matched).toEqual([
      expect.objectContaining({
        sourceField: 'ID',
        targetField: 'id',
        sourceType: 'bigint',
        targetType: 'int8',
      }),
      expect.objectContaining({
        id: 'keep-transform',
        sourceField: 'amount',
        targetField: 'AMOUNT',
        transform: 'upper',
        nullable: true,
      }),
    ]);
  });

  it('enables row isolation only for CDC or safe data-only atomic SQL routes', () => {
    const base = createDataSyncTaskDraft({ id: 'row-errors', kind: 'reconcile' });
    const safe = reviseDataSyncTask(base, {
      name: 'Safe row isolation',
      source: { ...base.source, connectionId: 'source', type: 'mysql' },
      target: {
        ...base.target,
        connectionId: 'target',
        type: 'postgresql',
      },
      mappings: [
        {
          ...createDataSyncTableMapping('map', 'orders', 'orders'),
          targetMode: 'existing_only',
          keyColumns: ['id'],
        },
      ],
    });
    expect(canUseDataSyncRowErrorIsolation(safe)).toBe(true);
    expect(
      canUseDataSyncRowErrorIsolation({
        ...safe,
        delivery: { ...safe.delivery, autoAddColumns: true },
      }),
    ).toBe(false);
    expect(
      validateDataSyncTask({
        ...safe,
        target: { ...safe.target, type: 'clickhouse' },
        delivery: { ...safe.delivery, errorPolicy: 'quarantine' },
      }).map((item) => item.code),
    ).toContain('row_error_isolation_unsupported');
  });

  it('keeps query sinks to one target mapping and blocks watermark append', () => {
    const query = createDataSyncTaskDraft({ id: 'query', kind: 'querySink' });
    expect(
      validateDataSyncTask({
        ...query,
        delivery: { ...query.delivery, writeMode: 'none' },
      }).map((item) => item.code),
    ).toContain('write_mode_required');
    expect(
      validateDataSyncTask({
        ...query,
        mappings: [
          ...query.mappings,
          createDataSyncTableMapping('query-map-2', '', 'archive'),
        ],
      }).map((item) => item.code),
    ).toContain('query_sink_single_mapping_required');

    const watermark = {
      ...createDataSyncTaskDraft({ id: 'watermark', kind: 'reconcile' }),
      incremental: {
        mode: 'watermark' as const,
        column: 'updated_at',
        tieBreaker: 'id',
        overlapWindowMs: 0,
      },
    };
    expect(
      validateDataSyncTask({
        ...watermark,
        delivery: { ...watermark.delivery, writeMode: 'append', retryLimit: 0 },
      }).map((item) => item.code),
    ).toContain('watermark_append_unsupported');
  });
});
