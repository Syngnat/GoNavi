import { describe, expect, it } from 'vitest';
import {
  buildDataSyncAnalysisFingerprint,
  buildInitialDataSyncTableOptions,
  buildDataSyncRequest,
  validateDataSyncExecutionReadiness,
  validateDataSyncSelection,
} from './dataSyncRequest';

describe('validateDataSyncSelection', () => {
  it('requires source query and single target table in query mode', () => {
    expect(validateDataSyncSelection({
      sourceDatasetMode: 'query',
      selectedTables: [],
      sourceQuery: '',
      syncContent: 'data',
    })).toBe('data_sync.validation.source_query_required');

    expect(validateDataSyncSelection({
      sourceDatasetMode: 'query',
      selectedTables: [],
      sourceQuery: 'select 1',
      syncContent: 'data',
    })).toBe('data_sync.validation.single_target_table_required');

    expect(validateDataSyncSelection({
      sourceDatasetMode: 'query',
      selectedTables: ['users', 'orders'],
      sourceQuery: 'select 1',
      syncContent: 'data',
    })).toBe('data_sync.validation.single_target_table_required');
  });

  it('forces data-only in query mode', () => {
    expect(validateDataSyncSelection({
      sourceDatasetMode: 'query',
      selectedTables: ['users'],
      sourceQuery: 'select 1',
      syncContent: 'both',
    })).toBe('data_sync.validation.query_mode_data_only');
  });
});

describe('buildDataSyncRequest', () => {
  it('normalizes query mode payload for backend', () => {
    const payload = buildDataSyncRequest({
      sourceConfig: { type: 'mysql' },
      targetConfig: { type: 'mysql' },
      sourceDatabase: ' app ',
      targetDatabase: ' warehouse ',
      targetSchema: ' reporting ',
      selectedTables: ['users'],
      sourceDatasetMode: 'query',
      sourceQuery: '  SELECT id, name FROM active_users  ',
      syncContent: 'both',
      syncMode: 'insert_update',
      autoAddColumns: true,
      targetTableStrategy: 'smart',
      createIndexes: true,
      mongoCollectionName: '  ',
      jobId: 'job-1',
      tableOptions: { users: { insert: true, update: true, delete: false } },
    });

    expect(payload).toMatchObject({
      tables: ['users'],
      sourceQuery: 'SELECT id, name FROM active_users',
      content: 'data',
      mode: 'insert_update',
      autoAddColumns: false,
      targetTableStrategy: 'existing_only',
      createIndexes: false,
      sourceDatabase: 'app',
      targetDatabase: 'warehouse',
      targetSchema: 'reporting',
      jobId: 'job-1',
    });
  });

  it('keeps separate databases when one MySQL connection is used for both endpoints', () => {
    const payload = buildDataSyncRequest({
      sourceConfig: { id: 'mysql-1', type: 'mysql', database: 'source_db' },
      targetConfig: { id: 'mysql-1', type: 'mysql', database: 'target_db' },
      sourceDatabase: 'source_db',
      targetDatabase: 'target_db',
      selectedTables: ['users'],
      sourceDatasetMode: 'table',
      sourceQuery: '',
      syncContent: 'data',
      syncMode: 'insert_only',
      autoAddColumns: false,
      targetTableStrategy: 'existing_only',
      createIndexes: false,
      mongoCollectionName: '',
    });

    expect(payload.sourceConfig.database).toBe('source_db');
    expect(payload.targetConfig.database).toBe('target_db');
    expect(payload.sourceDatabase).toBe('source_db');
    expect(payload.targetDatabase).toBe('target_db');
    expect(payload.mode).toBe('insert_only');
  });
});

const baseFingerprintInput = {
  sourceConnectionId: 'mysql-1',
  targetConnectionId: 'mysql-1',
  sourceDatabase: 'source_db',
  targetDatabase: 'target_db',
  targetSchema: '',
  selectedTables: ['users', 'orders'],
  sourceDatasetMode: 'table' as const,
  sourceQuery: '',
  syncContent: 'data' as const,
  syncMode: 'insert_update',
  autoAddColumns: true,
  targetTableStrategy: 'existing_only' as const,
  createIndexes: false,
  mongoCollectionName: '',
};

describe('buildDataSyncAnalysisFingerprint', () => {
  it('ignores table order but changes when an execution input changes', () => {
    const fingerprint = buildDataSyncAnalysisFingerprint(baseFingerprintInput);

    expect(buildDataSyncAnalysisFingerprint({
      ...baseFingerprintInput,
      selectedTables: ['orders', 'users'],
    })).toBe(fingerprint);
    expect(buildDataSyncAnalysisFingerprint({
      ...baseFingerprintInput,
      targetDatabase: 'archive_db',
    })).not.toBe(fingerprint);
    expect(buildDataSyncAnalysisFingerprint({
      ...baseFingerprintInput,
      syncMode: 'insert_only',
    })).not.toBe(fingerprint);
  });
});

describe('buildInitialDataSyncTableOptions', () => {
  it('enables only operations represented by insert-update analysis', () => {
    expect(buildInitialDataSyncTableOptions({
      canSync: true,
      inserts: 3,
      updates: 0,
      deletes: 2,
    }, 'insert_update')).toMatchObject({
      insert: true,
      update: false,
      delete: false,
    });
  });

  it('keeps only insert enabled for direct import modes', () => {
    expect(buildInitialDataSyncTableOptions({ canSync: true, inserts: 0 }, 'insert_only'))
      .toMatchObject({ insert: true, update: false, delete: false });
    expect(buildInitialDataSyncTableOptions({ canSync: true, inserts: 0 }, 'full_overwrite'))
      .toMatchObject({ insert: true, update: false, delete: false });
    expect(buildInitialDataSyncTableOptions({ canSync: false, inserts: 5 }, 'full_overwrite'))
      .toMatchObject({ insert: false, update: false, delete: false });
  });

  it('keeps insert enabled when insert-update must create an empty target', () => {
    expect(buildInitialDataSyncTableOptions({
      canSync: true,
      inserts: 0,
      targetTableExists: false,
    }, 'insert_update')).toMatchObject({
      insert: true,
      update: false,
      delete: false,
    });
  });
});

describe('validateDataSyncExecutionReadiness', () => {
  const currentFingerprint = buildDataSyncAnalysisFingerprint(baseFingerprintInput);
  const readyTables = [
    { table: 'users', canSync: true, inserts: 2, updates: 0, deletes: 0, targetTableExists: true },
    { table: 'orders', canSync: true, inserts: 0, updates: 3, deletes: 0, targetTableExists: true },
  ];
  const readyTableOptions = {
    users: { insert: true, update: false, delete: false },
    orders: { insert: false, update: true, delete: false },
  };
  const baseReadinessInput = {
    requiresAnalysis: true,
    syncContent: 'data' as const,
    syncMode: 'insert_update',
    currentFingerprint,
    analyzedFingerprint: currentFingerprint,
    selectedTables: baseFingerprintInput.selectedTables,
    analyzedTables: readyTables,
    tableOptions: readyTableOptions,
  };

  it('requires a current analysis covering every selected table', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      analyzedFingerprint: 'stale',
    })).toMatchObject({ ready: false, reason: 'analysis_required' });

    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      analyzedTables: readyTables.slice(0, 1),
    })).toMatchObject({ ready: false, reason: 'table_not_analyzed', table: 'orders' });
  });

  it('blocks an analyzed table that the backend cannot safely synchronize', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      analyzedTables: [
        readyTables[0],
        { table: 'orders', canSync: false, message: '没有主键' },
      ],
    })).toEqual({
      ready: false,
      reason: 'table_not_syncable',
      table: 'orders',
      message: '没有主键',
    });
  });

  it('allows execution only when the current analysis is fully runnable', () => {
    expect(validateDataSyncExecutionReadiness(baseReadinessInput)).toEqual({ ready: true });
    expect(validateDataSyncExecutionReadiness({
      requiresAnalysis: false,
      syncContent: 'schema',
      syncMode: 'insert_update',
      currentFingerprint: '',
      analyzedFingerprint: '',
      selectedTables: [],
      analyzedTables: [],
      tableOptions: {},
    })).toEqual({ ready: true });
  });

  it('blocks a full overwrite when insert has been disabled', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      syncMode: 'full_overwrite',
      selectedTables: ['users'],
      analyzedTables: [{
        table: 'users',
        canSync: true,
        inserts: 0,
        targetTableExists: true,
      }],
      tableOptions: {
        users: { insert: false, update: true, delete: false },
      },
    })).toEqual({
      ready: false,
      reason: 'full_overwrite_insert_required',
      table: 'users',
    });
  });

  it('allows a full overwrite with insert enabled even when the source is empty', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      syncMode: 'full_overwrite',
      selectedTables: ['users'],
      analyzedTables: [{
        table: 'users',
        canSync: true,
        inserts: 0,
        targetTableExists: true,
      }],
      tableOptions: {
        users: { insert: true, update: false, delete: false },
      },
    })).toEqual({ ready: true });
  });

  it('blocks insert-only when insert has been disabled', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      syncMode: 'insert_only',
      selectedTables: ['users'],
      analyzedTables: [{
        table: 'users',
        canSync: true,
        inserts: 2,
        targetTableExists: true,
      }],
      tableOptions: {
        users: { insert: false, update: true, delete: false },
      },
    })).toEqual({
      ready: false,
      reason: 'insert_required',
      table: 'users',
    });
  });

  it('blocks a task with no effective data operation or structural work', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      tableOptions: {
        users: { insert: false, update: false, delete: false },
        orders: { insert: false, update: false, delete: false },
      },
    })).toEqual({ ready: false, reason: 'no_effective_operations' });
  });

  it('allows structure work for both mode and an empty auto-created target', () => {
    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      syncContent: 'both',
      selectedTables: ['users'],
      analyzedTables: [{
        table: 'users',
        canSync: true,
        inserts: 0,
        schemaDiffCount: 1,
        targetTableExists: true,
      }],
      tableOptions: {
        users: { insert: false, update: false, delete: false },
      },
    })).toEqual({ ready: true });

    expect(validateDataSyncExecutionReadiness({
      ...baseReadinessInput,
      selectedTables: ['users'],
      analyzedTables: [{
        table: 'users',
        canSync: true,
        inserts: 0,
        schemaDiffCount: 0,
        targetTableExists: false,
      }],
      tableOptions: {
        users: { insert: false, update: false, delete: false },
      },
    })).toEqual({ ready: true });
  });
});
