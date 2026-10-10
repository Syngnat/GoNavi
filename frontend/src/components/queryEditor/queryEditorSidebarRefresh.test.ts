import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSidebarSqlDataRefresh } from './queryEditorSidebarRefresh';

describe('SQL write sidebar refresh targets', () => {
    const dispatchEvent = vi.fn();
    beforeEach(() => {
        dispatchEvent.mockReset();
        vi.stubGlobal('window', { dispatchEvent });
    });
    afterEach(() => vi.unstubAllGlobals());

    it.each([
        ['INSERT INTO users(id) VALUES(1)', '`users`'],
        ['DELETE FROM users WHERE id = 1', '`users`'],
        ['TRUNCATE TABLE users', '`users`'],
        ['-- truncate\nTRUNCATE `audit.log`', '`audit.log`'],
        ['UPDATE users SET name = \'DELETE FROM fake\'', '`users`'],
    ])('carries the table reference for %s', (sql, table) => {
        dispatchSidebarSqlDataRefresh({ connectionId: 'conn-1', dbName: 'main' }, [sql], 'mysql');
        expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
            detail: { connectionId: 'conn-1', dbName: 'main', rowCountTables: [table] },
        }));
    });

    it('refreshes explicit MySQL database targets separately and deduplicates repeated writes', () => {
        dispatchSidebarSqlDataRefresh({ connectionId: 'conn-1', dbName: 'main' }, [
            'INSERT INTO archive.users(id) VALUES (1)', 'DELETE FROM archive.users WHERE id = 1',
        ], 'mysql');
        const details = dispatchEvent.mock.calls.map(([event]) => event.detail);
        expect(details).toContainEqual({ connectionId: 'conn-1', dbName: 'archive', rowCountTables: ['`users`'] });
    });

    it('keeps PostgreSQL schema targets in their database and ignores read-only SQL text', () => {
        dispatchSidebarSqlDataRefresh({ connectionId: 'conn-1', dbName: 'main', schemaName: 'public' }, [
            'WITH source AS (SELECT 1) DELETE FROM reporting.orders WHERE id = 1',
            'SELECT \'DELETE FROM users\'',
        ], 'postgres');
        expect(dispatchEvent).toHaveBeenCalledOnce();
        expect(dispatchEvent.mock.calls[0][0].detail.rowCountTables).toEqual(['reporting.orders']);
    });

    it.each([
        ['oracle', 'DELETE FROM app.Orders', 'APP', '"ORDERS"'],
        ['dameng', 'DELETE FROM "app"."Orders"', 'app', '"Orders"'],
        ['sqlserver', 'DELETE FROM sales.dbo.orders', 'sales', '[dbo].[orders]'],
        ['postgres', 'DELETE FROM "reporting"."Orders"', 'main', 'reporting."Orders"'],
    ])('preserves %s identifier semantics for live counts', (type, sql, dbName, table) => {
        dispatchSidebarSqlDataRefresh({ connectionId: 'conn-1', dbName: 'main' }, [sql], type);
        expect(dispatchEvent.mock.calls.map(([event]) => event.detail)).toContainEqual({
            connectionId: 'conn-1', dbName, rowCountTables: [table],
        });
    });
});
