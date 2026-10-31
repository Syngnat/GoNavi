import { describe, expect, it } from 'vitest';

import { buildCompareRepairSQL } from './compareRepairSql';
import type { DataSyncCompareResult } from './model';

const missingTable: DataSyncCompareResult = {
  success: true,
  message: '',
  content: 'schema',
  tables: [
    {
      table: 'kf_ai_platform',
      targetObject: 'kf_ai_platform',
      canSync: true,
      inserts: 0,
      updates: 0,
      deletes: 0,
      same: 0,
      hasSchema: true,
      targetTableExists: false,
      schemaDiffCount: 2,
      missingColumns: ['id', 'name'],
      columnDiffs: [
        { column: 'id', kind: 'missing_in_target', source: 'bigint NOT NULL' },
        { column: 'name', kind: 'missing_in_target', source: 'varchar(64)' },
      ],
    },
  ],
};

const existingTable: DataSyncCompareResult = {
  success: true,
  message: '',
  content: 'schema',
  tables: [
    {
      table: 'orders',
      targetObject: 'orders',
      canSync: true,
      inserts: 0,
      updates: 0,
      deletes: 0,
      same: 0,
      hasSchema: true,
      targetTableExists: true,
      schemaDiffCount: 1,
      columnDiffs: [{ column: 'note', kind: 'missing_in_target', source: 'varchar(64)' }],
    },
  ],
};

describe('compare repair SQL for a missing target table', () => {
  it('creates the table from source column definitions instead of altering it', () => {
    const sql = buildCompareRepairSQL(missingTable, { dialect: 'mysql', schema: '' });

    expect(sql).toContain('CREATE TABLE `kf_ai_platform` (');
    expect(sql).toContain('`id` bigint NOT NULL');
    expect(sql).toContain('`name` varchar(64)');
    expect(sql).not.toContain('ADD COLUMN');
  });

  it('keeps ADD COLUMN statements for tables that already exist', () => {
    const sql = buildCompareRepairSQL(existingTable, { dialect: 'mysql', schema: '' });

    expect(sql).toContain('ALTER TABLE `orders` ADD COLUMN `note` varchar(64) NULL;');
    expect(sql).not.toContain('CREATE TABLE');
  });
});
