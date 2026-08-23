import { describe, expect, it } from 'vitest';

import { buildSqlPreview } from './DataSyncModal';

describe('buildSqlPreview', () => {
  it('uses every composite primary-key column for updates and deletes', () => {
    const result = buildSqlPreview(
      {
        pkColumn: 'tenant_id,order_id',
        pkColumns: ['tenant_id', 'order_id'],
        columnTypes: {
          tenant_id: 'bigint',
          order_id: 'bigint',
          status: 'varchar(32)',
        },
        inserts: [],
        updates: [
          {
            pk: '[1,7]',
            changedColumns: ['status'],
            source: { tenant_id: 1, order_id: 7, status: 'paid' },
            target: { tenant_id: 1, order_id: 7, status: 'pending' },
          },
        ],
        deletes: [
          {
            pk: '[3,7]',
            row: { tenant_id: 3, order_id: 7, status: 'old' },
          },
        ],
      },
      'orders',
      'mysql',
      { insert: true, update: true, delete: true },
    );

    expect(result.statementCount).toBe(2);
    expect(result.sqlText).toContain(
      "UPDATE `orders` SET `status` = 'paid' WHERE `tenant_id` = 1 AND `order_id` = 7;",
    );
    expect(result.sqlText).toContain(
      'DELETE FROM `orders` WHERE `tenant_id` = 3 AND `order_id` = 7;',
    );
    expect(result.sqlText).not.toContain('`tenant_id,order_id`');
  });

  it('keeps legacy single-column preview responses compatible', () => {
    const result = buildSqlPreview(
      {
        pkColumn: 'id',
        columnTypes: { id: 'bigint', name: 'varchar(32)' },
        inserts: [],
        updates: [
          {
            pk: '9',
            changedColumns: ['name'],
            source: { name: 'new' },
          },
        ],
        deletes: [],
      },
      'users',
      'postgresql',
      { insert: true, update: true, delete: false },
    );

    expect(result.sqlText).toBe(
      `UPDATE "users" SET "name" = 'new' WHERE "id" = '9';`,
    );
  });

  it('quotes every PostgreSQL composite-key predicate', () => {
    const result = buildSqlPreview(
      {
        pkColumn: 'tenant_id,order_id',
        pkColumns: ['tenant_id', 'order_id'],
        columnTypes: { tenant_id: 'bigint', order_id: 'bigint', status: 'text' },
        inserts: [],
        updates: [
          {
            pk: '[1,7]',
            changedColumns: ['status'],
            source: { tenant_id: 1, order_id: 7, status: 'paid' },
            target: { tenant_id: 1, order_id: 7, status: 'pending' },
          },
        ],
        deletes: [],
      },
      'public.orders',
      'postgresql',
      { insert: true, update: true, delete: false },
    );

    expect(result.sqlText).toContain(
      `WHERE "tenant_id" = 1 AND "order_id" = 7;`,
    );
  });
});
