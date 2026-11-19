import { describe, expect, it } from 'vitest';
import { buildDataGridCommitChangeSet } from './dataGrid/core/dataGridCommitChangeSet';
import { GONAVI_ROW_KEY } from './dataGrid/core/dataGridCellKeys';
import { normalizeDataGridCommitCellValue } from './dataGridCommitValues';

const normalize = (type: string, value: unknown, mode: 'insert' | 'update' = 'update') => (
  normalizeDataGridCommitCellValue({
    columnName: 'INSTCODE',
    value,
    mode,
    dbType: 'postgresql',
    meta: { type },
  })
);

describe('normalizeDataGridCommitCellValue', () => {
  it.each([
    'NUMBER(10,2)',
    'numeric(18,4)',
    'decimal(30,10)',
    'Int32',
    'UInt64',
    'BIGINT',
    'DOUBLE PRECISION',
    'BINARY_DOUBLE',
    'MONEY',
  ])('recognizes %s as a numeric commit type', (type) => {
    expect(normalize(type, '1192')).toBe(1192);
  });

  it('turns safe integer text into a number for numeric columns', () => {
    expect(normalize('NUMBER', '1192')).toBe(1192);
    expect(normalize('NUMBER(10,2)', '1192.50')).toBe(1192.5);
    expect(normalize('BIGINT', '-001192')).toBe(-1192);
  });

  it('keeps integer text outside the JavaScript safe range unchanged', () => {
    expect(normalize('BIGINT', '9007199254740991')).toBe(9007199254740991);
    expect(normalize('BIGINT', '9007199254740992')).toBe('9007199254740992');
    expect(normalize('BIGINT', '-9007199254740992')).toBe('-9007199254740992');
  });

  it('keeps high-precision decimal text unchanged', () => {
    expect(normalize('DECIMAL(30,20)', '0.10000000000000001')).toBe('0.10000000000000001');
    expect(normalize('NUMERIC', '12345678901234567890.123')).toBe('12345678901234567890.123');
  });

  it('does not coerce numeric-looking text in non-numeric columns', () => {
    expect(normalize('VARCHAR(20)', '1192')).toBe('1192');
    expect(normalize('TEXT', '9007199254740992')).toBe('9007199254740992');
  });

  it('preserves null, undefined, and blank values', () => {
    expect(normalize('NUMBER', null)).toBeNull();
    expect(normalize('NUMBER', undefined)).toBeUndefined();
    expect(normalize('NUMBER', '')).toBe('');
    expect(normalize('NUMBER', '   ')).toBe('   ');
  });

  it('keeps numeric grid edits typed in the submitted change set', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        '1': { INSTCODE: '1192' },
      },
      deletedRowKeys: new Set<string>(),
      data: [{ [GONAVI_ROW_KEY]: 1, INSTCODE: 0, ROWID: 105258 }],
      editLocator: {
        strategy: 'all-columns',
        columns: ['INSTCODE', 'ROWID'],
        valueColumns: ['INSTCODE', 'ROWID'],
        readOnly: false,
      },
      visibleColumnNames: ['INSTCODE', 'ROWID'],
      rowKeyToString: String,
      normalizeCommitCellValue: (columnName, value, mode) => normalizeDataGridCommitCellValue({
        columnName,
        value,
        mode,
        dbType: 'postgresql',
        meta: { type: columnName === 'INSTCODE' ? 'NUMBER' : 'BIGINT' },
      }),
      shouldCommitColumn: () => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.updates).toHaveLength(1);
    expect(result.changes.updates[0].values.INSTCODE).toBe(1192);
  });

  it('normalizes temporal values used by delete and update locators', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        '2': {
          [GONAVI_ROW_KEY]: 2,
          ID: 2,
          INDATE: '2026-11-11T15:00:00+08:00',
          NAME: 'changed',
        },
      },
      deletedRowKeys: new Set<string>(['1']),
      data: [
        {
          [GONAVI_ROW_KEY]: 1,
          ID: 1,
          INDATE: '2026-11-11T14:36:20+08:00',
          NAME: 'deleted',
        },
        {
          [GONAVI_ROW_KEY]: 2,
          ID: 2,
          INDATE: '2026-11-11T15:00:00+08:00',
          NAME: 'before',
        },
      ],
      editLocator: {
        strategy: 'all-columns',
        columns: ['ID', 'INDATE', 'NAME'],
        valueColumns: ['ID', 'INDATE', 'NAME'],
        readOnly: false,
      },
      visibleColumnNames: ['ID', 'INDATE', 'NAME'],
      rowKeyToString: String,
      normalizeCommitCellValue: (columnName, value, mode) => normalizeDataGridCommitCellValue({
        columnName,
        value,
        mode,
        dbType: 'dameng',
        meta: {
          type: columnName === 'INDATE' ? 'TIMESTAMP' : columnName === 'ID' ? 'INTEGER' : 'VARCHAR2(64)',
        },
      }),
      shouldCommitColumn: () => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.deletes).toEqual([{
      ID: 1,
      INDATE: '2026-11-11 14:36:20',
      NAME: 'deleted',
    }]);
    expect(result.changes.updates).toHaveLength(1);
    expect(result.changes.updates[0].keys).toEqual({
      ID: 2,
      INDATE: '2026-11-11 15:00:00',
      NAME: 'before',
    });
    expect(result.changes.updates[0].values).toEqual({ NAME: 'changed' });
  });
});
