import { describe, expect, it } from 'vitest';

import { buildCompareRepairSQL } from './compareRepairSql';
import type { DataSyncCompareResult } from './model';

const result = (tables: DataSyncCompareResult['tables']): DataSyncCompareResult => ({
  success: true,
  message: '',
  content: 'schema',
  tables,
});

const base = {
  table: 'orders',
  canSync: true,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 0,
  hasSchema: true,
  schemaDiffCount: 1,
  targetTableExists: true,
};

describe('repair SQL covers every diff kind', () => {
  // 重命名是推断结果：目标端可能并不存在旧列，RENAME COLUMN 会直接失败，
  // 所以只给注释建议，不生成可执行语句。
  it('turns a rename into a comment, not a RENAME statement', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [{ column: 'order_no', kind: 'renamed', source: 'order_no', target: 'order_number' }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('疑似重命名');
    expect(sql).toContain('order_number');
    expect(sql).not.toContain('RENAME COLUMN');
  });

  // 容量降级要让用户看到风险，同时给出可执行的类型修正语句。
  it('emits a risk note plus the capacity statement', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [{ column: 'content', kind: 'capacity_degraded', source: 'longtext', target: 'mediumtext' }],
    }]), { dialect: 'mysql' });

    expect(sql).toContain('容量');
    expect(sql).toContain('会被截断');
    expect(sql).toContain('MODIFY COLUMN');
    expect(sql).toContain('longtext');
  });

  it('never leaves a statement without an executable clause', () => {
    const sql = buildCompareRepairSQL(result([{
      ...base,
      columnDiffs: [
        { column: 'a', kind: 'missing_in_target', source: 'text' },
        { column: 'b', kind: 'type', source: 'int', target: 'bigint' },
        { column: 'c', kind: 'nullable', source: 'NO', target: 'YES' },
        { column: 'd', kind: 'extra_in_target', target: 'int' },
        { column: 'e', kind: 'renamed', source: 'e', target: 'f' },
        { column: 'g', kind: 'capacity_degraded', source: 'longtext', target: 'text' },
      ],
    }]), { dialect: 'mysql' });

    // 每一行要么是注释，要么是可执行语句（以分号结尾且带 DDL 动词）。
    sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'))
      .forEach((line) => {
        expect(line).toMatch(/^(ALTER TABLE|CREATE TABLE|  `|\);)/);
      });
    // 三连及以上单引号说明默认值被套了两层引号。
    expect(sql).not.toMatch(/'{3,}/);
  });
});
