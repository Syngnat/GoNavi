import { resolveSqlDialect } from '../../utils/sqlDialect';
import { quoteIdentPart } from '../../utils/sql';
import { splitSidebarQualifiedName } from '../../utils/sidebarLocate';
import { stripQueryIdentifierQuotes } from './queryEditorResultMessages';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';
import type { CompletionTableMeta } from './queryEditorCompletionCandidates';

export type QueryEditorNavigationTarget =
    | { type: 'database'; dbName: string }
    | { type: 'table'; dbName: string; tableName: string; schemaName?: string; lookupTableName?: string }
    | { type: 'view'; dbName: string; viewName: string; schemaName?: string }
    | { type: 'materialized-view'; dbName: string; viewName: string; schemaName?: string }
    | { type: 'trigger'; dbName: string; triggerName: string; tableName: string; schemaName?: string }
    | { type: 'routine'; dbName: string; routineName: string; routineType: string; schemaName?: string }
    | { type: 'sequence'; dbName: string; sequenceName: string; schemaName?: string }
    | { type: 'package'; dbName: string; packageName: string; schemaName?: string };

export type QueryEditorTableCtrlClickAction = 'open-design' | 'locate';

export type QueryEditorHoverTarget =
    | { kind: 'database'; dbName: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'table'; dbName: string; tableName: string; schemaName?: string; comment?: string; lookupTableName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'view'; dbName: string; viewName: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'materialized-view'; dbName: string; viewName: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'trigger'; dbName: string; triggerName: string; tableName: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'routine'; dbName: string; routineName: string; routineType: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'sequence'; dbName: string; sequenceName: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'package'; dbName: string; packageName: string; schemaName?: string; range: { startColumn: number; endColumn: number } }
    | { kind: 'column'; dbName: string; tableName: string; columnName: string; type?: string; comment?: string; schemaName?: string; range: { startColumn: number; endColumn: number } };

export const QUERY_EDITOR_IDENTIFIER_CHAR_REGEX = /[A-Za-z0-9_$`"\[\].]/;
export const QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN = '[A-Za-z_][A-Za-z0-9_$]*';
export const QUERY_EDITOR_SQL_QUOTED_IDENTIFIER_PATTERN = '(?:`(?:``|[^`])*`|"(?:""|[^"])*"|\\[(?:\\]\\]|[^\\]])*\\])';
export const QUERY_EDITOR_SQL_IDENTIFIER_PATTERN = `(?:${QUERY_EDITOR_SQL_QUOTED_IDENTIFIER_PATTERN}|${QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN})`;
export const QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN = `${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN}){0,2}`;
export const QUERY_EDITOR_SQL_THREE_PART_COMPLETION_REGEX = new RegExp(
    `(${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN})\\s*\\.\\s*(${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN})\\s*\\.\\s*([A-Za-z0-9_$]*)$`,
);
export const QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX = new RegExp(
    `(${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN})\\s*\\.\\s*([A-Za-z0-9_$]*)$`,
);
export const QUERY_EDITOR_SQL_TABLE_REFERENCE_REGEX = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM)\\s+(${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN})`,
    'gi',
);
export const QUERY_EDITOR_SQL_ALIAS_REFERENCE_REGEX = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM)\\s+(${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN})(?:\\s+(?:AS\\s+)?(${QUERY_EDITOR_SQL_IDENTIFIER_PATTERN}))?`,
    'gi',
);
export const QUERY_EDITOR_SQL_LEADING_IDENTIFIER_PATH_REGEX = new RegExp(`^(${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN})([\\s\\S]*)$`);
// Keep the original settle delay so moving across many identifiers does not
// start a burst of remote metadata requests (notably over SSH).
export const QUERY_EDITOR_HOVER_DELAY_MS = 1000;
export const QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH = 200_000;
export const QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS = 200;
export const QUERY_EDITOR_OBJECT_DECORATION_MAX_LINES = 1_000;
export const QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH = 50_000;
export const QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH = 50_000;

export const getQueryEditorModelValueLength = (model: any): number | null => {
    if (!model || typeof model.getValueLength !== 'function') {
        return null;
    }
    try {
        const length = Number(model.getValueLength());
        return Number.isFinite(length) ? length : null;
    } catch {
        return null;
    }
};

export type QueryIdentifierPathSegment = {
    raw: string;
    value: string;
    quoted: boolean;
};

export const isQuotedQueryIdentifierPart = (part: string): boolean => {
    const text = String(part || '').trim();
    if (!text) return false;
    return (text.startsWith('`') && text.endsWith('`'))
        || (text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith('[') && text.endsWith(']'));
};

export const supportsQueryEditorBracketIdentifier = (dbType = ''): boolean => {
    const normalized = String(resolveSqlDialect(dbType) || '').trim().toLowerCase();
    // Keep the historical generic behavior when no dialect is available: the
    // editor can be attached before connection metadata has loaded. SQL Server
    // and SQLite both accept [] identifier quoting.
    return !String(dbType || '').trim() || normalized === 'sqlserver' || normalized === 'sqlite';
};

export const supportsQueryEditorEscapedBracketIdentifier = (dbType = ''): boolean => {
    const normalized = String(resolveSqlDialect(dbType) || '').trim().toLowerCase();
    return !String(dbType || '').trim() || normalized === 'sqlserver';
};

export const isQueryEditorIdentifierCharAt = (char: string | undefined, dbType = ''): boolean => {
    if (!char) return false;
    if (/[A-Za-z0-9_$`".]/.test(char)) return true;
    return supportsQueryEditorBracketIdentifier(dbType) && /[\[\]]/.test(char);
};

export const isQuotedQueryIdentifierPartForDialect = (part: string, dbType = ''): boolean => {
    const text = String(part || '').trim();
    if (!text) return false;
    return (text.startsWith('`') && text.endsWith('`'))
        || (text.startsWith('"') && text.endsWith('"'))
        || (supportsQueryEditorBracketIdentifier(dbType) && text.startsWith('[') && text.endsWith(']'));
};

export const stripQueryIdentifierQuotesForDialect = (part: string, dbType = ''): string => {
    const text = String(part || '').trim();
    if (!supportsQueryEditorBracketIdentifier(dbType) && text.startsWith('[') && text.endsWith(']')) {
        return text;
    }
    if (supportsQueryEditorBracketIdentifier(dbType) && text.startsWith('[') && text.endsWith(']')) {
        const value = text.slice(1, -1);
        return supportsQueryEditorEscapedBracketIdentifier(dbType) ? value.replace(/]]/g, ']') : value;
    }
    return stripQueryIdentifierQuotes(text);
};

export const splitQueryIdentifierPathSegments = (qualifiedName: string, dbType = ''): QueryIdentifierPathSegment[] => {
    const text = String(qualifiedName || '').trim();
    if (!text) return [];

    const segments: QueryIdentifierPathSegment[] = [];
    let current = '';
    let inDouble = false;
    let inBacktick = false;
    let inBracket = false;
    const bracketIdentifiers = supportsQueryEditorBracketIdentifier(dbType);

    const flush = () => {
        const raw = current.trim();
        current = '';
        if (!raw) return;
        segments.push({
            raw,
            value: stripQueryIdentifierQuotesForDialect(raw, dbType),
            quoted: isQuotedQueryIdentifierPartForDialect(raw, dbType),
        });
    };

    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';

        if (inDouble) {
            current += ch;
            if (ch === '"' && next === '"') {
                current += next;
                index += 1;
                continue;
            }
            if (ch === '"') inDouble = false;
            continue;
        }

        if (inBacktick) {
            current += ch;
            if (ch === '`' && next === '`') {
                current += next;
                index += 1;
                continue;
            }
            if (ch === '`') inBacktick = false;
            continue;
        }

        if (bracketIdentifiers && inBracket) {
            current += ch;
            if (supportsQueryEditorEscapedBracketIdentifier(dbType) && ch === ']' && next === ']') {
                current += next;
                index += 1;
                continue;
            }
            if (ch === ']') inBracket = false;
            continue;
        }

        if (ch === '"') {
            inDouble = true;
            current += ch;
            continue;
        }
        if (ch === '`') {
            inBacktick = true;
            current += ch;
            continue;
        }
        if (bracketIdentifiers && ch === '[') {
            inBracket = true;
            current += ch;
            continue;
        }
        if (ch === '.') {
            flush();
            continue;
        }
        current += ch;
    }

    flush();
    return segments;
};

export const matchLeadingSelectTableReference = (sql: string): { prefix: string; tableText: string; suffix: string } | null => {
    const text = String(sql || '');
    const structuralText = maskQueryEditorSqlLiteralsAndComments(text);
    const match = structuralText.match(new RegExp(`^(\\s*SELECT\\s+[\\s\\S]+?\\s+FROM\\s+)(${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN})([\\s\\S]*)$`, 'i'));
    if (!match) return null;
    const tableStart = match[1].length;
    const tableEnd = tableStart + match[2].length;
    return {
        prefix: text.slice(0, tableStart),
        tableText: text.slice(tableStart, tableEnd),
        suffix: text.slice(tableEnd),
    };
};

export const rewriteLeadingSelectTableReference = (sql: string, replacement: string): string | undefined => {
    const match = matchLeadingSelectTableReference(sql);
    if (!match || !replacement) return undefined;
    return `${match.prefix}${replacement}${match.suffix}`;
};

export const isOracleBaseTableReference = (
    statement: string,
    currentDb: string,
    tables: CompletionTableMeta[],
): boolean => {
    const leadingTable = matchLeadingSelectTableReference(statement);
    if (!leadingTable) return false;

    const segments = splitQueryIdentifierPathSegments(leadingTable.tableText);
    if (segments.length === 0 || segments.length > 2) return false;

    const explicitSchemaName = segments.length === 2 ? String(segments[0]?.value || '').trim() : '';
    const objectName = String(segments[segments.length - 1]?.value || '').trim();
    const targetSchemaName = explicitSchemaName || String(currentDb || '').trim();
    if (!objectName || !targetSchemaName) return false;

    const normalizedSchemaName = targetSchemaName.toLowerCase();
    return tables.some((table) => {
        if (String(table.dbName || '').trim().toLowerCase() !== normalizedSchemaName) return false;
        const parsed = splitSidebarQualifiedName(String(table.tableName || ''));
        const tableObjectName = String(parsed.objectName || table.tableName || '').trim();
        const tableSchemaName = String(parsed.schemaName || table.dbName || '').trim();
        if (tableObjectName.toLowerCase() !== objectName.toLowerCase()) return false;
        return !explicitSchemaName || tableSchemaName.toLowerCase() === normalizedSchemaName;
    });
};

export const resolveOracleExactCaseTableReference = (
    statement: string,
    currentDb: string,
    tables: CompletionTableMeta[],
    options?: { qualifyUnqualified?: boolean },
): string | undefined => {
    const leadingTable = matchLeadingSelectTableReference(statement);
    if (!leadingTable) return undefined;

    const segments = splitQueryIdentifierPathSegments(leadingTable.tableText);
    if (segments.length === 0 || segments.length > 2 || segments.some((segment) => segment.quoted)) {
        return undefined;
    }
    const shouldQualifyUnqualified = Boolean(options?.qualifyUnqualified && segments.length === 1);
    if (!segments.some((segment) => /[a-z]/.test(segment.value)) && !shouldQualifyUnqualified) {
        return undefined;
    }

    const rawSchemaName = segments.length === 2 ? String(segments[0]?.value || '').trim() : '';
    const rawObjectName = String(segments[segments.length - 1]?.value || '').trim();
    const targetDbName = String(rawSchemaName || currentDb || '').trim();
    if (!rawObjectName || !targetDbName) return undefined;

    const normalizedTargetDbName = targetDbName.toLowerCase();
    const matched = tables.find((table) => {
        if (String(table.dbName || '').trim().toLowerCase() !== normalizedTargetDbName) return false;
        const parsed = splitSidebarQualifiedName(String(table.tableName || ''));
        const objectName = String(parsed.objectName || table.tableName || '').trim();
        const schemaName = String(parsed.schemaName || table.dbName || '').trim();
        if (objectName !== rawObjectName && objectName.toLowerCase() !== rawObjectName.toLowerCase()) return false;
        if (!rawSchemaName) return true;
        return schemaName.toLowerCase() === rawSchemaName.toLowerCase();
    });
    if (!matched) return undefined;

    const matchedParsed = splitSidebarQualifiedName(String(matched.tableName || ''));
    const exactObjectName = String(matchedParsed.objectName || matched.tableName || '').trim();
    const exactSchemaName = String(matchedParsed.schemaName || matched.dbName || rawSchemaName).trim();
    const quotedParts = rawSchemaName
        ? [exactSchemaName, exactObjectName]
        : shouldQualifyUnqualified
            ? [exactSchemaName || targetDbName, exactObjectName]
        : [exactObjectName];
    if (quotedParts.some((part) => !String(part || '').trim())) {
        return undefined;
    }
    return quotedParts.map((part) => quoteIdentPart('oracle', part)).join('.');
};

export const resolveOracleLikeDefaultSchemaName = (config: any): string => {
    const rawUser = String(config?.user || '').trim();
    if (!rawUser) return '';
    const userPart = rawUser.split('@')[0] || rawUser;
    return String(userPart || '').trim();
};

export const resolveOracleLikeExecutionSchemaName = (config: any, currentDb: string): string => {
    const selectedDb = String(currentDb || '').trim();
    const configuredDb = String(config?.database || '').trim();
    if (selectedDb && (!configuredDb || selectedDb.toLowerCase() !== configuredDb.toLowerCase())) {
        return selectedDb;
    }
    return resolveOracleLikeDefaultSchemaName(config) || selectedDb;
};

export const resolveOracleLikeLookupSchemaCandidates = (config: any, currentDb: string): string[] => {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        const normalized = String(value || '').trim();
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(normalized);
    };

    const defaultSchema = resolveOracleLikeDefaultSchemaName(config);
    const selectedDb = String(currentDb || '').trim();
    push(defaultSchema);
    if (selectedDb && selectedDb.toLowerCase() !== String(defaultSchema || '').trim().toLowerCase()) {
        push(selectedDb);
    }
    return candidates;
};

export const getQueryEditorModelTextIfWithinLimit = (model: any, maxTextLength: number): string | null => {
    const modelLength = getQueryEditorModelValueLength(model);
    if (modelLength !== null && modelLength > maxTextLength) {
        return null;
    }
    const text = String(model?.getValue?.() || '');
    return text.length <= maxTextLength ? text : null;
};

export const getQueryEditorObjectResolveText = (
    model: any,
    lineContent: string,
    maxTextLength = QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
): string => getQueryEditorModelTextIfWithinLimit(model, maxTextLength) ?? lineContent;

export const getQueryEditorDecorationModelTextIfLightweight = (
    model: any,
    maxTextLength: number,
): string | null => {
    if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') {
        return getQueryEditorModelTextIfWithinLimit(model, maxTextLength);
    }

    const lineCount = Number(model.getLineCount());
    if (!Number.isFinite(lineCount) || lineCount <= 0 || lineCount > QUERY_EDITOR_OBJECT_DECORATION_MAX_LINES) {
        return null;
    }

    const lines: string[] = [];
    let textLength = 0;
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
        const lineContent = String(model.getLineContent(lineNumber) || '');
        textLength += lineContent.length + (lineNumber < lineCount ? 1 : 0);
        if (textLength > maxTextLength) {
            return null;
        }
        lines.push(lineContent);
    }

    return lines.join('\n');
};
