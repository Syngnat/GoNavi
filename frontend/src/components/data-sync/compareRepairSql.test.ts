import { describe, expect, it } from 'vitest';

import {
  buildCompareAiPrompt,
  buildCompareRepairSQL,
  tableHasCompareDiff,
} from './compareRepairSql';
import type { DataSyncCompareResult } from './model';

const result: DataSyncCompareResult = {
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
      schemaDiffCount: 2,
      columnDiffs: [
        { column: 'note', kind: 'missing_in_target', source: 'varchar(64)' },
        { column: 'legacy', kind: 'extra_in_target', target: 'int' },
        { column: 'amount', kind: 'type', source: 'decimal(10,2)', target: 'int' },
      ],
    },
    {
      table: 'ok',
      canSync: true,
      inserts: 0,
      updates: 0,
      deletes: 0,
      same: 1,
      hasSchema: true,
    },
  ],
};

describe('compare repair SQL', () => {
  it('builds reviewable ALTER SQL from schema diffs', () => {
    const sql = buildCompareRepairSQL(result, { dialect: 'mysql', schema: 'app' });
    // 无结构化列定义时退回纯类型文本；不再无条件补 NULL——源端类型里
    // 可能已经带 NOT NULL，再补 NULL 会自相矛盾。
    expect(sql).toContain('ALTER TABLE `app`.`orders` ADD COLUMN `note` varchar(64);');
    expect(sql).toContain('-- ALTER TABLE `app`.`orders` DROP COLUMN `legacy`;');
    expect(sql).toContain('MODIFY COLUMN `amount` decimal(10,2);');
    expect(sql).not.toContain('ok');
    expect(tableHasCompareDiff(result.tables[0], 'schema')).toBe(true);
    expect(tableHasCompareDiff(result.tables[1], 'schema')).toBe(false);
  });

  it('uses PostgreSQL quoting and TYPE syntax', () => {
    const sql = buildCompareRepairSQL(result, { dialect: 'postgres', schema: 'public' });
    expect(sql).toContain('ALTER TABLE "public"."orders" ADD COLUMN "note" varchar(64);');
    expect(sql).toContain('ALTER COLUMN "amount" TYPE decimal(10,2);');
  });

  it('builds an AI prompt that includes structured diffs', () => {
    const prompt = buildCompareAiPrompt(result, {
      dialect: 'mysql',
      sourceName: 'dev',
      targetName: 'prod',
    });
    expect(prompt).toContain('源：dev');
    expect(prompt).toContain('目标：prod');
    expect(prompt).toContain('"note"');
  });
});
