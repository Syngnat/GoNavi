import type { SqlLanguage } from 'sql-formatter';
import type { TabData } from '../../types';
import { resolveSqlDialect, isMysqlFamilyDialect } from '../../utils/sqlDialect';
import { hasQueryTabDraft, getQueryTabDraft } from '../../utils/sqlFileTabDrafts';
import { normalizeMetadataDialect } from './queryEditorCompletionMetadata';
import { isElasticsearchFamilyType } from '../../utils/elasticsearchFamily';

export const resolveQueryEditorConnectionTimeout = (config: Record<string, any>): number => {
    const rawTimeout = Number(config?.timeout);
    return Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30;
};

export type QueryEditorMonacoLanguage = 'sql' | 'mysql' | 'elasticsearch-console';

export const resolveQueryEditorMonacoLanguage = (conn: any): QueryEditorMonacoLanguage => {
    const connectionType = String(conn?.config?.type || '').trim().toLowerCase();
    const connectionDriver = String(conn?.config?.driver || '').trim().toLowerCase();
    if (isElasticsearchFamilyType(connectionType) || isElasticsearchFamilyType(connectionDriver)) {
        return 'elasticsearch-console';
    }
    const dialect = resolveSqlDialect(
        connectionType,
        connectionDriver,
        { oceanBaseProtocol: conn?.config?.oceanBaseProtocol },
    );
    return isMysqlFamilyDialect(dialect) ? 'mysql' : 'sql';
};

export const resolveQueryEditorFormatterLanguage = (conn: any): SqlLanguage => {
    const dialect = normalizeMetadataDialect(conn);
    switch (dialect) {
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb':
            return 'postgresql';
        case 'duckdb':
            return 'duckdb';
        case 'sqlite':
            return 'sqlite';
        case 'sqlserver':
            return 'transactsql';
        case 'oracle':
        case 'dameng':
            return 'plsql';
        case 'clickhouse':
            return 'clickhouse';
        case 'mysql':
        case 'goldendb':
        case 'sphinx':
            return 'mysql';
        case 'mariadb':
            return 'mariadb';
        default:
            return 'sql';
    }
};

export const DEFAULT_QUERY_TEMPLATE = 'SELECT * FROM ';

export const resolveNewQueryDefaultTemplate = (
    template: string | null | undefined,
): string => {
    if (template === null || template === undefined) {
        return DEFAULT_QUERY_TEMPLATE;
    }
    return String(template)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
};

export const getTabQueryValue = (tab: TabData): string => (
    typeof tab.query === 'string' ? tab.query : ''
);

export const getInitialEditorQuery = (
    tab: TabData,
    defaultQueryTemplate: string | null | undefined = DEFAULT_QUERY_TEMPLATE,
): string => {
    if (hasQueryTabDraft(tab.id)) {
        return getQueryTabDraft(tab.id);
    }
    const tabQuery = getTabQueryValue(tab);
    if (tabQuery || tab.filePath || tab.savedQueryId || tab.readOnly) {
        return tabQuery;
    }
    return resolveNewQueryDefaultTemplate(defaultQueryTemplate);
};

export const resolveNextResultSetIndex = (sets: Array<{ key?: string }>): number => {
    const maxIndex = sets.reduce((max, item) => {
        const match = String(item?.key || '').match(/^result-(\d+)$/);
        const index = match ? Number(match[1]) : 0;
        return Number.isFinite(index) ? Math.max(max, index) : max;
    }, 0);
    return maxIndex + 1;
};

export const normalizeExecutedSqlKey = (sql: string): string => String(sql || '')
    .replace(/\r\n/g, '\n')
    .replace(/；/g, ';')
    .trim()
    .replace(/;+\s*$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

export const buildQueryEditorResultSetMergeKey = (result: {
    sql?: string;
    exportSql?: string;
    sourceStatementIndex?: number;
    statementResultIndex?: number;
}): string => {
    const sqlKey = normalizeExecutedSqlKey(result.exportSql || result.sql || '');
    const sourceStatementIndex = Number(result.sourceStatementIndex ?? 1);
    const statementResultIndex = Number(result.statementResultIndex ?? 1);
    return `${sqlKey}::${sourceStatementIndex}::${statementResultIndex}`;
};

export const areSqlStatementListsEqual = (left: string[], right: string[]): boolean => (
    left.length === right.length
    && left.every((statement, index) => normalizeExecutedSqlKey(statement) === normalizeExecutedSqlKey(right[index]))
);

export const normalizeEditorPosition = (position: any): { lineNumber: number; column: number } | null => {
    if (!position) return null;
    const lineNumber = Number(position.positionLineNumber ?? position.lineNumber ?? position.endLineNumber ?? position.startLineNumber ?? position.selectionStartLineNumber);
    const column = Number(position.positionColumn ?? position.column ?? position.endColumn ?? position.startColumn ?? position.selectionStartColumn);
    if (!Number.isFinite(lineNumber) || !Number.isFinite(column) || lineNumber < 1 || column < 1) {
        return null;
    }
    return { lineNumber, column };
};

export const getNormalizedOffsetAtPosition = (
    sqlText: string,
    position: { lineNumber: number; column: number },
): number => {
    const text = String(sqlText || '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const targetLineIndex = Math.max(0, Math.min(lines.length - 1, position.lineNumber - 1));
    let offset = 0;
    for (let index = 0; index < targetLineIndex; index++) {
        offset += (lines[index]?.length || 0) + 1;
    }
    return Math.max(0, Math.min(text.length, offset + Math.max(0, position.column - 1)));
};

export const getNormalizedPositionAtOffset = (
    sqlText: string,
    offset: number,
): { lineNumber: number; column: number } => {
    const text = String(sqlText || '').replace(/\r\n/g, '\n');
    const safeOffset = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0));
    const prefix = text.slice(0, safeOffset);
    const lines = prefix.split('\n');
    return {
        lineNumber: Math.max(1, lines.length),
        column: (lines[lines.length - 1]?.length || 0) + 1,
    };
};
