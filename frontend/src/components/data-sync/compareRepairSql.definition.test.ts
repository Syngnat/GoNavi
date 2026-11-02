import { describe, expect, it } from 'vitest';

import { buildCompareRepairSQL } from './compareRepairSql';
import { sqlDefaultLiteral } from './compareRepairSqlColumn';
import type { DataSyncCompareResult } from './model';

const result = (tables: DataSyncCompareResult['tables']): DataSyncCompareResult => ({
  success: true, message: '', content: 'schema', tables,
});

const base = {
  table: 'orders', canSync: true, inserts: 0, updates: 0, deletes: 0, same: 0,
  hasSchema: true, schemaDiffCount: 1, targetTableExists: true,
};

describe('default literal rendering', () => {
  // 后端给的是驱动原始值。再套一层引号会产出 DEFAULT ''''。
  it('never double-quotes an already quoted default', () => {
    expect(sqlDefaultLiteral("''")).toBe("''");
    expect(sqlDefaultLiteral("'abc'")).toBe("'abc'");
    expect(sqlDefaultLiteral("'it''s'")).toBe("'it''s'");
  });

  it('keeps numbers and functions bare and quotes bare strings', () => {
    expect(sqlDefaultLiteral('0')).toBe('0');
    expect(sqlDefaultLiteral('3.14')).toBe('3.14');
    expect(sqlDefaultLiteral('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(sqlDefaultLiteral('now()')).toBe('NOW()');
    expect(sqlDefaultLiteral('NULL')).toBe('NULL');
    expect(sqlDefaultLiteral('hello')).toBe("'hello'");
    expect(sqlDefaultLiteral("it's")).toBe("'it''s'");
  });

  it('produces no triple quotes for any of the above', () => {
    ["''", "'abc'", 'hello', "it's", '0', 'CURRENT_TIMESTAMP'].forEach((value) => {
      expect(sqlDefaultLiteral(value)).not.toMatch(/'{3,}/);
    });
  });
});

describe('repair SQL keeps defaults and comments', () => {
  it('recreates an added column with its default and comment', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [{
        column: 'created_at',
        kind: 'missing_in_target',
        source: 'datetime NOT NULL',
        sourceDefinition: {
          name: 'created_at', type: 'datetime', nullable: false,
          hasDefault: true, default: 'CURRENT_TIMESTAMP', comment: '创建时间',
        },
      }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('ADD COLUMN `created_at` datetime NOT NULL');
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain("COMMENT '创建时间'");
    expect(sql).not.toMatch(/'{3,}/);
  });

  it('keeps the default when only the type changes', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [{
        column: 'amount',
        kind: 'type',
        source: 'decimal(10,2)',
        target: 'decimal(8,2)',
        sourceDefinition: {
          name: 'amount', type: 'decimal(10,2)', nullable: false,
          hasDefault: true, default: '0', comment: '',
        },
      }],
    }]), { dialect: 'mysql' });

    // 只改类型却丢掉 DEFAULT，目标列修复后仍与源端不一致。
    expect(sql).toContain('MODIFY COLUMN `amount` decimal(10,2) NOT NULL DEFAULT 0');
  });

  it('escapes a comment that contains a quote', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [{
        column: 'note',
        kind: 'missing_in_target',
        source: 'text',
        sourceDefinition: {
          name: 'note', type: 'text', nullable: true,
          hasDefault: false, comment: "it's a note",
        },
      }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain("COMMENT 'it''s a note'");
  });
});

describe('repair SQL covers indexes', () => {
  // MySQL 不支持原地改索引定义，必须同一条 ALTER 里 DROP + ADD。
  it('rewrites a changed index as DROP + ADD in one statement', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      indexDiffs: [{
        name: 'idx_code', kind: 'changed',
        source: 'BTREE (code)', target: 'UNIQUE BTREE (code, tenant)',
        columns: ['code', 'tenant'], unique: true,
      }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('DROP INDEX `idx_code`, ADD UNIQUE INDEX `idx_code` (code, tenant)');
    expect(sql).not.toMatch(/ALTER INDEX\s/);
  });

  it('adds a missing index and comments out an extra one', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      indexDiffs: [
        { name: 'idx_new', kind: 'missing_in_target', source: 'BTREE (a)', columns: ['a'], unique: false },
        { name: 'idx_old', kind: 'extra_in_target', target: 'BTREE (b)', columns: ['b'], unique: false },
      ],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('ADD INDEX `idx_new` (a);');
    expect(sql).toContain('-- ALTER TABLE `orders` DROP INDEX `idx_old`;');
  });
});

describe('repair SQL covers default/comment drift', () => {
  it('emits SET DEFAULT for a changed default', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      attributeDiffs: [{ column: 'flag', kind: 'default', source: '1', target: '' }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('ALTER COLUMN `flag` SET DROP DEFAULT');
    expect(sql).toContain('无默认值');
  });

  it('leaves comment drift as a review note', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      attributeDiffs: [{ column: 'note', kind: 'comment', source: '新注释', target: '' }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('注释不同');
    expect(sql).toContain('新注释');
  });
});
