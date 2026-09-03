import { describe, expect, it } from 'vitest';

import { buildIndexCreateSqlPreview } from './tableDesignerIndexSql';
import {
  hasIndexFormChanged,
  normalizeIndexFormFromRow,
  resolveIndexMetadataResponse,
  shouldRestoreOriginalIndex,
  toggleIndexSelection,
  type IndexDisplaySnapshot,
  type IndexFormSnapshot,
} from './tableDesignerIndexUtils';

describe('tableDesignerIndexUtils', () => {
  it('normalizes index rows for edit form reuse', () => {
    const row: IndexDisplaySnapshot = {
      key: 'idx_user_name',
      name: 'idx_user_name',
      indexType: 'btree',
      nonUnique: 0,
      columnNames: ['name'],
    };

    expect(normalizeIndexFormFromRow(row, ['NORMAL', 'UNIQUE', 'PRIMARY', 'FULLTEXT', 'SPATIAL'])).toEqual({
      name: 'idx_user_name',
      columnNames: ['name'],
      kind: 'UNIQUE',
      indexType: 'BTREE',
    });
  });

  it('preserves SQL Server existing index metadata for create preview reuse', () => {
    const row: IndexDisplaySnapshot = {
      key: 'IX_Users_Email',
      name: 'IX_Users_Email',
      indexType: 'nonclustered',
      nonUnique: 0,
      columnNames: ['email'],
    };

    const form = normalizeIndexFormFromRow(row, ['NORMAL', 'UNIQUE']);
    expect(form).toEqual({
      name: 'IX_Users_Email',
      columnNames: ['email'],
      kind: 'UNIQUE',
      indexType: 'NONCLUSTERED',
    });

    expect(buildIndexCreateSqlPreview({
      dbType: 'sqlserver',
      tableRef: '[dbo].[Users]',
      name: form.name,
      columnNames: form.columnNames,
      kind: form.kind,
      indexType: form.indexType,
    }).sql).toBe('CREATE UNIQUE NONCLUSTERED INDEX [IX_Users_Email] ON [dbo].[Users] ([email]);');
  });

  it('detects no-op index edits as unchanged', () => {
    const previousForm: IndexFormSnapshot = {
      name: 'idx_user_name',
      columnNames: ['name'],
      kind: 'UNIQUE',
      indexType: 'BTREE',
    };
    const nextForm: IndexFormSnapshot = {
      name: 'idx_user_name',
      columnNames: ['name'],
      kind: 'UNIQUE',
      indexType: 'BTREE',
    };

    expect(hasIndexFormChanged(previousForm, nextForm)).toBe(false);
  });

  it('marks edits as changed when index columns differ', () => {
    const previousForm: IndexFormSnapshot = {
      name: 'idx_user_name',
      columnNames: ['name'],
      kind: 'NORMAL',
      indexType: 'DEFAULT',
    };
    const nextForm: IndexFormSnapshot = {
      name: 'idx_user_name',
      columnNames: ['name', 'email'],
      kind: 'NORMAL',
      indexType: 'DEFAULT',
    };

    expect(hasIndexFormChanged(previousForm, nextForm)).toBe(true);
  });

  it('toggles selected index keys without duplicates', () => {
    expect(toggleIndexSelection([], 'idx_user_name', true)).toEqual(['idx_user_name']);
    expect(toggleIndexSelection(['idx_user_name'], 'idx_user_name', true)).toEqual(['idx_user_name']);
    expect(toggleIndexSelection(['idx_user_name'], 'idx_user_name')).toEqual([]);
  });

  it('keeps single-selection toggles stable across repeated clicks', () => {
    let selected = toggleIndexSelection([], 'idx_user_name');
    expect(selected).toEqual(['idx_user_name']);

    selected = toggleIndexSelection(selected, 'idx_user_name');
    expect(selected).toEqual([]);

    selected = toggleIndexSelection(selected, 'idx_user_name');
    expect(selected).toEqual(['idx_user_name']);

    selected = toggleIndexSelection(selected, 'idx_user_email');
    expect(selected).toEqual(['idx_user_name', 'idx_user_email']);

    selected = toggleIndexSelection(selected, 'idx_user_email');
    expect(selected).toEqual(['idx_user_name']);

    selected = toggleIndexSelection(selected, 'idx_user_name');
    expect(selected).toEqual([]);
  });

  it('keeps index metadata failures distinguishable from a successful empty list', () => {
    expect(resolveIndexMetadataResponse({
      success: false,
      data: null,
      message: 'invalid column name OWNER',
    })).toEqual({
      indexes: [],
      errorDetail: 'invalid column name OWNER',
    });

    expect(resolveIndexMetadataResponse({
      success: true,
      data: [],
      message: '',
    })).toEqual({
      indexes: [],
      errorDetail: null,
    });
  });

  it('only restores original index when create step fails after drop step', () => {
    expect(shouldRestoreOriginalIndex({ failedStatementIndex: 1 })).toBe(true);
    expect(shouldRestoreOriginalIndex({ failedStatementIndex: 0 })).toBe(false);
    expect(shouldRestoreOriginalIndex({})).toBe(false);
    expect(shouldRestoreOriginalIndex({ failedStatementIndex: 1, outcomeUnknown: true })).toBe(false);
    expect(shouldRestoreOriginalIndex({ failedStatementIndex: 1, cancellationState: 'unsupported' })).toBe(false);
  });
});
