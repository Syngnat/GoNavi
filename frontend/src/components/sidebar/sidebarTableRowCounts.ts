import { DBQuery } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import { isMysqlFamilyDialect, isOracleLikeDialect, quoteSqlIdentifierPart } from '../../utils/sqlDialect';
import { getMetadataDialect, parseMetadataRowCount } from './sidebarMetadataBasics';
import type { SavedConnection } from '../../types';
import type { SidebarTreeNode } from '../sidebarV2Utils';
import type { SidebarLoadedTableEntry } from './sidebarTreeLoaderHelpers';

const tableIdentity = (tableName: string, schemaName = ''): string => JSON.stringify([schemaName, tableName]);
const SIDEBAR_ROW_COUNT_QUERY_TIMEOUT_SECONDS = 5;

export const refreshSidebarTableRowCounts = async (
    conn: SavedConnection & { dbName: string },
    entries: SidebarLoadedTableEntry[],
    requestedTables: string[],
    selectedSchema = '',
): Promise<Map<string, number>> => {
    const dialect = getMetadataDialect(conn);
    const mysql = isMysqlFamilyDialect(dialect);
    const counts = new Map<string, number>();
    const tables = entries.map((entry) => {
        // MySQL 返回的是裸表名，表名内的点不能当作库名分隔符。
        const parts = mysql ? [] : splitQualifiedNameSegmentsDetailed(entry.tableName, dialect);
        const name = parts.length ? parts[parts.length - 1].value : entry.tableName;
        const schema = mysql ? '' : parts.length > 1 ? parts.slice(0, -1).map((part) => part.value).join('.') : entry.schemaName;
        return { entry, name, schema };
    });
    const requested = requestedTables.map((target) => {
        const parts = splitQualifiedNameSegmentsDetailed(target, dialect);
        const name = parts[parts.length - 1]?.value;
        const exact = tables.filter((table) => table.name === name);
        const candidates = exact.length || !mysql ? exact
            : tables.filter((table) => table.name.toLowerCase() === name?.toLowerCase());
        const schema = parts.length > 1 ? parts.slice(0, -1).map((part) => part.value).join('.') : '';
        if (schema) return candidates.filter((table) => table.schema === schema);
        if (selectedSchema) return candidates.filter((table) => !table.schema || table.schema === selectedSchema);
        return candidates.length === 1 ? candidates : [];
    });
    const requestedEntries = new Set(requested.flat());
    for (const table of tables) {
        if (!requestedEntries.has(table)) continue;
        const path = [
            ...((table.schema || (isOracleLikeDialect(dialect) ? conn.dbName : ''))
                ? [table.schema || conn.dbName] : []),
            table.name,
        ].map((part) => quoteSqlIdentifierPart(dialect, part)).join('.');
        try {
            const result = await DBQuery(buildRpcConnectionConfig({
                ...conn.config, queryTimeout: SIDEBAR_ROW_COUNT_QUERY_TIMEOUT_SECONDS,
            }), conn.dbName, `SELECT COUNT(*) AS table_rows FROM ${path}`);
            const rows = result.success && Array.isArray(result.data) ? result.data : [];
            const count = rows.length ? parseMetadataRowCount(rows[0] as Record<string, unknown>) : undefined;
            if (count !== undefined) counts.set(tableIdentity(table.entry.tableName, table.entry.schemaName), count);
            else console.warn('GoNavi sidebar row count refresh failed', table.entry.tableName, result.message);
        } catch (error) {
            console.warn('GoNavi sidebar row count refresh failed', table.entry.tableName, error);
        }
    }
    return counts;
};

export const applySidebarTableRowCounts = (nodes: SidebarTreeNode[], counts: Map<string, number>): SidebarTreeNode[] => (
    nodes.map((node) => {
        const count = node.dataRef?.tableName
            ? counts.get(tableIdentity(node.dataRef.tableName, node.dataRef.schemaName || '')) : undefined;
        return {
            ...node,
            ...(count !== undefined ? { dataRef: { ...node.dataRef, rowCount: count } } : {}),
            ...(node.children ? { children: applySidebarTableRowCounts(node.children, counts) } : {}),
        };
    })
);
