import { dispatchSidebarDatabaseRefresh, type SidebarDatabaseRefreshRequest } from '../../utils/sidebarDatabaseRefresh';
import { findPotentiallyMutatingConnectionStatements } from '../../utils/connectionReadOnly';
import { isMysqlFamilyDialect, isOracleLikeDialect, isPgLikeDialect, quoteSqlIdentifierPart, resolveSqlDialect } from '../../utils/sqlDialect';
import { collectQueryEditorTableReferences } from './queryEditorTableReferences';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';
import { isSqlEditorSchemaChangingStatement } from '../../utils/sqlEditorTransaction';

// 数据库统计可能迟于写入更新；通知侧栏只为语句引用的已加载表补查行数。
export const dispatchSidebarSqlDataRefresh = (
    request: SidebarDatabaseRefreshRequest,
    statements: string[],
    dbType: string,
    committed = true,
): void => {
    const dialect = resolveSqlDialect(dbType);
    const targets = new Map<string, Set<string>>();
    const outcomes = new Map<string, Map<string, 'count' | 'clear' | 'drop'>>();
    const schemaChanged = statements.some((statement) => (
        isSqlEditorSchemaChangingStatement(statement, dbType)
    ));
    targets.set(request.dbName || '', new Set());
    for (const statement of statements) {
        if (!findPotentiallyMutatingConnectionStatements({ type: dbType }, statement).length) continue;
        const masked = maskQueryEditorSqlLiteralsAndComments(statement, dialect);
        // 表引用扫描器已支持 DML；TRUNCATE 的目标使用同一识别路径。
        const truncate = /^\s*TRUNCATE\s+(?:TABLE\s+)?/i.exec(masked);
        const drop = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i.exec(masked);
        const prefix = truncate || drop;
        const source = prefix ? `DELETE FROM ${statement.slice(prefix[0].length)}` : statement;
        for (const reference of collectQueryEditorTableReferences(source, dialect)) {
            const segments = reference.segments || [];
            if (!segments.length) continue;
            const normalized = segments.map((segment) => {
                if (segment.quoted) return segment;
                const value = isOracleLikeDialect(dialect) ? segment.value.toUpperCase()
                    : isPgLikeDialect(dialect) ? segment.value.toLowerCase() : segment.value;
                return { ...segment, raw: value, value };
            });
            let dbName = request.dbName || '';
            let tableSegments = normalized;
            if (normalized.length === 2 && (isMysqlFamilyDialect(dialect) || isOracleLikeDialect(dialect) || dialect === 'clickhouse')) {
                dbName = normalized[0].value;
                tableSegments = normalized.slice(1);
            } else if (normalized.length === 3 && dialect === 'sqlserver') {
                dbName = normalized[0].value;
                tableSegments = normalized.slice(1);
            }
            const tableName = tableSegments.map((segment) => quoteSqlIdentifierPart(dialect, segment.raw)).join('.');
            const tables = targets.get(dbName) || new Set<string>();
            tables.add(tableName);
            targets.set(dbName, tables);
            const changes = outcomes.get(dbName) || new Map<string, 'count' | 'clear' | 'drop'>();
            changes.set(tableName, truncate ? 'clear' : drop ? 'drop' : 'count');
            outcomes.set(dbName, changes);
        }
    }
    for (const [dbName, tables] of targets) {
        const changes = outcomes.get(dbName);
        const clearedTables = [...tables].filter(table => committed && changes?.get(table) === 'clear');
        const droppedTables = [...tables].filter(table => committed && changes?.get(table) === 'drop');
        dispatchSidebarDatabaseRefresh({ ...request, dbName, rowCountTables: [...tables],
            ...(clearedTables.length ? { clearedTables } : {}), ...(droppedTables.length ? { droppedTables } : {}),
            ...(schemaChanged ? { schemaChanged: true } : {}),
        });
    }
};
