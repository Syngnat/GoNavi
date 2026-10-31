import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mergeColumnMetaMapsByPriority,
  resolveQueryResultColumnMetaByCandidateTables,
  resolveQueryResultColumnMetaForStatements,
  resolveQueryResultSelectAliasEntries,
} from './queryEditorColumnMetaBackfill';
import { clearLocatorMetaCache, getLocatorMetaCacheKey, getLocatorMetaCached } from '../../utils/queryLocatorMetaCache';
import { clearQueryResultColumnMetaBackfillCache } from './queryEditorColumnMetaBackfill';
import type { ColumnMeta } from '../dataGridColumnMeta';

const backendApp = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => backendApp);

const config = {
  id: 'conn-kingbase',
  dbType: 'kingbase',
  host: '127.0.0.1',
  port: 54321,
  user: 'gonavi',
  password: '',
  database: 'gonavi_kingbase_lab',
};

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

const customerColumns = [
  { name: 'id', type: 'bigint', comment: '客户ID, 主键自增', key: 'PRI' },
  { name: 'name', type: 'character varying(50)', comment: '客户姓名' },
  { name: 'city', type: 'character varying(30)', comment: '所在城市' },
  { name: 'vip_level', type: 'smallint', comment: '会员等级' },
];

const orderColumns = [
  { name: 'id', type: 'bigint', comment: '订单ID' },
  { name: 'customer_id', type: 'bigint', comment: '客户ID' },
  { name: 'total_amount', type: 'numeric(12,2)', comment: '订单总额' },
];

describe('resolveQueryResultColumnMetaByCandidateTables', () => {
  beforeEach(() => {
    clearLocatorMetaCache();
    clearQueryResultColumnMetaBackfillCache();
    backendApp.DBGetColumns.mockReset().mockImplementation((_cfg: unknown, _db: string, table: string) => {
      if (String(table).includes('lab_customers')) return Promise.resolve({ success: true, data: customerColumns });
      if (String(table).includes('lab_orders')) return Promise.resolve({ success: true, data: orderColumns });
      return Promise.resolve({ success: false, message: 'not found', data: [] });
    });
  });

  it('JOIN + GROUP BY 查询按列名回填类型与注释', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });

    expect(metaMap?.name?.type).toBe('character varying(50)');
    expect(metaMap?.name?.comment).toBe('客户姓名');
    expect(metaMap?.vip_level?.comment).toBe('会员等级');
    // 未投影且来源重名的 id 不应从任意候选表借用注释。
    expect(metaMap?.id).toBeUndefined();
    // 聚合/窗口别名在源表里没有同名列，不显示类型行
    expect(metaMap?.order_cnt).toBeUndefined();
    expect(metaMap?.rank).toBeUndefined();
  });

  it('查不到任何候选列时返回 undefined', async () => {
    backendApp.DBGetColumns.mockResolvedValue({ success: false, message: 'boom', data: [] });
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    expect(metaMap).toBeUndefined();
  });

  it('没有候选源表的语句不发起查询', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT 1 + 1 AS two',
      dbType: 'mysql',
      currentDb: 'app',
      defaultSchema: '',
      config,
    });
    expect(metaMap).toBeUndefined();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
  });

  it('回填不写可写回定位缓存，避免后续单表查询跳过索引请求', async () => {
    await resolveQueryResultColumnMetaByCandidateTables({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    const locatorKey = getLocatorMetaCacheKey(config, 'gonavi_kingbase_lab', 'dbms_job.lab_customers');
    expect(getLocatorMetaCached(locatorKey)).toBeNull();
  });

  it('同一张表的列元数据命中缓存后不再重复请求', async () => {
    const params = {
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    };
    await resolveQueryResultColumnMetaByCandidateTables(params);
    const firstCallCount = backendApp.DBGetColumns.mock.calls.length;
    await resolveQueryResultColumnMetaByCandidateTables(params);
    expect(backendApp.DBGetColumns.mock.calls.length).toBe(firstCallCount);
  });
});

describe('mergeColumnMetaMapsByPriority', () => {
  it('同名列保留先出现的表，大小写不敏感', () => {
    const first: Record<string, ColumnMeta> = {
      ID: { type: 'bigint', comment: '客户ID', nullable: '', default: '', hasDefault: false, extra: '', key: 'PRI' },
    };
    const second: Record<string, ColumnMeta> = {
      id: { type: 'bigint', comment: '订单ID', nullable: '', default: '', hasDefault: false, extra: '', key: '' },
    };
    const merged = mergeColumnMetaMapsByPriority([first, second]);
    expect(merged.ID?.comment).toBe('客户ID');
    expect(Object.keys(merged)).toEqual(['ID']);
  });
});

describe('SELECT 别名映射回填', () => {
  it('qualified aliases override unrelated names and ambiguous join columns stay unknown', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT o.id AS city, id, COUNT(*) AS name FROM lab_customers c JOIN lab_orders o ON o.customer_id = c.id',
      dbType: 'kingbase',
      currentDb: config.database,
      defaultSchema: '',
      config,
    });
    expect(metaMap?.city?.comment).toBe('订单ID');
    expect(metaMap?.id).toBeUndefined();
    expect(metaMap?.name).toBeUndefined();
  });

  beforeEach(() => {
    clearLocatorMetaCache();
    clearQueryResultColumnMetaBackfillCache();
    backendApp.DBGetColumns.mockReset().mockImplementation((_cfg: unknown, _db: string, table: string) => {
      if (String(table).includes('lab_customers')) return Promise.resolve({ success: true, data: customerColumns });
      if (String(table).includes('lab_orders')) return Promise.resolve({ success: true, data: orderColumns });
      return Promise.resolve({ success: false, message: 'not found', data: [] });
    });
  });

  it('qualified star only projects that table and quoted aliases remain case-sensitive', async () => {
    const params = { statement: 'SELECT c.*, o.id AS "ID", o.id AS "id" FROM lab_customers c JOIN lab_orders o ON o.customer_id=c.id', dbType: 'kingbase', currentDb: config.database, defaultSchema: '', config };
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables(params);
    expect(metaMap?.customer_id).toBeUndefined();
    expect(metaMap?.ID?.comment).toBe('订单ID');
    expect(metaMap?.id?.comment).toBe('订单ID');
    expect(metaMap?.name?.comment).toBe('客户姓名');
  });

  it('qualified star and explicit schema keep exact column comments without fabricating empty ones', async () => {
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [
      { name: 'Name', type: 'varchar', comment: 'quoted name' },
      { name: 'name', type: 'varchar', comment: 'plain name' },
      { name: 'empty', type: 'integer', comment: '' },
    ] });
    const params = { statement: 'SELECT DISTINCT c.* FROM archive.lab_customers c LIMIT 10 OFFSET 20', dbType: 'kingbase', currentDb: config.database, defaultSchema: '', config };
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables(params);
    expect(metaMap?.Name?.comment).toBe('quoted name');
    expect(metaMap?.name?.comment).toBe('plain name');
    expect(metaMap?.['c.Name']?.comment).toBe('quoted name');
    expect(metaMap?.empty?.comment).toBe('');
    expect(backendApp.DBGetColumns.mock.calls[0][2]).toBe('archive.lab_customers');
  });

  it('quoted mixed-case result aliases keep the source comment', async () => {
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: customerColumns });
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT name AS "Customer" FROM lab_customers', dbType: 'kingbase', currentDb: config.database, defaultSchema: '', config,
    });
    expect(metaMap?.Customer?.comment).toBe('客户姓名');
  });

  it('中文别名也能拿到源列类型与注释', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT c.name AS 姓名, c.city AS 城市 FROM lab_customers c',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    expect(metaMap?.['姓名']?.type).toBe('character varying(50)');
    expect(metaMap?.['姓名']?.comment).toBe('客户姓名');
    expect(metaMap?.['城市']?.comment).toBe('所在城市');
  });

  it('按表限定词精确取元数据，不串表', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT o.id AS 订单号, c.id AS 客户号 FROM lab_customers c JOIN lab_orders o ON o.customer_id = c.id',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    expect(metaMap?.['订单号']?.comment).toBe('订单ID');
    expect(metaMap?.['客户号']?.comment).toBe('客户ID, 主键自增');
  });

  it('别名源列未知时不借用其它表同名列', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT o.name AS city FROM lab_orders o JOIN lab_customers c ON o.customer_id = c.id',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    expect(metaMap?.city).toBeUndefined();
  });

  it('聚合与窗口别名不映射', async () => {
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables({
      statement: 'SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS total FROM lab_orders o',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      defaultSchema: 'dbms_job',
      config,
    });
    expect(metaMap?.cnt).toBeUndefined();
    expect(metaMap?.total).toBeUndefined();
  });

  it('解析选择项：AS / 裸别名 / 引号别名 / 表达式跳过', () => {
    expect(resolveQueryResultSelectAliasEntries(
      'SELECT c.name AS 姓名, c.city 城市, "c"."vip_level" AS `等级`, COUNT(*) AS cnt FROM lab_customers c',
      'kingbase',
    )).toEqual([
      { resultColumn: '姓名', sourceColumn: 'name', qualifier: 'c' },
      { resultColumn: '城市', sourceColumn: 'city', qualifier: 'c' },
      { resultColumn: '等级', sourceColumn: 'vip_level', qualifier: 'c' },
    ]);
  });
});

describe('多语句批量回填', () => {
  beforeEach(() => {
    clearLocatorMetaCache();
    clearQueryResultColumnMetaBackfillCache();
    backendApp.DBGetColumns.mockReset().mockImplementation((_cfg: unknown, _db: string, table: string) => {
      if (String(table).includes('lab_customers')) return Promise.resolve({ success: true, data: customerColumns });
      if (String(table).includes('lab_orders')) return Promise.resolve({ success: true, data: orderColumns });
      return Promise.resolve({ success: false, message: 'not found', data: [] });
    });
  });

  it('同一批语句的候选表只请求一轮', async () => {
    const results = await resolveQueryResultColumnMetaForStatements([
      {
        statement: 'SELECT c.name FROM lab_customers c JOIN lab_orders o ON o.customer_id = c.id',
        dbType: 'kingbase',
        currentDb: 'gonavi_kingbase_lab',
        schemaName: 'dbms_job',
        config,
      },
      {
        statement: 'SELECT o.total_amount FROM lab_orders o JOIN lab_customers c ON o.customer_id = c.id',
        dbType: 'kingbase',
        currentDb: 'gonavi_kingbase_lab',
        schemaName: 'dbms_job',
        config,
      },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.name?.comment).toBe('客户姓名');
    expect(results[1]?.total_amount?.comment).toBe('订单总额');
    // 两张表各一次，而不是每条语句各两轮
    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
  });

  it('非 SELECT 语句不触发元数据请求', async () => {
    const results = await resolveQueryResultColumnMetaForStatements([
      {
        statement: 'UPDATE lab_customers SET city = \'x\' WHERE id = 1',
        dbType: 'kingbase',
        currentDb: 'gonavi_kingbase_lab',
        schemaName: 'dbms_job',
        config,
      },
    ]);
    expect(results).toEqual([undefined]);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
  });
});
