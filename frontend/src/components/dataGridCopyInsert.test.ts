import { describe, expect, it } from 'vitest';

import {
  buildCopyDeleteSQL,
  buildCopyInsertSQL,
  buildCopyUpdateSQL,
  resolveUniqueKeyGroupsFromIndexes,
} from './dataGridCopyInsert';

describe('buildCopyInsertSQL', () => {
  it('normalizes PostgreSQL timestamp values for copy-as-insert and uses PostgreSQL identifier quoting', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'postgres',
      tableName: 'public.OrderLog',
      orderedCols: ['CreatedAt', 'note'],
      record: {
        CreatedAt: '2026-01-21T18:32:26+08:00',
        note: "O'Brien",
      },
      columnTypesByLowerName: {
        createdat: 'timestamp without time zone',
        note: 'text',
      },
    });

    expect(sql).toBe(
      `INSERT INTO public."OrderLog" ("CreatedAt", note) VALUES ('2026-01-21 18:32:26', 'O''Brien');`,
    );
  });

  it('keeps timezone offsets for timezone-aware PostgreSQL columns while still removing the T separator', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'postgres',
      tableName: 'public.audit_log',
      orderedCols: ['created_at'],
      record: {
        created_at: '2026-01-21T18:32:26+08:00',
      },
      columnTypesByLowerName: {
        created_at: 'timestamp with time zone',
      },
    });

    expect(sql).toBe(
      `INSERT INTO public.audit_log (created_at) VALUES ('2026-01-21 18:32:26+08:00');`,
    );
  });

  it('preserves fractional seconds for MySQL datetime precision columns', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'mysql',
      tableName: 'events',
      orderedCols: ['created_at'],
      record: {
        created_at: '2026-05-10T09:12:33.456+08:00',
      },
      columnTypesByLowerName: {
        created_at: 'datetime(3)',
      },
    });

    expect(sql).toBe(
      "INSERT INTO `events` (`created_at`) VALUES ('2026-05-10 09:12:33.456');",
    );
  });

  it('uses ordered columns for copy-as-insert output', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'mysql',
      tableName: 'users',
      orderedCols: ['name', 'id'],
      record: {
        id: 7,
        name: 'Ada',
      },
    });

    expect(sql).toBe("INSERT INTO `users` (`name`, `id`) VALUES ('Ada', '7');");
  });

  it('emits unquoted MySQL bit literals while keeping ordinary values quoted', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'mysql',
      tableName: 'flags',
      orderedCols: ['disabled', 'enabled', 'mask', 'note'],
      record: {
        disabled: 0,
        enabled: 1,
        mask: '0X0F',
        note: '1',
      },
      columnTypesByLowerName: {
        disabled: 'bit(1)',
        enabled: 'bit(1)',
        mask: 'bit(4)',
        note: 'varchar(16)',
      },
    });

    expect(sql).toBe("INSERT INTO `flags` (`disabled`, `enabled`, `mask`, `note`) VALUES (0, 1, 15, '1');");
  });

  it('normalizes MySQL bit binary and decimal text values', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'mysql',
      tableName: 'flags',
      orderedCols: ['zero', 'binary_value', 'large_value'],
      record: {
        zero: '0',
        binary_value: "b'101'",
        large_value: '18446744073709551615',
      },
      columnTypesByLowerName: {
        zero: 'BIT',
        binary_value: 'bit(8)',
        large_value: 'bit(64)',
      },
    });

    expect(sql).toBe(
      "INSERT INTO `flags` (`zero`, `binary_value`, `large_value`) VALUES (0, 5, 18446744073709551615);",
    );
  });

  it('keeps RFC3339-looking text unchanged for non-temporal columns', () => {
    const sql = buildCopyInsertSQL({
      dbType: 'postgres',
      tableName: 'public.audit_log',
      orderedCols: ['payload'],
      record: {
        payload: '2026-01-21T18:32:26+08:00',
      },
      columnTypesByLowerName: {
        payload: 'text',
      },
    });

    expect(sql).toBe(
      `INSERT INTO public.audit_log (payload) VALUES ('2026-01-21T18:32:26+08:00');`,
    );
  });

  it('groups composite unique indexes by name and sequence order', () => {
    expect(resolveUniqueKeyGroupsFromIndexes([
      { name: 'PRIMARY', columnName: 'id', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' },
      { name: 'uk_order_code', columnName: 'code', nonUnique: 0, seqInIndex: 2, indexType: 'BTREE' },
      { name: 'uk_order_code', columnName: 'tenant_id', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' },
      { name: 'idx_note', columnName: 'note', nonUnique: 1, seqInIndex: 1, indexType: 'BTREE' },
    ])).toEqual([
      ['id'],
      ['tenant_id', 'code'],
    ]);
  });

  it('accepts non-MySQL index metadata aliases when resolving safe unique locators', () => {
    expect(resolveUniqueKeyGroupsFromIndexes([
      { index_name: 'events_slug_key', column_name: 'slug', is_unique: 't', seq_in_index: '1', index_type: 'BTREE' } as any,
      { INDEX_NAME: 'events_tenant_code_key', COLUMN_NAME: 'code', UNIQUE: true, COLUMN_POSITION: 2 } as any,
      { INDEX_NAME: 'events_tenant_code_key', COLUMN_NAME: 'tenant_id', UNIQUE: true, COLUMN_POSITION: 1 } as any,
      { indexName: 'events_ext_key', columnName: 'external_id', indexType: 'UNIQUE' } as any,
      { index_name: 'idx_note', column_name: 'note', non_unique: '1' } as any,
    ])).toEqual([
      ['slug'],
      ['tenant_id', 'code'],
      ['external_id'],
    ]);
  });

  it('builds UPDATE SQL with a primary-key WHERE clause and keeps literal formatting aligned with INSERT', () => {
    const result = buildCopyUpdateSQL({
      dbType: 'mysql',
      tableName: 'orders',
      orderedCols: ['id', 'note', 'deleted_at'],
      record: {
        id: 7,
        note: "O'Brien",
        deleted_at: null,
      },
      pkColumns: ['id'],
      columnTypesByLowerName: {
        deleted_at: 'datetime',
      },
      allTableColumns: ['id', 'note', 'deleted_at'],
    });

    expect(result).toEqual({
      ok: true,
      whereStrategy: 'primary-key',
      sql: `UPDATE \`orders\` SET \`id\` = '7', \`note\` = 'O''Brien', \`deleted_at\` = NULL WHERE (\`id\` = '7');`,
    });
  });

  it('builds DELETE SQL with a composite unique-key WHERE clause when no primary key is available', () => {
    const result = buildCopyDeleteSQL({
      dbType: 'postgres',
      tableName: 'public.audit_log',
      orderedCols: ['tenant_id', 'code', 'payload'],
      record: {
        tenant_id: 'acme',
        code: 'evt-7',
        payload: '{"ok":true}',
      },
      uniqueKeyGroups: [['tenant_id', 'code']],
      allTableColumns: ['tenant_id', 'code', 'payload'],
    });

    expect(result).toEqual({
      ok: true,
      whereStrategy: 'unique-key',
      sql: `DELETE FROM public.audit_log WHERE (tenant_id = 'acme' AND code = 'evt-7');`,
    });
  });

  it('falls back to all-column matching and uses IS NULL for null values', () => {
    const result = buildCopyDeleteSQL({
      dbType: 'sqlserver',
      tableName: 'dbo.OrderLog',
      orderedCols: ['id', 'deleted_at', 'flag'],
      allTableColumns: ['id', 'deleted_at', 'flag'],
      record: {
        id: 5,
        deleted_at: null,
        flag: true,
      },
    });

    expect(result).toEqual({
      ok: true,
      whereStrategy: 'all-columns',
      sql: `DELETE FROM [dbo].[OrderLog] WHERE ([id] = '5' AND [deleted_at] IS NULL AND [flag] = 'true');`,
    });
  });

  it('uses Oracle date constructors when all-column DELETE matching includes DATE values', () => {
    const result = buildCopyDeleteSQL({
      dbType: 'oracle',
      tableName: 'LZJ.RIJIE_TABLE',
      orderedCols: ['NAME', 'CREATED_AT', 'STATUS', 'MEMO'],
      allTableColumns: ['NAME', 'CREATED_AT', 'STATUS', 'MEMO'],
      record: {
        NAME: '张三',
        CREATED_AT: '2026-04-26T08:30:00+08:00',
        STATUS: 'DONE',
        MEMO: null,
      },
      columnTypesByLowerName: {
        name: 'NVARCHAR2',
        created_at: 'DATE',
        status: 'VARCHAR2',
        memo: 'VARCHAR2',
      },
    });

    expect(result).toEqual({
      ok: true,
      whereStrategy: 'all-columns',
      sql: `DELETE FROM "LZJ"."RIJIE_TABLE" WHERE ("NAME" = '张三' AND "CREATED_AT" = TO_DATE('2026-04-26 08:30:00', 'YYYY-MM-DD HH24:MI:SS') AND "STATUS" = 'DONE' AND "MEMO" IS NULL);`,
    });
  });

  it('refuses to build UPDATE/DELETE SQL when the result set lacks keys and does not cover all table columns', () => {
    const result = buildCopyDeleteSQL({
      dbType: 'mysql',
      tableName: 'orders',
      orderedCols: ['note'],
      allTableColumns: ['id', 'note', 'created_at'],
      record: {
        note: 'partial row',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected buildCopyDeleteSQL to fail');
    }
    expect(result.error).toEqual({
      key: 'data_grid.copy_sql.error.missing_safe_where',
    });
  });

  it('returns a structured missing-table error with the raw SQL mode placeholder', () => {
    const result = buildCopyUpdateSQL({
      dbType: 'postgres',
      tableName: '',
      orderedCols: ['note'],
      record: {
        note: 'partial row',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected buildCopyUpdateSQL to fail');
    }
    expect(result.error).toEqual({
      key: 'data_grid.copy_sql.error.missing_table_name',
      params: {
        mode: 'UPDATE',
      },
    });
  });

  it('returns a structured no-copyable-fields error', () => {
    const result = buildCopyDeleteSQL({
      dbType: 'mysql',
      tableName: 'orders',
      orderedCols: [],
      record: {
        id: 7,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected buildCopyDeleteSQL to fail');
    }
    expect(result.error).toEqual({
      key: 'data_grid.copy_sql.error.no_copyable_fields',
    });
  });
});
