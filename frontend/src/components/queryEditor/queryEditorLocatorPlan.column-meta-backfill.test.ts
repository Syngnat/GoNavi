import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveQueryLocatorPlan } from './queryEditorLocatorPlan';
import { clearLocatorMetaCache } from '../../utils/queryLocatorMetaCache';
import { clearQueryResultColumnMetaBackfillCache, getQueryResultLocatorMetaCacheKey } from './queryEditorColumnMetaBackfill';

const backendApp = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
  DBGetIndexes: vi.fn(),
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

describe('resolveQueryLocatorPlan 列类型回填', () => {
  beforeEach(() => {
    clearLocatorMetaCache();
    clearQueryResultColumnMetaBackfillCache();
    backendApp.DBGetColumns.mockReset().mockImplementation((_cfg: unknown, _db: string, table: string) => {
      if (String(table).includes('lab_customers')) {
        return Promise.resolve({
          success: true,
          data: [
            { name: 'id', type: 'bigint', comment: '客户ID, 主键自增', key: 'PRI' },
            { name: 'name', type: 'character varying(50)', comment: '客户姓名' },
            { name: 'vip_level', type: 'smallint', comment: '会员等级' },
          ],
        });
      }
      if (String(table).includes('lab_orders')) {
        return Promise.resolve({ success: true, data: [{ name: 'id', type: 'bigint', comment: '订单ID' }] });
      }
      return Promise.resolve({ success: false, message: 'not found', data: [] });
    });
    backendApp.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  it('复杂 SQL 仍保持只读，但结果列带回按列名匹配的元数据', async () => {
    const plan = await resolveQueryLocatorPlan({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      config,
      forceReadOnly: false,
      schemaName: 'dbms_job',
    });

    // 无法唯一定位单表 → 不建立可写回定位
    expect(plan.tableRef).toBeUndefined();
    expect(plan.editLocator).toBeUndefined();
    // 但类型/注释按列名回填，未命中的聚合别名没有元数据
    expect(plan.columnMetaMap?.name?.type).toBe('character varying(50)');
    expect(plan.columnMetaMap?.vip_level?.comment).toBe('会员等级');
    expect(plan.columnMetaMap?.order_cnt).toBeUndefined();
  });

  it('只读连接同样能拿到回填元数据', async () => {
    const plan = await resolveQueryLocatorPlan({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      config,
      forceReadOnly: true,
      schemaName: 'dbms_job',
    });

    expect(plan.columnMetaMap?.name?.type).toBe('character varying(50)');
  });

  it('先跑复杂 SQL 再跑同一张表的单表查询，索引仍会请求（回填不污染定位缓存）', async () => {
    await resolveQueryLocatorPlan({
      statement: KINGBASE_SQL,
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      config,
      forceReadOnly: false,
      schemaName: 'dbms_job',
    });
    backendApp.DBGetColumns.mockClear();
    backendApp.DBGetIndexes.mockClear();

    const plan = await resolveQueryLocatorPlan({
      statement: 'SELECT * FROM dbms_job.lab_customers LIMIT 101 OFFSET 0',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      config,
      forceReadOnly: false,
      schemaName: 'dbms_job',
    });

    expect(plan.editLocator).toBeDefined();
    expect(backendApp.DBGetIndexes).toHaveBeenCalled();
  });

  it('简单单表查询维持原有单表路径，不额外查候选表', async () => {
    const plan = await resolveQueryLocatorPlan({
      statement: 'SELECT * FROM dbms_job.lab_customers LIMIT 101 OFFSET 0',
      dbType: 'kingbase',
      currentDb: 'gonavi_kingbase_lab',
      config,
      forceReadOnly: false,
      schemaName: 'dbms_job',
    });

    expect(plan.tableRef?.metadataTableName).toBe('dbms_job.lab_customers');
    // 严格路径自己会建可回写定位的元数据，且只针对定位到的那一张表查列
    const queriedTables = backendApp.DBGetColumns.mock.calls.map((call) => String(call[2]));
    expect(queriedTables).toEqual(['dbms_job.lab_customers']);
    expect(plan.columnMetaMap?.name?.type).toBe('character varying(50)');
  });

  it('Kingbase cache keys follow explicit params and last duplicate search_path without leaking the URI', () => {
    const uri = 'postgres://test:secret@mock.invalid/lab?search_path=public';
    const key = getQueryResultLocatorMetaCacheKey({ ...config, uri, connectionParams: 'search_path=archive&search_path=latest' }, config.database, 'lab_customers');
    expect(key).toBe(getQueryResultLocatorMetaCacheKey({ ...config, connectionParams: 'search_path=latest' }, config.database, 'lab_customers'));
    expect(key).not.toContain('secret');
  });

  it('Kingbase URI search_path does not share cached columns across connections', async () => {
    backendApp.DBGetColumns.mockImplementation((cfg: { uri?: string }) => Promise.resolve({
      success: true, data: [{ name: 'name', type: 'varchar', comment: cfg.uri }],
    }));
    for (const uri of ['postgres://test@mock.invalid/lab?search_path=public', 'postgres://test@mock.invalid/lab?search_path=archive']) {
      const plan = await resolveQueryLocatorPlan({ statement: 'SELECT name FROM lab_customers', dbType: 'kingbase', currentDb: config.database,
        config: { ...config, uri }, forceReadOnly: false, schemaName: '',
      });
      expect(plan.columnMetaMap?.name?.comment).toBe(uri);
    }
  });

  it('Kingbase column snapshots are isolated by the execution search_path', async () => {
    backendApp.DBGetColumns.mockImplementation((cfg: { connectionParams?: string }) => Promise.resolve({
      success: true,
      data: [{ name: 'name', type: 'varchar', comment: cfg.connectionParams }],
    }));
    for (const searchPath of ['search_path=public', 'search_path=archive']) {
      const plan = await resolveQueryLocatorPlan({
        statement: 'SELECT name FROM lab_customers', dbType: 'kingbase', currentDb: config.database,
        config: { ...config, connectionParams: searchPath }, forceReadOnly: false, schemaName: '',
      });
      expect(plan.columnMetaMap?.name?.comment).toBe(searchPath);
    }
    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
  });

  it('Kingbase unqualified SQL resolves columns through search_path rather than the browsing schema', async () => {
    backendApp.DBGetColumns.mockImplementation((_cfg: unknown, _db: string, table: string) => Promise.resolve({
      success: true,
      data: table === 'lab_customers' ? [{ name: 'name', type: 'varchar', comment: 'visible customer' }] : [],
    }));
    const plan = await resolveQueryLocatorPlan({
      statement: 'SELECT name FROM lab_customers LIMIT 101 OFFSET 0',
      dbType: 'kingbase',
      currentDb: config.database,
      config,
      forceReadOnly: false,
      schemaName: 'dbms_job',
    });

    expect(plan.columnMetaMap?.name?.comment).toBe('visible customer');
    expect(plan.tableRef?.metadataTableName).toBe('lab_customers');
    expect(plan.executedSql).toBe('SELECT name FROM lab_customers LIMIT 101 OFFSET 0');
  });
});
