import { describe, expect, it } from 'vitest';
import { resolveQueryEditorExecutionContext as resolve } from './QueryEditorHelpers';

describe('SQL execution context', () => {
    it.each([
        ['sqlserver', 'SELECT * FROM ZODO_Hmi.dbo.HmiFirstInspectOperate', { dbName: 'ZODO_Hmi' }],
        ['sqlserver', 'SELECT * FROM [ZODO_Hmi].[dbo].[Table]', { dbName: 'ZODO_Hmi' }],
        ['sqlserver', 'SELECT * FROM dbo.HmiModelChangePlan', {}],
        ['mysql', 'SELECT * FROM analytics.orders', { dbName: 'analytics' }],
        ['mysql', 'SELECT STRAIGHT_JOIN a.id FROM archive_db.items a STRAIGHT_JOIN archive_db.other b ON a.id = b.id', { dbName: 'archive_db' }],
        ['oceanbase', 'SELECT * FROM analytics.orders', { dbName: 'analytics' }],
        ['clickhouse', 'SELECT * FROM analytics.events', { dbName: 'analytics' }],
        ['tdengine', 'SELECT * FROM metrics.meters', { dbName: 'metrics' }],
        ['postgres', 'SELECT * FROM sales.orders', { schemaName: 'sales' }],
        ['kingbase', 'SELECT * FROM sales.orders', { schemaName: 'sales' }],
        ['gaussdb', 'SELECT * FROM sales.orders', { schemaName: 'sales' }],
        ['postgres', 'SELECT * FROM warehouse.sales.orders', { dbName: 'warehouse', schemaName: 'sales' }],
        ['oracle', 'SELECT * FROM REPORT.orders', {}],
        ['dameng', 'SELECT * FROM REPORT.orders', {}],
        ['dm', 'SELECT * FROM REPORT.orders', {}],
        ['oracle', 'select * from hts_oms.SKAPI_CONSIGNERDOC', {}],
        ['oracle', 'INSERT INTO hts_oms.skapi_purordermt SELECT 1 FROM dual', {}],
        ['iotdb', 'SELECT * FROM root.ln.wf01.wt01', {}],
        ['iris', 'SELECT * FROM SQLUser.orders', {}],
        ['cache', 'SELECT * FROM SQLUser.orders', {}],
        ['trino', 'SELECT * FROM sales.orders', {}],
        ['trino', 'SELECT * FROM hive.sales.orders', { dbName: 'hive.sales' }],
        ['duckdb', 'SELECT * FROM main.users', {}],
        ['starrocks', 'SELECT * FROM ssb.lineorder', { dbName: 'ssb' }],
        ['starrocks', 'SELECT * FROM hive.ssb.lineorder', {}],
        ['diros', 'SELECT * FROM hive.ssb.lineorder', {}],
        ['sqlserver', 'USE [ZODO_Hmi]', { dbName: 'ZODO_Hmi' }],
        ['mysql', "SELECT 'FROM fake.orders' FROM users -- JOIN bogus.items", {}],
        ['postgres', 'SELECT sales.id FROM users sales /* FROM bogus.orders */', {}],
        ['sqlite', 'SELECT * FROM main.users', {}],
    ])('%s resolves %s', (dialect, sql, expected) => {
        expect(resolve(sql, dialect, 'main', 'public')).toEqual(expected);
    });

    it('keeps an explicit schema when switching databases even if it matches the previous schema', () => {
        expect(resolve('SELECT * FROM warehouse.public.orders', 'postgres', 'main', 'public'))
            .toEqual({ dbName: 'warehouse', schemaName: 'public' });
    });

    it('does not switch Oracle current user for an already qualified owner.table', () => {
        expect(resolve(
            'select * from hts_oms.SKAPI_CONSIGNERDOC',
            'oracle',
            'OTHER_USER',
            '',
            ['HTS_OMS', 'OTHER_USER'],
        )).toEqual({});
    });

    it('syncs IoTDB toolbar to a visible storage group prefix, not the path root', () => {
        expect(resolve(
            'SELECT * FROM root.ln.wf01.wt01',
            'iotdb',
            'root.sg',
            '',
            ['root.ln', 'root.sg'],
        )).toEqual({ dbName: 'root.ln' });
        expect(resolve(
            'SELECT * FROM root.other.wf01.wt01',
            'iotdb',
            'root.sg',
            '',
            ['root.ln', 'root.sg'],
        )).toEqual({});
    });
});
