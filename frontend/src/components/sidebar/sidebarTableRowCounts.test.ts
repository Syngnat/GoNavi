import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '../../types';
import type { SidebarTreeNode } from '../sidebarV2Utils';
import { applySidebarTableRowCounts, refreshSidebarTableRowCounts } from './sidebarTableRowCounts';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../../wailsjs/go/app/App', () => ({ DBQuery: query }));

describe('sidebar row counts after SQL writes', () => {
    beforeEach(() => {
        query.mockReset();
        query.mockResolvedValue({ success: true, data: [{ table_rows: 0 }] });
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ['mysql', 'orders', '', '`orders`', 'main', 'SELECT COUNT(*) AS table_rows FROM `orders`'],
        ['mariadb', 'orders', '', '`orders`', 'main', 'SELECT COUNT(*) AS table_rows FROM `orders`'],
        ['postgres', 'public.orders', 'public', 'public.orders', 'main', 'SELECT COUNT(*) AS table_rows FROM public.orders'],
        ['kingbase', 'public.orders', 'public', 'public.orders', 'main', 'SELECT COUNT(*) AS table_rows FROM public.orders'],
        ['sqlserver', 'dbo.orders', 'dbo', '[dbo].[orders]', 'main', 'SELECT COUNT(*) AS table_rows FROM [dbo].[orders]'],
        ['oracle', 'ORDERS', 'APP', '"ORDERS"', 'APP', 'SELECT COUNT(*) AS table_rows FROM "APP"."ORDERS"'],
        ['dameng', 'ORDERS', 'APP', '"ORDERS"', 'APP', 'SELECT COUNT(*) AS table_rows FROM "APP"."ORDERS"'],
    ])('replaces stale %s statistics with the committed count, including zero', async (type, tableName, schemaName, target, dbName, sql) => {
        const conn = { id: 'conn-1', name: type, dbName, config: { type } } as SavedConnection & { dbName: string };
        const entries = [{ tableName, schemaName, displayName: tableName, rowCount: 100 }];
        const counts = await refreshSidebarTableRowCounts(conn, entries, [target]);
        const nodes: SidebarTreeNode[] = [{ title: 'Tables', type: 'object-group', key: 'tables', children: [{
            title: tableName, type: 'table', key: 'orders', dataRef: { tableName, schemaName, rowCount: 100 },
        }] }];
        expect(query).toHaveBeenCalledWith(expect.anything(), dbName, sql);
        expect(applySidebarTableRowCounts(nodes, counts)[0].children?.[0].dataRef.rowCount).toBe(0);
        expect(nodes[0].children?.[0].dataRef.rowCount).toBe(100);
    });

    it('does not query unrelated tables or confuse identical names in different schemas', async () => {
        const conn = { id: 'conn-1', name: 'PG', dbName: 'main', config: { type: 'postgres' } } as SavedConnection & { dbName: string };
        const entries = ['public', 'reporting'].map((schemaName) => ({
            tableName: `${schemaName}.orders`, schemaName, displayName: 'orders', rowCount: 100,
        }));
        const counts = await refreshSidebarTableRowCounts(conn, entries, ['orders'], 'reporting');
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][2]).toBe('SELECT COUNT(*) AS table_rows FROM reporting.orders');
        expect(counts.size).toBe(1);
    });

    it('preserves previous counts if the live count fails or lacks a number', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const conn = { id: 'conn-1', name: 'MySQL', dbName: 'main', config: { type: 'mysql' } } as SavedConnection & { dbName: string };
        const entries = [{ tableName: 'orders', schemaName: '', displayName: 'orders', rowCount: 100 }];
        for (const response of [{ success: false, message: 'permission denied' }, { success: true, data: [{ table_rows: null }] }]) {
            query.mockResolvedValueOnce(response);
            expect((await refreshSidebarTableRowCounts(conn, entries, ['`orders`'])).size).toBe(0);
        }
    });

    it('matches case-insensitive MySQL names while treating quoted dots as part of the table name', async () => {
        const conn = { id: 'conn-1', name: 'MySQL', dbName: 'main', config: { type: 'mysql' } } as SavedConnection & { dbName: string };
        const entries = [
            { tableName: 'orders', schemaName: '', displayName: 'orders' },
            { tableName: 'audit.log', schemaName: 'audit', displayName: 'audit.log' },
        ];
        const counts = await refreshSidebarTableRowCounts(conn, entries, ['`ORDERS`', '`audit.log`']);
        expect(counts.size).toBe(2);
        expect(query.mock.calls.map((call) => call[2])).toEqual([
            'SELECT COUNT(*) AS table_rows FROM `orders`',
            'SELECT COUNT(*) AS table_rows FROM `audit.log`',
        ]);
    });
});
