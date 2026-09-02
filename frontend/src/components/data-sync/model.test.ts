import { describe, expect, it } from 'vitest';

import {
  autoMatchDataSyncFields,
  canUseDataSyncRowErrorIsolation,
  canStartDataSyncTask,
  buildDataSyncMappingsFromSelection,
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  isDataSyncPreflightCurrent,
  resolveDataSyncPreflightStatus,
  reviseDataSyncTask,
  validateDataSyncTask,
  type DataSyncPreflightSnapshot,
} from './model';

describe('data sync task model', () => {
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

  it('creates a writable schema-only migration draft with automatic column repair', () => {
    const schemaMigration = createDataSyncTaskDraft({
      id: 'schema-migration-1',
      kind: 'migration',
      content: 'schema',
      now: '2026-08-08T00:00:00.000Z',
    });

    expect(schemaMigration).toMatchObject({
      kind: 'migration',
      content: 'schema',
      delivery: {
        writeMode: 'upsert',
        autoAddColumns: true,
      },
    });
  });

  it('defaults structure+data migration drafts to automatic column repair', () => {
    const migration = createDataSyncTaskDraft({
      id: 'migration-default',
      kind: 'migration',
      now: '2026-08-08T00:00:00.000Z',
    });

    // issue #1014：目标表缺列时必须默认补列并回填，否则字段同步不动。
    expect(migration.delivery.autoAddColumns).toBe(true);
    expect(migration.content).toBe('both');
  });

  it('preserves the persisted revision and makes an older preflight stale after editing', () => {
    const task = createDataSyncTaskDraft({
      id: 'task-1',
      kind: 'migration',
      now: '2026-08-08T00:00:00.000Z',
    });
    const snapshot: DataSyncPreflightSnapshot = {
      taskId: task.id,
      taskRevision: task.revision,
      taskEditEpoch: task.editEpoch,
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

    expect(revised.revision).toBe(task.revision);
    expect(revised.editEpoch).toBe(task.editEpoch + 1);
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

  it('defers snapshot stable-key validation to backend metadata while retaining CDC validation', () => {
    const base = createDataSyncTaskDraft({ id: 'task-keyless', kind: 'reconcile' });
    const keylessSnapshot = reviseDataSyncTask(base, {
      name: 'Keyless initial import',
      source: { ...base.source, connectionId: 'mysql-prod' },
      target: { ...base.target, connectionId: 'pg-warehouse' },
      mappings: [
        {
          ...createDataSyncTableMapping('map-keyless', 'orders', 'ods.orders'),
          targetMode: 'create_or_reuse',
        },
      ],
    });

    expect(validateDataSyncTask(keylessSnapshot).map((item) => item.code)).not.toContain(
      'key_columns_required',
    );

    const cdc = {
      ...keylessSnapshot,
      kind: 'cdc' as const,
      trigger: { mode: 'continuous' as const },
      incremental: {
        mode: 'cdc' as const,
        initialSnapshot: false,
        startPosition: 'latest' as const,
        adapter: 'mongodb-change-stream',
        slotName: '',
        publicationName: '',
      },
    };
    expect(validateDataSyncTask(cdc).map((item) => item.code)).toContain(
      'key_columns_required',
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
    expect(query.resumePolicy).toBe('never');
    expect(
      validateDataSyncTask({
        ...query,
        resumePolicy: 'manual',
      }).map((item) => item.code),
    ).toContain('append_resume_unsafe');
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
