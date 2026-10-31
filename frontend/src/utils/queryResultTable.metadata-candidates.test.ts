import { describe, expect, it } from 'vitest';

import {
  extractQueryResultMetadataTableRefs,
  extractQueryResultTableRef,
  MAX_QUERY_RESULT_METADATA_TABLE_REFS,
} from './queryResultTable';

const KINGBASE_SQL = `SELECT rank, name, city, vip_level, order_cnt, total_spend
FROM (
SELECT c.name, c.city, c.vip_level,
       COUNT(DISTINCT o.id) AS order_cnt,
       COALESCE(SUM(o.total_amount), 0) AS total_spend,
       RANK() OVER (ORDER BY COALESCE(SUM(o.total_amount), 0) DESC) AS rank
FROM lab_customers c
LEFT JOIN lab_orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.city, c.vip_level
) t
WHERE rank <= 20
ORDER BY rank;`;

describe('extractQueryResultMetadataTableRefs', () => {
  it('仍按严格规则拒绝多表/分组查询的可写回定位', () => {
    expect(extractQueryResultTableRef(KINGBASE_SQL, 'kingbase', 'gonavi_kingbase_lab', 'dbms_job'))
      .toBeUndefined();
  });

  it('对 JOIN + GROUP BY 查询给出候选源表，主表在前', () => {
    const refs = extractQueryResultMetadataTableRefs(KINGBASE_SQL, 'kingbase', 'gonavi_kingbase_lab', 'dbms_job');
    expect(refs.map((ref) => `${ref.metadataDbName}|${ref.metadataTableName}`))
      .toEqual(['gonavi_kingbase_lab|dbms_job.lab_customers', 'gonavi_kingbase_lab|dbms_job.lab_orders']);
  });

  it('简单查询同样返回单表候选', () => {
    const refs = extractQueryResultMetadataTableRefs(
      'SELECT * FROM dbms_job.lab_customers LIMIT 101 OFFSET 0',
      'kingbase',
      'gonavi_kingbase_lab',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].metadataTableName).toBe('dbms_job.lab_customers');
  });

  it('支持逗号多表连接', () => {
    const refs = extractQueryResultMetadataTableRefs(
      'SELECT * FROM app.users u, app.orders o WHERE u.id = o.user_id',
      'mysql',
      'app',
    );
    expect(refs.map((ref) => ref.metadataTableName)).toEqual(['users', 'orders']);
  });

  it('派生表里的 FROM 也会被收集，外层表排在前面', () => {
    const refs = extractQueryResultMetadataTableRefs(
      'SELECT * FROM (SELECT id FROM app.users) t JOIN app.orders o ON o.user_id = t.id',
      'mysql',
      'app',
    );
    // 先扫外层（orders）再补派生表内部（users），同名列冲突时外层优先
    expect(refs.map((ref) => ref.metadataTableName)).toEqual(['orders', 'users']);
  });

  it('CTE 名不算源表，CTE 体里的真实表算', () => {
    const refs = extractQueryResultMetadataTableRefs(
      'WITH c AS (SELECT id FROM app.users) SELECT * FROM c JOIN app.orders o ON o.user_id = c.id',
      'mysql',
      'app',
    );
    expect(refs.map((ref) => ref.metadataTableName)).toEqual(['orders', 'users']);
  });

  it('逗号多表不带别名也能收集', () => {
    const refs = extractQueryResultMetadataTableRefs('SELECT * FROM t1, t2', 'mysql', 'app');
    expect(refs.map((ref) => ref.metadataTableName)).toEqual(['t1', 't2']);
  });

  it('IN 子查询与 UNION 两侧的表都会收集', () => {
    const inSubquery = extractQueryResultMetadataTableRefs(
      'SELECT * FROM app.users WHERE id IN (SELECT id FROM lab_orders)',
      'mysql',
      'app',
    );
    expect(inSubquery.map((ref) => ref.metadataTableName)).toEqual(['users', 'lab_orders']);

    const union = extractQueryResultMetadataTableRefs(
      '(SELECT * FROM app.alpha) UNION (SELECT * FROM app.beta)',
      'mysql',
      'app',
    );
    expect(union.map((ref) => ref.metadataTableName)).toEqual(['alpha', 'beta']);
  });

  it('候选数量有上限', () => {
    const joins = Array.from({ length: 10 }, (_, index) => `JOIN app.t${index} x${index} ON 1 = 1`).join('\n');
    const refs = extractQueryResultMetadataTableRefs(`SELECT * FROM app.t0 a\n${joins}`, 'mysql', 'app');
    expect(refs.length).toBeLessThanOrEqual(MAX_QUERY_RESULT_METADATA_TABLE_REFS);
  });

  it('不是 SELECT 或没有 FROM 时返回空数组', () => {
    expect(extractQueryResultMetadataTableRefs('SELECT 1 + 1 AS two', 'mysql', 'app')).toEqual([]);
    expect(extractQueryResultMetadataTableRefs('', 'mysql', 'app')).toEqual([]);
  });
});

describe('extractQueryResultMetadataTableRefs 跨数据源', () => {
  const cases: Array<{
    title: string;
    sql: string;
    dialect: string;
    currentDb: string;
    defaultSchema: string;
    expected: Array<[string, string]>;
  }> = [
    {
      title: 'MySQL 库名 + 表名',
      sql: 'SELECT u.name, o.total FROM shop.users u JOIN shop.orders o ON o.user_id = u.id GROUP BY u.name',
      dialect: 'mysql',
      currentDb: 'shop',
      defaultSchema: '',
      expected: [['shop', 'users'], ['shop', 'orders']],
    },
    {
      title: 'PostgreSQL schema 限定时表名带 schema',
      sql: 'SELECT * FROM public.users u JOIN public.orders o ON o.user_id = u.id',
      dialect: 'postgres',
      currentDb: 'app',
      defaultSchema: 'public',
      expected: [['app', 'public.users'], ['app', 'public.orders']],
    },
    {
      title: 'Kingbase 未限定 schema 时补默认 schema',
      sql: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id',
      dialect: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      expected: [['gonavi_kingbase_lab', 'dbms_job.users'], ['gonavi_kingbase_lab', 'dbms_job.orders']],
    },
    {
      title: 'Oracle 大写 owner',
      sql: 'SELECT * FROM APP.USERS u JOIN APP.ORDERS o ON o.user_id = u.id',
      dialect: 'oracle',
      currentDb: 'ORCLPDB1',
      defaultSchema: 'APP',
      expected: [['APP', 'USERS'], ['APP', 'ORDERS']],
    },
    {
      title: 'SQL Server 方括号限定名',
      sql: 'SELECT * FROM [dbo].[users] u JOIN [dbo].[orders] o ON o.user_id = u.id',
      dialect: 'sqlserver',
      currentDb: 'erp',
      defaultSchema: 'dbo',
      expected: [['erp', 'dbo.users'], ['erp', 'dbo.orders']],
    },
    {
      title: 'ClickHouse 库名 + 表名',
      sql: 'SELECT * FROM analytics.events e JOIN analytics.sessions s ON s.id = e.session_id',
      dialect: 'clickhouse',
      currentDb: 'analytics',
      defaultSchema: '',
      expected: [['analytics', 'events'], ['analytics', 'sessions']],
    },
  ];

  cases.forEach(({ title, sql, dialect, currentDb, defaultSchema, expected }) => {
    it(title, () => {
      const refs = extractQueryResultMetadataTableRefs(sql, dialect, currentDb, defaultSchema);
      expect(refs.map((ref) => [ref.metadataDbName, ref.metadataTableName])).toEqual(expected);
    });
  });
});

describe('表位置词', () => {
  it('FROM ONLY / JOIN LATERAL 不产生假表', () => {
    const only = extractQueryResultMetadataTableRefs('SELECT * FROM ONLY app.users', 'postgres', 'app', 'public');
    expect(only.map((ref) => ref.metadataTableName)).toEqual(['app.users']);

    const lateral = extractQueryResultMetadataTableRefs(
      'SELECT * FROM app.users u JOIN LATERAL (SELECT id FROM app.orders) o ON true',
      'postgres',
      'app',
      'public',
    );
    expect(lateral.map((ref) => ref.metadataTableName)).toEqual(['app.users', 'app.orders']);
  });
});
