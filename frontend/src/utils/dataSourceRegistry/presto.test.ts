import { describe, expect, it } from 'vitest';

import { buildUriFromValues, getUriPlaceholder, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { supportsTableClearAction } from '../../components/tableDataDangerActions';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { resolveConnectionConfigLayout } from '../connectionModalPresentation';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { getDataSourceCapabilityContract } from '../dataSourceCapabilities';
import { buildQueryResultPageSql } from '../queryResultPagination';
import { buildPaginatedSelectSQL } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { formatSqlExecutionError } from '../sqlErrorSemantics';
import { usesTrinoStyleConnection } from './uriScheme';

const presto = { type: 'presto' } as never;

describe('Presto registry behavior', () => {
  it('opens the big data group on port 8080 and borrows the Trino dialect and form', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.bigdata'));
    expect(group?.items.map((item) => item.key)).toContain('presto');
    expect(getConnectionTypeDefaultPort('presto')).toBe(8080);
    expect(resolveSqlDialect('presto')).toBe('trino');
    expect(usesTrinoStyleConnection('presto')).toBe(true);
    expect(usesTrinoStyleConnection('mysql')).toBe(false);
    expect(resolveConnectionConfigLayout('presto')).toEqual(resolveConnectionConfigLayout('trino'));
    expect({ ...getDataSourceCapabilityContract(presto), type: 'trino' }).toEqual(getDataSourceCapabilityContract({ type: 'trino' } as never));
  });

  it('parses catalog and schema from parameters, dotted paths and JDBC-style paths', () => {
    expect(parseUriToValues('https://analyst@coordinator.example.com:8443?catalog=hive&schema=sales&clientTags=bi', 'presto')).toMatchObject({
      host: 'coordinator.example.com',
      port: 8443,
      user: 'analyst',
      database: 'hive.sales',
      useSSL: true,
      connectionParams: 'clientTags=bi',
    });
    expect(parseUriToValues('presto://coordinator:8080/hive/default', 'presto')).toMatchObject({ host: 'coordinator', port: 8080, database: 'hive.default', useSSL: false });
    expect(parseUriToValues('jdbc:presto://coordinator:8081/hive/default', 'presto')).toMatchObject({ host: 'coordinator', port: 8081, database: 'hive.default' });
    expect(parseUriToValues('jdbc:trino://coordinator:8080/hive/default', 'trino')).toMatchObject({ host: 'coordinator', database: 'hive.default' });
    expect(parseUriToValues('http://127.0.0.1/tpch.tiny', 'presto')).toMatchObject({ port: 8080, database: 'tpch.tiny' });
    expect(buildUriFromValues({ type: 'presto', host: '10.0.0.5', port: 8080, user: 'analyst', database: 'hive.sales' })).toBe(
      'http://analyst@10.0.0.5:8080?catalog=hive&schema=sales&source=GoNavi',
    );
    expect(getUriPlaceholder('presto')).toContain('catalog=hive&schema=default');
  });

  it('pages with OFFSET before LIMIT in data browsing and query results', () => {
    expect(buildPaginatedSelectSQL('presto', 'SELECT * FROM "hive"."sales"."orders"', ' ORDER BY "id"', 50, 100)).toBe(
      'SELECT * FROM "hive"."sales"."orders" ORDER BY "id" OFFSET 100 LIMIT 50',
    );
    expect(buildPaginatedSelectSQL('presto', 'SELECT * FROM t', '', 50, 0)).toBe('SELECT * FROM t LIMIT 50');
    // Trino 与借用其方言的 Presto 在查询结果翻页时按方言拼装，LIMIT n OFFSET m 在它们的语法里是错误。
    for (const dbType of ['presto', 'trino']) {
      expect(buildQueryResultPageSql({ baseSql: 'SELECT * FROM t', dbType, page: 3, pageSize: 20 })).toContain('OFFSET 40 LIMIT 20');
      // 它们会丢弃子查询里的 ORDER BY：语句自带排序时分页子句直接追加，不再包一层。
      expect(buildQueryResultPageSql({ baseSql: 'SELECT a, b FROM t ORDER BY a, b', dbType, page: 2, pageSize: 20 })).toBe(
        'SELECT a, b FROM t ORDER BY a, b OFFSET 20 LIMIT 20',
      );
      expect(buildQueryResultPageSql({ baseSql: 'SELECT a FROM t ORDER BY a LIMIT 100', dbType, page: 2, pageSize: 20 })).toContain('FROM (SELECT a FROM t ORDER BY a LIMIT 100)');
      expect(buildQueryResultPageSql({ baseSql: 'SELECT a FROM t ORDER BY a', dbType, page: 2, pageSize: 20, sortInfo: [{ columnKey: 'a', order: 'descend' }] })).toContain('FROM (SELECT a FROM t ORDER BY a)');
    }
    expect(buildQueryResultPageSql({ baseSql: 'SELECT a FROM t ORDER BY a', dbType: 'mysql', page: 2, pageSize: 20 })).toContain('FROM (SELECT a FROM t ORDER BY a)');
  });

  it('explains Presto / Trino error messages with semantic categories', () => {
    expect(formatSqlExecutionError('Presto 查询失败（SYNTAX_ERROR）：Table tpch.tiny.nope does not exist')).toContain('Table or object does not exist');
    expect(formatSqlExecutionError("Presto query failed (TABLE_NOT_FOUND): line 1:15: Table 'hive.sales.x' does not exist")).toContain('Table or object does not exist');
    expect(formatSqlExecutionError("line 1:8: Column 'amount' cannot be resolved")).toContain('Column does not exist');
    expect(formatSqlExecutionError("line 1:10: mismatched input 'FORM'. Expecting: <EOF>")).toContain('SQL syntax error');
  });

  it('classifies writes for read-only protection and offers the Trino clear action', () => {
    expect(supportsConnectionReadOnlyMode(presto)).toBe(true);
    for (const statement of ['SELECT * FROM hive.sales.orders', 'SHOW CATALOGS', 'DESCRIBE hive.sales.orders']) {
      expect(findPotentiallyMutatingConnectionStatements(presto, statement), statement).toEqual([]);
    }
    for (const statement of ['INSERT INTO memory.gonavi.t VALUES (1)', 'DROP TABLE memory.gonavi.t', 'CREATE TABLE memory.gonavi.t AS SELECT 1 AS id']) {
      expect(findPotentiallyMutatingConnectionStatements(presto, statement), statement).toEqual([statement]);
    }
    expect(supportsTableClearAction('presto')).toBe(true);
    expect(supportsTableClearAction('tidb')).toBe(true);
  });
});
