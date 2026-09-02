import { describe, expect, it } from 'vitest';

import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
} from './model';
import {
  DataSyncGatewayProtocolError,
  decodeDataSyncJobDefinition,
  decodeObjectMetadata,
  decodeDataSyncPreflightQuery,
  decodeRouteCapability,
  decodeRunEvent,
  decodeRunRecord,
  encodeDataSyncJobDefinition,
  requireWailsQueryData,
} from './wailsDto';

const configuredTask = (
  kind: 'migration' | 'reconcile' | 'querySink' | 'compare' | 'cdc' = 'reconcile',
) => {
  const draft = createDataSyncTaskDraft({
    id: `persisted-${kind}`,
    kind,
    name: `${kind} task`,
    now: '2026-08-08T00:00:00.000Z',
  });
  return reviseDataSyncTask(
    draft,
    {
      lifecycle: 'ready',
      source: {
        connectionId: 'source-id',
        connectionName: 'Source',
        type: 'mysql',
        database: 'sales',
        schema: 'public',
      },
      target: {
        connectionId: 'target-id',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'warehouse',
        schema: 'ods',
      },
      mappings: [
        {
          ...createDataSyncTableMapping('map-1', 'public.orders', 'ods.orders'),
          targetMode: 'create_or_reuse',
          keyColumns: ['id'],
          fields: [
            {
              id: 'field-1',
              sourceField: 'name',
              targetField: 'name',
              sourceType: 'varchar',
              targetType: 'text',
              transform: 'trim',
              transformArgument: '{"unicode":true}',
              nullable: false,
            },
          ],
        },
      ],
    },
    '2026-08-08T00:01:00.000Z',
  );
};

describe('data sync Wails DTO boundary', () => {
  it('decodes optional object size metadata without inventing missing values', () => {
    expect(
      decodeObjectMetadata(
        [
          {
            Table: 'orders',
            Rows: '1250',
            Data_length: '65536',
            Index_length: '16384',
          },
          { Table: 'empty_table', Rows: '0' },
          { Table: 'unknown_size' },
        ],
        'mysql',
      ),
    ).toEqual([
      {
        name: 'orders',
        kind: 'table',
        rowCount: 1250,
        dataBytes: 65536,
        indexBytes: 16384,
      },
      { name: 'empty_table', kind: 'table', rowCount: 0 },
      { name: 'unknown_size', kind: 'table' },
    ]);
  });

  it('decodes route target capabilities and defaults absent flags to false', () => {
    expect(
      decodeRouteCapability({
        supportLevel: 'full',
        canExecute: true,
        supportsAutoCreate: true,
        supportsAutoAddColumns: true,
        requiresExistingTarget: true,
        supportsMutations: true,
      }),
    ).toMatchObject({
      level: 'full',
      canExecute: true,
      supportsAutoCreate: true,
      supportsAutoAddColumns: true,
      requiresExistingTarget: true,
      supportsMutations: true,
    });
    expect(
      decodeRouteCapability({
        supportLevel: 'partial',
        canExecute: true,
        supportsAutoCreate: false,
      }),
    ).toMatchObject({
      supportsAutoAddColumns: false,
      requiresExistingTarget: false,
      supportsMutations: false,
    });
  });

  it('round-trips versioned delivery, mapping, schedule, and target strategy fields', () => {
    const task = reviseDataSyncTask(configuredTask(), {
      delivery: {
        ...configuredTask().delivery,
        writeMode: 'upsert',
        errorPolicy: 'stop',
        batchSize: 250,
        commitEvery: 250,
        retryLimit: 4,
        retryBackoffMs: 750,
        autoAddColumns: true,
        createIndexes: true,
        propagateDeletes: true,
        captureErrorPayload: false,
      },
      trigger: {
        mode: 'cron',
        expression: '0 */5 * * * *',
        timezone: 'Asia/Shanghai',
        overlap: 'queue',
      },
      concurrencyPolicy: 'queue',
      resumePolicy: 'auto',
    });
    const wire = encodeDataSyncJobDefinition(task, {
      approval: { definitionHash: 'untrusted' },
    });

    expect(wire).not.toHaveProperty('approval');
    expect(wire).toMatchObject({
      kind: 'reconcile',
      incrementalMode: 'snapshot',
      concurrencyPolicy: 'queue',
      resumePolicy: 'auto',
      options: {
        syncMode: 'insert_update',
        targetTableStrategy: 'smart',
        batchSize: 250,
        maxRetries: 4,
        retryBackoffMillis: 750,
      },
      schedule: { kind: 'cron', cronExpression: '0 */5 * * * *' },
    });
    expect(decodeDataSyncJobDefinition(wire)).toMatchObject({
      kind: 'reconcile',
      delivery: {
        writeMode: 'upsert',
        batchSize: 250,
        retryLimit: 4,
        retryBackoffMs: 750,
      },
      trigger: { mode: 'cron', overlap: 'queue' },
      concurrencyPolicy: 'queue',
      resumePolicy: 'auto',
    });
  });

  it('maps query sink, compare content, and CDC into backend wire values', () => {
    const querySink = reviseDataSyncTask(configuredTask('querySink'), {
      sourceQuery: 'SELECT id FROM orders',
    });
    const compare = configuredTask('compare');
    const schemaMigrationBase = configuredTask('migration');
    const schemaMigration = reviseDataSyncTask(schemaMigrationBase, {
      content: 'schema',
      delivery: {
        ...schemaMigrationBase.delivery,
        autoAddColumns: true,
      },
    });
    const cdcBase = configuredTask('cdc');
    const cdc = reviseDataSyncTask(cdcBase, {
      incremental: {
        mode: 'cdc',
        initialSnapshot: false,
        startPosition: 'latest',
        adapter: 'mongodb-change-stream',
        slotName: '',
        publicationName: '',
      },
      trigger: { mode: 'continuous' },
    });

    expect(encodeDataSyncJobDefinition(querySink)).toMatchObject({
      kind: 'query_sink',
      sourceQuery: 'SELECT id FROM orders',
      options: { syncMode: 'insert_only', maxRetries: 0 },
    });
    expect(encodeDataSyncJobDefinition(compare)).toMatchObject({
      kind: 'compare',
      options: { content: 'data' },
    });
    const schemaMigrationWire = encodeDataSyncJobDefinition(schemaMigration);
    expect(schemaMigrationWire).toMatchObject({
      kind: 'migration',
      options: { content: 'schema', autoAddColumns: true },
    });
    expect(decodeDataSyncJobDefinition(schemaMigrationWire)).toMatchObject({
      kind: 'migration',
      content: 'schema',
      delivery: { autoAddColumns: true },
    });
    expect(encodeDataSyncJobDefinition(cdc)).toMatchObject({
      kind: 'reconcile',
      incrementalMode: 'cdc',
      cdc: {
        adapter: 'mongodb-change-stream',
        initialSnapshot: false,
        startPosition: 'latest',
      },
    });
  });

  it('defaults omitted CDC fields for legacy or un-preflighted draft jobs', () => {
    const cdc = reviseDataSyncTask(configuredTask('cdc'), {
      incremental: {
        mode: 'cdc',
        initialSnapshot: false,
        startPosition: 'latest',
        adapter: 'mongodb-change-stream',
        slotName: '',
        publicationName: '',
      },
      trigger: { mode: 'continuous' },
    });
    const legacyWire = JSON.parse(JSON.stringify(encodeDataSyncJobDefinition(cdc))) as {
      cdc: Record<string, unknown>;
    };
    delete legacyWire.cdc.initialSnapshot;
    delete legacyWire.cdc.adapter;

    expect(decodeDataSyncJobDefinition(legacyWire)).toMatchObject({
      incremental: {
        mode: 'cdc',
        initialSnapshot: false,
        adapter: '',
      },
    });
  });

  it('round-trips schema-only migration content and column repair settings', () => {
    const base = createDataSyncTaskDraft({
      id: 'schema-migration',
      kind: 'migration',
      content: 'schema',
    });
    const task = reviseDataSyncTask(base, {
      name: 'Schema migration',
      source: {
        ...base.source,
        connectionId: 'source-id',
        type: 'mysql',
        database: 'source',
        schema: 'source_schema',
      },
      target: {
        ...base.target,
        connectionId: 'target-id',
        type: 'postgresql',
        database: 'target',
        schema: 'target_schema',
      },
      mappings: [
        createDataSyncTableMapping('schema-map', 'orders', 'orders'),
      ],
    });

    const wire = encodeDataSyncJobDefinition(task);
    expect(wire).toMatchObject({
      kind: 'migration',
      options: {
        content: 'schema',
        autoAddColumns: true,
      },
      mappings: [
        {
          sourceSchema: 'source_schema',
          sourceTable: 'orders',
          targetSchema: 'target_schema',
          targetTable: 'orders',
        },
      ],
    });
    expect(decodeDataSyncJobDefinition(wire)).toMatchObject({
      kind: 'migration',
      content: 'schema',
      delivery: { autoAddColumns: true },
    });
  });

  it('preserves data-only defaults for legacy migrations without options', () => {
    const task = configuredTask('migration');
    const legacyWire = JSON.parse(JSON.stringify(encodeDataSyncJobDefinition(task))) as {
      options: Record<string, unknown>;
    };
    delete legacyWire.options.content;
    delete legacyWire.options.autoAddColumns;

    const decoded = decodeDataSyncJobDefinition(legacyWire);
    expect(decoded).toMatchObject({
      kind: 'migration',
      content: 'data',
      delivery: { autoAddColumns: false },
    });
    expect(encodeDataSyncJobDefinition(decoded)).toMatchObject({
      kind: 'migration',
      options: {
        content: 'data',
        autoAddColumns: false,
      },
    });
  });

  it('fails closed for malformed QueryResult and unsafe policies', () => {
    expect(() => requireWailsQueryData({ success: true }, 'Example')).toThrow(
      DataSyncGatewayProtocolError,
    );
    expect(() => requireWailsQueryData({ success: false, data: [] }, 'Example')).toThrow(
      DataSyncGatewayProtocolError,
    );

    const snapshot = configuredTask('migration');
    expect(() =>
      encodeDataSyncJobDefinition(
        reviseDataSyncTask(snapshot, {
          delivery: { ...snapshot.delivery, errorPolicy: 'skip' },
        }),
      ),
    ).toThrow('row isolation requires');

    const querySink = configuredTask('querySink');
    expect(() =>
      encodeDataSyncJobDefinition(
        reviseDataSyncTask(querySink, {
          delivery: { ...querySink.delivery, writeMode: 'none' },
        }),
      ),
    ).toThrow('requires an explicit delivery mode');
    expect(() =>
      encodeDataSyncJobDefinition(
        reviseDataSyncTask(querySink, {
          delivery: { ...querySink.delivery, retryLimit: 1 },
        }),
      ),
    ).toThrow('requires retryLimit 0');
  });

  it('requires a sequence for run events because pagination uses it as a cursor', () => {
    expect(() =>
      decodeRunEvent(
        {
          runId: 'run-1',
          type: 'log',
          createdAt: Date.parse('2026-08-08T00:00:00.000Z'),
        },
        'event',
      ),
    ).toThrow('event.sequence');
  });

  it('encodes safe snapshot row isolation and preserves per-mapping watermarks', () => {
    const base = configuredTask('reconcile');
    const safeIsolation = reviseDataSyncTask(base, {
      mappings: base.mappings.map((mapping) => ({
        ...mapping,
        targetMode: 'existing_only',
      })),
      delivery: {
        ...base.delivery,
        errorPolicy: 'quarantine',
        captureErrorPayload: true,
      },
    });
    expect(encodeDataSyncJobDefinition(safeIsolation)).toMatchObject({
      options: { errorPolicy: 'skip_row', captureErrorPayload: true },
    });

    const second = {
      ...createDataSyncTableMapping('map-2', 'public.customers', 'ods.customers'),
      keyColumns: ['customer_id'],
      watermark: { column: 'modified_at', tieBreaker: 'customer_id' },
    };
    const watermark = reviseDataSyncTask(base, {
      incremental: {
        mode: 'watermark',
        column: 'updated_at',
        tieBreaker: 'id',
        overlapWindowMs: 0,
      },
      mappings: [
        {
          ...base.mappings[0],
          watermark: { column: 'updated_at', tieBreaker: 'id' },
        },
        second,
      ],
    });
    const decoded = decodeDataSyncJobDefinition(
      encodeDataSyncJobDefinition(watermark),
    );
    expect(decoded.mappings.map((mapping) => mapping.watermark)).toEqual([
      { column: 'updated_at', tieBreaker: 'id' },
      { column: 'modified_at', tieBreaker: 'customer_id' },
    ]);
  });

  it('accepts only a structured blocked payload when preflight success is false', () => {
    const task = configuredTask();
    const definition = encodeDataSyncJobDefinition(task);
    const blocked = decodeDataSyncPreflightQuery(
      {
        success: false,
        message: 'blocked',
        data: {
          status: 'blocked',
          definition,
          definitionHash: 'hash',
          approvalRequired: false,
          capability: {
            supportLevel: 'full',
            canExecute: true,
            supportsAutoCreate: true,
          },
          issues: [
            {
              code: 'route_unsupported',
              severity: 'blocker',
              stage: 'endpoints',
              message: 'unsupported route',
            },
            {
              code: 'unmigrated_index',
              severity: 'warning',
              stage: 'mappings',
              message: 'index requires review',
              detail: {
                unmigratedIndex: {
                  name: 'idx_name_prefix',
                  columns: [{ name: 'name', prefixLength: 12 }],
                  unique: false,
                  indexType: 'BTREE',
                  reasonCode: 'prefix_index_requires_review',
                  reason: 'index requires review',
                  remediationStatements: ['CREATE INDEX idx_name_prefix ON public.users (left(name, 12))'],
                },
              },
            },
          ],
          checkedAt: Date.parse('2026-08-08T00:02:00.000Z'),
        },
      },
      task,
    );

    expect(blocked.snapshot).toMatchObject({
      status: 'blocked',
      approvalSatisfied: false,
      issues: [
        { message: 'unsupported route' },
        {
          detail: {
            unmigratedIndex: {
              name: 'idx_name_prefix',
              reasonCode: 'prefix_index_requires_review',
              remediationStatements: ['CREATE INDEX idx_name_prefix ON public.users (left(name, 12))'],
            },
          },
        },
      ],
    });
    const earlyBlocked = decodeDataSyncPreflightQuery(
      {
        success: false,
        data: {
          status: 'blocked',
          definition,
          approvalRequired: false,
          issues: [
            {
              code: 'definition_invalid',
              severity: 'blocker',
              stage: 'endpoints',
              message: 'invalid definition',
            },
          ],
          checkedAt: Date.parse('2026-08-08T00:02:00.000Z'),
        },
      },
      task,
    );
    expect(earlyBlocked.capability).toMatchObject({
      level: 'unknown',
      canExecute: false,
    });
    expect(() =>
      decodeDataSyncPreflightQuery(
        { success: false, data: { ...blocked, status: 'passed' } },
        task,
      ),
    ).toThrow(DataSyncGatewayProtocolError);
  });

  it('decodes compareMode from a run definition snapshot', () => {
    const baseRun = {
      id: 'run-1',
      jobId: 'job-1',
      status: 'succeeded',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      queuedAt: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsDeleted: 0,
      rowsFailed: 0,
    };
    const schemaRun = decodeRunRecord(
      {
        ...baseRun,
        definitionSnapshot: {
          kind: 'compare',
          options: { content: 'schema' },
        },
      },
      new Map(),
    );
    expect(schemaRun.compareMode).toBe('schema');

    const dataRun = decodeRunRecord(
      {
        ...baseRun,
        definitionSnapshot: {
          kind: 'compare',
          options: { content: 'data' },
        },
      },
      new Map(),
    );
    expect(dataRun.compareMode).toBe('data');

    const migrationRun = decodeRunRecord(
      {
        ...baseRun,
        definitionSnapshot: {
          kind: 'migration',
          options: { content: 'both' },
        },
      },
      new Map(),
    );
    expect(migrationRun.compareMode).toBeUndefined();

    const noSnapshotRun = decodeRunRecord(baseRun, new Map());
    expect(noSnapshotRun.compareMode).toBeUndefined();
  });
});
