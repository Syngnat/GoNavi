import { describe, expect, it } from 'vitest';

import { buildOrderBySQL, buildPaginatedSelectSQL, buildWhereSQL, quoteQualifiedIdent, reverseOrderBySQL } from './sql';

describe('buildOrderBySQL', () => {
  it('does not add fallback ORDER BY for DuckDB without explicit sort', () => {
    expect(buildOrderBySQL('duckdb', [], ['ID'])).toBe('');
  });

  it('keeps explicit DuckDB sort', () => {
    expect(buildOrderBySQL('duckdb', { columnKey: 'ID', order: 'descend' }, ['NAME'])).toBe(' ORDER BY "ID" DESC');
  });
});

describe('buildWhereSQL', () => {
  it('builds one grouped expression for a structured value selection', () => {
    expect(buildWhereSQL('mysql', [{
      column: 'status',
      op: 'IN',
      valueSelection: { values: ['active', 'waiting,review'], includeNull: true, includeEmpty: true },
    }])).toBe("WHERE ((`status` IN ('active', 'waiting,review') OR `status` IS NULL OR `status` = ''))");
  });
});

describe('buildPaginatedSelectSQL', () => {
  it('uses native Dameng pagination without wrapping duplicate JOIN columns', () => {
    const baseSql = 'SELECT t.ID, v.ID FROM VULNERABILITY_INFO_T t INNER JOIN VULNERABILITY_DETAIL_T v ON t.CODE = v.VULN_DETAIL';

    expect(buildPaginatedSelectSQL('dameng', baseSql, '', 5000, 0))
      .toBe(`${baseSql} LIMIT 5000 OFFSET 0`);
  });

  it('keeps the Oracle ROWNUM compatibility wrapper', () => {
    expect(buildPaginatedSelectSQL('oracle', 'SELECT * FROM users', '', 50, 0))
      .toBe('SELECT * FROM (SELECT * FROM users) WHERE ROWNUM <= 50');
  });

  it('uses SQL Server TOP for the first page to support old compatibility levels', () => {
    const sql = buildPaginatedSelectSQL('sqlserver', 'SELECT * FROM [Users]', ' ORDER BY [ID] ASC', 101, 0);

    expect(sql).toBe('SELECT TOP 101 * FROM [Users] ORDER BY [ID] ASC');
    expect(sql.toLowerCase()).not.toContain('fetch next');
    expect(sql.toLowerCase()).not.toContain('offset');
  });

  it('adds SQL Server TOP after DISTINCT', () => {
    expect(buildPaginatedSelectSQL('mssql', 'SELECT DISTINCT [Name] FROM [Users]', '', 50, 0))
      .toBe('SELECT DISTINCT TOP 50 [Name] FROM [Users]');
  });

  it('does not add another SQL Server TOP when base SQL already has one', () => {
    expect(buildPaginatedSelectSQL('sqlserver', 'SELECT TOP 10 * FROM [Users]', '', 50, 0))
      .toBe('SELECT TOP 10 * FROM [Users]');
  });

  it('uses SQL Server TOP window pagination instead of OFFSET FETCH for sorted pages', () => {
    const sql = buildPaginatedSelectSQL('sqlserver', 'SELECT * FROM [Users]', ' ORDER BY [ID] ASC', 25, 50);

    expect(sql).toContain('SELECT TOP 25 * FROM (SELECT TOP 75 * FROM (SELECT * FROM [Users])');
    expect(sql).toContain('ORDER BY [ID] DESC');
    expect(sql.endsWith('ORDER BY [ID] ASC')).toBe(true);
    expect(sql.toLowerCase()).not.toContain('fetch next');
  });

  it('keeps generic pagination for other databases', () => {
    expect(buildPaginatedSelectSQL('postgres', 'SELECT * FROM users', ' ORDER BY id ASC', 20, 40))
      .toBe('SELECT * FROM users ORDER BY id ASC LIMIT 20 OFFSET 40');
  });
});

describe('reverseOrderBySQL', () => {
  it('reverses comma separated order parts without splitting function arguments', () => {
    expect(reverseOrderBySQL(' ORDER BY COALESCE([a], [b]) ASC, [id] DESC'))
      .toBe(' ORDER BY COALESCE([a], [b]) DESC, [id] ASC');
  });
});

describe('quoteQualifiedIdent', () => {
  it('quotes Apache IoTDB device paths with backticks per path segment', () => {
    expect(quoteQualifiedIdent('iotdb', 'root.sg.d1'))
      .toBe('`root`.`sg`.`d1`');
  });

  it('keeps RocketMQ topic names as one quoted identifier', () => {
    expect(quoteQualifiedIdent('rocketmq', 'orders.events.v1'))
      .toBe('"orders.events.v1"');
  });

  it('keeps MQTT topic filters as one quoted identifier', () => {
    expect(quoteQualifiedIdent('mqtt', 'devices/+/telemetry.v1'))
      .toBe('"devices/+/telemetry.v1"');
  });

  it('keeps Kafka topic names as one quoted identifier', () => {
    expect(quoteQualifiedIdent('kafka', 'logs.app-1'))
      .toBe('"logs.app-1"');
  });

  it('keeps RabbitMQ queue names as one quoted identifier', () => {
    expect(quoteQualifiedIdent('rabbitmq', 'orders.events.v1'))
      .toBe('"orders.events.v1"');
  });

  it('quotes GoldenDB identifiers with MySQL-style backticks', () => {
    expect(quoteQualifiedIdent('goldendb', 'ledger.entries'))
      .toBe('`ledger`.`entries`');
  });

  it('does not split dots inside quoted DuckDB identifiers', () => {
    expect(quoteQualifiedIdent('duckdb', '"daily.events"."2026.06"'))
      .toBe('"daily.events"."2026.06"');
  });

  it('preserves three-part DuckDB names with quoted dots', () => {
    expect(quoteQualifiedIdent('duckdb', '"analytics.catalog"."main.schema"."daily.events"'))
      .toBe('"analytics.catalog"."main.schema"."daily.events"');
  });
});
