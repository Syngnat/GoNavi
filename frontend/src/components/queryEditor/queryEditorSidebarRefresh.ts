import { dispatchSidebarDatabaseRefresh, type SidebarDatabaseRefreshRequest } from '../../utils/sidebarDatabaseRefresh';
import { findPotentiallyMutatingConnectionStatements } from '../../utils/connectionReadOnly';
import { isMysqlFamilyDialect, isOracleLikeDialect, isPgLikeDialect, quoteSqlIdentifierPart, resolveSqlDialect } from '../../utils/sqlDialect';
import { collectQueryEditorTableReferences } from './queryEditorTableReferences';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';

// 数据库统计可能迟于写入更新；通知侧栏只为语句引用的已加载表补查行数。
export const dispatchSidebarSqlDataRefresh = (
    request: SidebarDatabaseRefreshRequest,
    statements: string[],
    dbType: string,
): void => {
    const dialect = resolveSqlDialect(dbType);
    const targets = new Map<string, Set<string>>();
    targets.set(request.dbName || '', new Set());
    for (const statement of statements) {
        if (!findPotentiallyMutatingConnectionStatements({ type: dbType }, statement).length) continue;
        const masked = maskQueryEditorSqlLiteralsAndComments(statement, dialect);
        // 表引用扫描器已支持 DML；TRUNCATE 的目标使用同一识别路径。
        const truncate = /^\s*TRUNCATE\s+(?:TABLE\s+)?/i.exec(masked);
        const source = truncate ? `DELETE FROM ${statement.slice(truncate[0].length)}` : statement;
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
        }
    }
    for (const [dbName, tables] of targets) {
        dispatchSidebarDatabaseRefresh({ ...request, dbName, rowCountTables: [...tables] });
    }
};
