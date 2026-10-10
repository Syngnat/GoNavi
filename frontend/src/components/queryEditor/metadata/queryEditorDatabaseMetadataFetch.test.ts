import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchQueryEditorDatabaseMetadata } from './queryEditorDatabaseMetadataFetch';
import { fetchQueryEditorSchemaContext } from './queryEditorSchemaContextFetch';
import type { SavedConnection } from '../../../types';
import { buildSharedLazyTablesCacheKey } from '../queryEditorLazyTablesCache';
import { setSharedConnections } from '../queryEditorCompletionState';

const rpc = vi.hoisted(() => ({ tables: vi.fn(), columns: vi.fn(), query: vi.fn() }));
vi.mock('../../../../wailsjs/go/app/App', () => ({ DBGetTables: rpc.tables, DBGetAllColumns: rpc.columns, DBQuery: rpc.query }));

describe('query metadata visibility', () => {
    const connection: SavedConnection = { id: 'pg', name: 'PG', config: { type: 'postgres', database: 'app', host: 'localhost', user: 'tester', port: 5432 }, schemaVisibilityByDatabase: { app: { mode: 'include', schemas: ['Sales'] } } };
    beforeEach(() => {
        vi.clearAllMocks();
        rpc.tables.mockResolvedValue({ success: true, data: [{ Table: 'Sales.users' }] });
        rpc.columns.mockResolvedValue({ success: true, data: [] });
        rpc.query.mockResolvedValue({ success: true, data: [] });
    });
    afterEach(() => { setSharedConnections([]); });
    it('does not reuse a lazy catalog after its schema visibility changes', () => {
        setSharedConnections([connection]);
        const first = buildSharedLazyTablesCacheKey('pg', 'app', 'postgres');
        setSharedConnections([{ ...connection, schemaVisibilityByDatabase: { app: { mode: 'include', schemas: ['public'] } } }]);
        expect(buildSharedLazyTablesCacheKey('pg', 'app', 'postgres')).not.toBe(first);
    });
    it('restricts every catalog request before the database query runs', async () => {
        await fetchQueryEditorDatabaseMetadata({ config: connection.config, metadataDialect: 'postgres', oracleMetadataOwner: '', connection }, 'app', vi.fn(), () => false);
        expect(rpc.tables.mock.calls[0][0].metadataScope.schemas.names).toEqual(['Sales']);
        expect(rpc.columns.mock.calls[0][0].metadataScope.schemas.names).toEqual(['Sales']);
        expect(rpc.query).toHaveBeenCalled();
        for (const [, , sql] of rpc.query.mock.calls) expect(sql).toContain("IN ('Sales')");
    });
    it('uses the visibility of the referenced database, not the selected database', async () => {
        await fetchQueryEditorDatabaseMetadata({ config: connection.config, metadataDialect: 'postgres', oracleMetadataOwner: '', connection }, 'other', vi.fn(), () => false);
        expect(rpc.tables.mock.calls[0][0].metadataScope).toBeUndefined();
        for (const [, , sql] of rpc.query.mock.calls) expect(sql).not.toContain("IN ('Sales')");
    });
    it('restricts schema discovery while keeping the server default-schema query intact', async () => {
        await fetchQueryEditorSchemaContext(connection, 'app');
        const sql = rpc.query.mock.calls.map((call) => String(call[2]));
        expect(sql.find((text) => text.includes('FROM pg_namespace'))).toContain("IN ('Sales')");
        expect(sql.find((text) => text.includes('current_schema()'))).not.toContain("IN ('Sales')");
    });
});
