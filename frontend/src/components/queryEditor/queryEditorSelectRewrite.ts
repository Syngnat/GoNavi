import { quoteIdentPart } from '../../utils/sql';
import { ORACLE_ROWID_LOCATOR_COLUMN, DUCKDB_ROWID_LOCATOR_COLUMN } from '../../utils/rowLocator';
import {
    stripQueryIdentifierQuotes,
    type SimpleSelectInfo,
    QUERY_LOCATOR_ALIAS_PREFIX,
} from './queryEditorResultMessages';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';
import { QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN } from './queryEditorIdentifierPaths';

export const splitTopLevelComma = (text: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let inBracket = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const ch = text[index];
        const next = text[index + 1] || '';
        const previous = text[index - 1] || '';
        if (inLineComment) {
            current += ch;
            if (ch === '\n' || ch === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            current += ch;
            if (ch === '*' && next === '/') {
                current += next;
                index += 1;
                inBlockComment = false;
            }
            continue;
        }
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if ((inSingle || inDouble) && ch === '\\') {
            current += ch;
            escaped = true;
            continue;
        }
        if (!inDouble && !inBacktick && ch === "'") {
            inSingle = !inSingle;
            current += ch;
            continue;
        }
        if (!inSingle && !inBacktick && ch === '"') {
            inDouble = !inDouble;
            current += ch;
            continue;
        }
        if (!inSingle && !inDouble && ch === '`') {
            inBacktick = !inBacktick;
            current += ch;
            continue;
        }
        if (!inSingle && !inDouble && !inBacktick && ch === '[') {
            inBracket = true;
            current += ch;
            continue;
        }
        if (inBracket) {
            current += ch;
            if (ch === ']' && next === ']') {
                current += next;
                index += 1;
            } else if (ch === ']') {
                inBracket = false;
            }
            continue;
        }
        if (!inSingle && !inDouble && !inBacktick) {
            if (ch === '/' && next === '*') {
                current += ch;
                inBlockComment = true;
                continue;
            }
            if (ch === '-' && next === '-' && (index === 0 || /\s/.test(previous))) {
                current += ch;
                inLineComment = true;
                continue;
            }
            if (ch === '#' && next !== '>' && next !== '-') {
                current += ch;
                inLineComment = true;
                continue;
            }
            if (ch === '(') parenDepth++;
            if (ch === ')' && parenDepth > 0) parenDepth--;
            if (ch === ',' && parenDepth === 0) {
                parts.push(current.trim());
                current = '';
                continue;
            }
        }
        current += ch;
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
};

export const SIMPLE_IDENTIFIER_PATH_RE = /^(?:[`"\[]?[A-Za-z_][\w$]*[`"\]]?\s*\.\s*){0,2}[`"\[]?[A-Za-z_][\w$]*[`"\]]?$/;
export const QUERY_ALIAS_RESERVED = new Set([
    'where', 'group', 'order', 'having', 'limit', 'fetch', 'offset', 'join', 'left', 'right', 'inner', 'outer', 'on', 'union',
    'for', 'connect', 'start', 'window', 'sample', 'pivot', 'unpivot', 'qualify', 'model',
]);

export const getLastIdentifierPart = (path: string): string => {
    const parts = String(path || '').split('.').map((part) => stripQueryIdentifierQuotes(part.trim())).filter(Boolean);
    return parts[parts.length - 1] || '';
};

export type SelectItemInfo = {
    expression: string;
    resultName: string;
    sourceName?: string;
};

export const resolveSelectItemInfo = (item: string): SelectItemInfo | 'all' | undefined => {
    const text = String(item || '').trim();
    if (!text) return undefined;
    if (text === '*' || /\.\s*\*$/.test(text)) return 'all';

    let expr = text;
    let alias = '';
    const asMatch = text.match(/^(.*?)\s+AS\s+([`"\[]?[A-Za-z_][\w$]*[`"\]]?)$/i);
    if (asMatch) {
        expr = asMatch[1].trim();
        alias = stripQueryIdentifierQuotes(asMatch[2]);
    } else {
        const bareAliasMatch = text.match(/^(.*?)\s+([`"\[]?[A-Za-z_][\w$]*[`"\]]?)$/);
        if (bareAliasMatch && SIMPLE_IDENTIFIER_PATH_RE.test(bareAliasMatch[1].trim())) {
            const candidateAlias = stripQueryIdentifierQuotes(bareAliasMatch[2]);
            if (candidateAlias && !QUERY_ALIAS_RESERVED.has(candidateAlias.toLowerCase())) {
                expr = bareAliasMatch[1].trim();
                alias = candidateAlias;
            }
        }
    }

    if (!alias && !SIMPLE_IDENTIFIER_PATH_RE.test(expr)) return undefined;
    const sourceName = SIMPLE_IDENTIFIER_PATH_RE.test(expr) ? getLastIdentifierPart(expr) : '';
    const resultName = alias || sourceName;
    return resultName ? { expression: expr, resultName, sourceName: sourceName || undefined } : undefined;
};

export const resolveSimpleSelectItemColumn = (item: string): { resultName: string; sourceName: string } | 'all' | undefined => {
    const resolved = resolveSelectItemInfo(item);
    if (!resolved || resolved === 'all' || !resolved.sourceName) return resolved === 'all' ? 'all' : undefined;
    return { resultName: resolved.resultName, sourceName: resolved.sourceName };
};

export const parseSimpleSelectInfo = (sql: string): SimpleSelectInfo | undefined => {
    const text = String(sql || '');
    // Keep offsets identical to the original SQL while hiding comments and
    // string literals from the SELECT/FROM structure matcher. A comment before
    // SELECT must not make an otherwise writable result look read-only.
    const structuralText = maskQueryEditorSqlLiteralsAndComments(text);
    const match = structuralText.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+/i);
    if (!match) return undefined;
    const selectList = match[1].trim();
    if (!selectList || /^DISTINCT\b/i.test(selectList)) return undefined;

    const writableColumns: Record<string, string> = {};
    let selectsAll = false;
    let selectsBareAll = false;
    for (const item of splitTopLevelComma(selectList)) {
        const trimmedItem = String(item || '').trim();
        const resolved = resolveSimpleSelectItemColumn(item);
        if (!resolved) continue;
        if (resolved === 'all') {
            selectsAll = true;
            if (trimmedItem === '*') {
                selectsBareAll = true;
            }
            continue;
        }
        writableColumns[resolved.resultName] = resolved.sourceName;
    }
    return { selectsAll, selectsBareAll, writableColumns };
};

export const appendQuerySelectExpressions = (sql: string, expressions: string[]): string => {
    if (expressions.length === 0) return sql;
    const text = String(sql || '');
    const structuralText = maskQueryEditorSqlLiteralsAndComments(text);
    const match = structuralText.match(/^(\s*SELECT\s+)([\s\S]+?)(\s+FROM\s+[\s\S]*)$/i);
    if (!match) return text;
    const prefixLength = match[1].length;
    const selectListLength = match[2].length;
    const selectListStructure = structuralText.slice(prefixLength, prefixLength + selectListLength);
    let insertionOffset = selectListStructure.length;
    while (insertionOffset > 0 && /\s/.test(selectListStructure[insertionOffset - 1] || '')) {
        insertionOffset -= 1;
    }
    const insertionPoint = prefixLength + insertionOffset;
    return `${text.slice(0, insertionPoint)}, ${expressions.join(', ')}${text.slice(insertionPoint)}`;
};

export const QUERY_LOCATOR_SOURCE_ALIAS = 'gonavi_query_source';

export const rewriteOracleSelectAllWithExpressions = (sql: string, expressions: string[]): string | undefined => {
    if (expressions.length === 0) return undefined;

    const text = String(sql || '');
    const structuralText = maskQueryEditorSqlLiteralsAndComments(text);
    const match = structuralText.match(/^(\s*SELECT\s+)([\s\S]+?)(\s+FROM\s+)([\s\S]*)$/i);
    if (!match) return undefined;

    const prefix = match[1];
    const selectList = text.slice(prefix.length, prefix.length + match[2].length).trim();
    const fromSeparatorStart = prefix.length + match[2].length;
    const fromSeparator = text.slice(fromSeparatorStart, fromSeparatorStart + match[3].length);
    const fromTailStart = fromSeparatorStart + match[3].length;
    const selectItems = splitTopLevelComma(selectList);
    if (selectItems.length === 0) return undefined;

    let selectAllFound = false;
    for (const item of selectItems) {
        if (maskQueryEditorSqlLiteralsAndComments(item).trim() === '*') {
            selectAllFound = true;
            break;
        }
    }
    if (!selectAllFound) return undefined;

    const structuralFromTail = structuralText.slice(fromTailStart);
    const tableMatch = structuralFromTail.match(new RegExp(`^(\\s*)(${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN})([\\s\\S]*)$`));
    if (!tableMatch) return undefined;

    const tableStart = fromTailStart + (tableMatch[1] || '').length;
    const tableEnd = tableStart + tableMatch[2].length;
    const tableText = text.slice(tableStart, tableEnd);
    const afterTable = text.slice(tableEnd);

    const parseAlias = (tail: string): { alias: string; remainder: string } => {
        const trimmedTail = String(tail || '').trimStart();
        if (!trimmedTail) {
            return { alias: '', remainder: tail };
        }

        const asMatch = trimmedTail.match(/^AS\s+([`"\[]?[A-Za-z_][\w$]*[`"\]]?)([\s\S]*)$/i);
        if (asMatch) {
            const candidate = stripQueryIdentifierQuotes(asMatch[1]);
            if (candidate && !QUERY_ALIAS_RESERVED.has(candidate.toLowerCase())) {
                return { alias: candidate, remainder: asMatch[2] || '' };
            }
        }

        const bareMatch = trimmedTail.match(/^([`"\[]?[A-Za-z_][\w$]*[`"\]]?)([\s\S]*)$/);
        if (bareMatch) {
            const candidate = stripQueryIdentifierQuotes(bareMatch[1]);
            if (candidate && !QUERY_ALIAS_RESERVED.has(candidate.toLowerCase())) {
                return { alias: candidate, remainder: bareMatch[2] || '' };
            }
        }

        return { alias: '', remainder: tail };
    };

    const parsedAlias = parseAlias(afterTable);
    const sourceAlias = parsedAlias.alias || QUERY_LOCATOR_SOURCE_ALIAS;
    const qualifiedExpressions = expressions
        .map((expression) => {
            const trimmed = String(expression || '').trim();
            if (!trimmed) return '';
            if (/^ROWID\b/i.test(trimmed)) {
                return trimmed.replace(/^(\s*)ROWID\b/i, `$1${sourceAlias}.ROWID`);
            }
            return trimmed;
        })
        .filter(Boolean);
    if (qualifiedExpressions.length === 0) return undefined;

    const rewrittenSelectItems = selectItems.map((item) => {
        const rawItem = String(item || '');
        const structuralItem = maskQueryEditorSqlLiteralsAndComments(rawItem);
        if (structuralItem.trim() === '*') {
            const wildcardOffset = structuralItem.indexOf('*');
            return `${rawItem.slice(0, wildcardOffset)}${sourceAlias}.*${rawItem.slice(wildcardOffset + 1)}`;
        }
        return rawItem.trimEnd();
    });

    const aliasClause = parsedAlias.alias ? ` ${parsedAlias.alias}` : ` ${sourceAlias}`;
    const finalSelectItems = [...rewrittenSelectItems, ...qualifiedExpressions];
    return `${text.slice(0, prefix.length)}${finalSelectItems.join(', ')}${fromSeparator}${text.slice(fromTailStart, tableStart)}${tableText}${aliasClause}${parsedAlias.remainder}`;
};

export const rewriteOracleDuplicateSelectColumns = (sql: string, tableColumnNames: string[]): string | undefined => {
    const metadataNames = new Set(
        tableColumnNames
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean),
    );
    if (metadataNames.size === 0) return undefined;

    const text = String(sql || '');
    const structuralText = maskQueryEditorSqlLiteralsAndComments(text);
    const match = structuralText.match(/^(\s*SELECT\s+)([\s\S]+?)(\s+FROM\s+[\s\S]*)$/i);
    if (!match) return undefined;

    const prefix = match[1];
    const selectList = text.slice(prefix.length, prefix.length + match[2].length).trim();
    const rest = text.slice(prefix.length + match[2].length);
    const selectItems = splitTopLevelComma(selectList);
    if (selectItems.length === 0) return undefined;

    const parsedItems = selectItems.map((item) => ({
        raw: String(item || '').trimEnd(),
        info: resolveSelectItemInfo(item),
    }));
    const hasWildcard = parsedItems.some(({ info }) => info === 'all');
    if (!hasWildcard) return undefined;

    const usedResultNames = new Set<string>(metadataNames);
    parsedItems.forEach(({ info }) => {
        if (!info || info === 'all') return;
        const normalizedResult = String(info.resultName || '').trim().toLowerCase();
        if (normalizedResult) usedResultNames.add(normalizedResult);
    });

    let changed = false;
    const rewrittenItems = parsedItems.map(({ raw, info }) => {
        if (!info || info === 'all') return raw;
        const normalizedResult = String(info.resultName || '').trim().toLowerCase();
        if (!metadataNames.has(normalizedResult)) return raw;

        let nextIndex = 1;
        let alias = `${info.resultName}_${nextIndex}`;
        while (usedResultNames.has(alias.toLowerCase())) {
            nextIndex++;
            alias = `${info.resultName}_${nextIndex}`;
        }
        usedResultNames.add(alias.toLowerCase());
        changed = true;
        return `${info.expression} AS ${alias}`;
    });

    return changed ? `${text.slice(0, prefix.length)}${rewrittenItems.join(', ')}${rest}` : undefined;
};

export const findWritableResultColumnForSource = (writableColumns: Record<string, string>, target: string): string | undefined => {
    const normalizedTarget = String(target || '').trim().toLowerCase();
    return Object.entries(writableColumns || {}).find(([, sourceColumn]) => (
        String(sourceColumn || '').trim().toLowerCase() === normalizedTarget
    ))?.[0];
};

export const resolveMetadataColumnName = (tableColumnNames: string[], sourceColumn: string): string => {
    const normalizedSource = String(sourceColumn || '').trim();
    if (!normalizedSource) return '';
    return tableColumnNames.find((column) => String(column || '').trim().toLowerCase() === normalizedSource.toLowerCase())
        || normalizedSource;
};

export const buildQueryLocatorAlias = (column: string, index: number): string => {
    const normalized = String(column || '').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48) || 'column';
    return `${QUERY_LOCATOR_ALIAS_PREFIX}${index}_${normalized}`;
};

export const buildQueryLocatorColumnExpression = (dbType: string, column: string, alias: string): string => (
    `${quoteIdentPart(dbType, column)} AS ${quoteIdentPart(dbType, alias)}`
);

export const buildQueryRowIDExpression = (dbType: string, sourceAlias?: string): string => (
    `${sourceAlias ? `${sourceAlias}.` : ''}ROWID AS ${quoteIdentPart(dbType, ORACLE_ROWID_LOCATOR_COLUMN)}`
);

export const buildDuckDBRowIDExpression = (dbType: string, sourceAlias?: string): string => (
    `${sourceAlias ? `${sourceAlias}.` : ''}rowid AS ${quoteIdentPart(dbType, DUCKDB_ROWID_LOCATOR_COLUMN)}`
);

export const escapeMetadataSqlLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");

export const quoteSqlServerDbIdentifier = (raw: string): string => `[${String(raw || '').replace(/]/g, ']]')}]`;
