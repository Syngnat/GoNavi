import { describe, expect, it } from 'vitest';

import {
  buildMySQLTableUpdateTimesSQL,
  buildTableStatusSQL,
  mergeMySQLTableUpdateTimes,
  parseMySQLTableUpdateTimes,
  parseTableStats,
} from './tableOverviewModel';

describe('table overview MySQL statistics', () => {
  it('selects the table update and create timestamps', () => {
    const sql = buildTableStatusSQL('mysql', 'app_db', '', 'mysql');
    expect(sql).toContain('UPDATE_TIME AS update_time');
    expect(sql).toContain('CREATE_TIME AS create_time');
  });

  it('maps create and update time case-insensitively', () => {
    const [row] = parseTableStats('mysql', [{
      TABLE_NAME: 'orders',
      CREATE_TIME: '2026-05-01 09:00:00',
      UPDATE_TIME: '2026-06-02 10:30:00',
    }]);
    expect(row?.createTime).toBe('2026-05-01 09:00:00');
    expect(row?.updateTime).toBe('2026-06-02 10:30:00');
  });

  it('keeps a MySQL NULL update time empty instead of inventing one', () => {
    const [row] = parseTableStats('mysql', [{
      TABLE_NAME: 'never_updated',
      CREATE_TIME: '2026-05-01 09:00:00',
      UPDATE_TIME: null,
    }]);
    expect(row?.createTime).toBe('2026-05-01 09:00:00');
    expect(row?.updateTime).toBe('');
  });

  it('builds and merges the optional innodb_table_stats update times', () => {
    const sql = buildMySQLTableUpdateTimesSQL("app'db");
    expect(sql).toContain('mysql.innodb_table_stats');
    expect(sql).toContain("app''db");

    const updates = parseMySQLTableUpdateTimes([
      { table_name: 'orders', update_time: '2026-06-03 11:00:00' },
      { table_name: 'empty_table', update_time: '2026-06-04 12:00:00' },
      { table_name: 'zero_time', update_time: '0000-00-00 00:00:00' },
    ]);
    expect(updates).toEqual({
      orders: '2026-06-03 11:00:00',
      empty_table: '2026-06-04 12:00:00',
    });

    const [orders, emptyTable] = mergeMySQLTableUpdateTimes([
      {
        name: 'orders', comment: '', rows: 1, dataSize: 1, indexSize: 0,
        engine: 'InnoDB', charset: '', collation: '', createTime: '',
        updateTime: '2026-06-02 10:30:00',
      },
      {
        name: 'empty_table', comment: '', rows: 0, dataSize: 0, indexSize: 0,
        engine: 'InnoDB', charset: '', collation: '', createTime: '',
        updateTime: '',
      },
    ], updates);
    expect(orders?.updateTime).toBe('2026-06-02 10:30:00');
    expect(emptyTable?.updateTime).toBe('2026-06-04 12:00:00');
  });
});
