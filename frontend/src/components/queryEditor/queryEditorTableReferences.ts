import { resolveSqlDialect, isMysqlFamilyDialect } from '../../utils/sqlDialect';
import {
    supportsQueryEditorBracketIdentifier,
    supportsQueryEditorEscapedBracketIdentifier,
    QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN,
    isQuotedQueryIdentifierPartForDialect,
    splitQueryIdentifierPathSegments,
} from './queryEditorIdentifierPaths';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';
import {
    type QueryEditorTableReference,
    QUERY_EDITOR_IOTDB_TABLE_PATH_MAX_PARTS,
} from './queryEditorReferenceIdentity';
import { stripCompletionIdentifierQuotes } from './queryEditorCompletionMetadata';

type QueryEditorSqlReferenceToken = {
    raw: string;
    quoted: boolean;
};

type QueryEditorSqlStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'replace' | 'merge';
type QueryEditorSqlTableSourceKind = 'from' | 'join' | 'comma' | 'update' | 'into';

type QueryEditorSqlReferenceDepthState = {
    fromListActive: boolean;
    queryStatementActive: boolean;
    sourceContextActive: boolean;
    statementKind?: QueryEditorSqlStatementKind;
    sourceContextKind?: QueryEditorSqlTableSourceKind;
    expectsSource?: QueryEditorSqlTableSourceKind;
};

const QUERY_EDITOR_SQL_REFERENCE_PUNCTUATION = new Set(['(', ')', '.', ',', ';']);
const QUERY_EDITOR_SQL_FROM_LIST_END_WORDS = new Set([
    'where', 'group', 'order', 'having', 'limit', 'fetch', 'offset', 'qualify', 'window',
    'union', 'except', 'intersect', 'minus', 'returning', 'set', 'values',
    'connect', 'start', 'model', 'match_recognize', 'for',
]);
const QUERY_EDITOR_SQL_TABLE_ALIAS_RESERVED_WORDS = new Set([
    ...QUERY_EDITOR_SQL_FROM_LIST_END_WORDS,
    'select', 'from', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural',
    'straight_join', 'apply', 'on', 'using', 'as', 'update', 'into', 'delete',
    'only', 'lateral', 'partition', 'sample', 'tablesample', 'with',
    'use', 'force', 'ignore', 'index', 'indexed', 'pivot', 'unpivot',
]);
const QUERY_EDITOR_SQL_TABLE_SOURCE_MODIFIERS = new Set(['only', 'lateral']);

const buildQueryEditorSqlIdentifierPattern = (dbType = ''): string => {
    if (supportsQueryEditorBracketIdentifier(dbType)) {
        const quotedWithoutBrackets = '(?:`(?:``|[^`])*`|"(?:""|[^"])*")';
        const bracketIdentifier = supportsQueryEditorEscapedBracketIdentifier(dbType)
            ? '\\[(?:\\]\\]|[^\\]])*\\]'
            : '\\[[^\\]]*\\]';
        return `(?:${quotedWithoutBrackets}|${bracketIdentifier}|${QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN})`;
    }
    const quotedWithoutBrackets = '(?:`(?:``|[^`])*`|"(?:""|[^"])*")';
    return `(?:${quotedWithoutBrackets}|${QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN})`;
};

const tokenizeQueryEditorSqlReferences = (source: string, dbType = ''): QueryEditorSqlReferenceToken[] => {
    const masked = maskQueryEditorSqlLiteralsAndComments(source, dbType);
    const tokenRegex = new RegExp(`${buildQueryEditorSqlIdentifierPattern(dbType)}|[().,;]`, 'g');
    const tokens: QueryEditorSqlReferenceToken[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(masked)) !== null) {
        const raw = match[0] || '';
        tokens.push({
            raw,
            quoted: !QUERY_EDITOR_SQL_REFERENCE_PUNCTUATION.has(raw) && isQuotedQueryIdentifierPartForDialect(raw, dbType),
        });
    }
    return tokens;
};

const isQueryEditorSqlIdentifierToken = (token: QueryEditorSqlReferenceToken | undefined): token is QueryEditorSqlReferenceToken => (
    !!token && !QUERY_EDITOR_SQL_REFERENCE_PUNCTUATION.has(token.raw)
);

/**
 * Collect physical table-like references with a small depth-aware scanner.
 * Commas only introduce another source while the same parenthesis level is in
 * a FROM list, so SELECT expressions and function arguments are not mistaken
 * for tables.
 */
export const analyzeQueryEditorTableReferences = (source: string, dbType = ''): {
    references: QueryEditorTableReference[];
    expectsTableSource: boolean;
    allowsTableAlias: boolean;
} => {
    const tokens = tokenizeQueryEditorSqlReferences(String(source || ''), dbType);
    const references: QueryEditorTableReference[] = [];
    const states: QueryEditorSqlReferenceDepthState[] = [{
        fromListActive: false,
        queryStatementActive: false,
        sourceContextActive: false,
    }];
    let depth = 0;

    const getState = () => {
        if (!states[depth]) {
            states[depth] = {
                fromListActive: false,
                queryStatementActive: false,
                sourceContextActive: false,
                statementKind: undefined,
                sourceContextKind: undefined,
            };
        }
        return states[depth];
    };

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const state = getState();

        if (token.raw === '(') {
            // A parenthesized source is a derived table or table-valued
            // expression. Its inner SELECT is scanned independently.
            state.expectsSource = undefined;
            state.sourceContextActive = false;
            depth += 1;
            states[depth] = {
                fromListActive: false,
                queryStatementActive: false,
                sourceContextActive: false,
                statementKind: undefined,
                sourceContextKind: undefined,
            };
            continue;
        }
        if (token.raw === ')') {
            states.splice(depth, 1);
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (token.raw === ';') {
            state.fromListActive = false;
            state.queryStatementActive = false;
            state.sourceContextActive = false;
            state.statementKind = undefined;
            state.sourceContextKind = undefined;
            state.expectsSource = undefined;
            continue;
        }
        if (token.raw === ',') {
            if (state.fromListActive) {
                state.expectsSource = 'comma';
                state.sourceContextActive = true;
                state.sourceContextKind = 'comma';
            }
            continue;
        }
        if (token.raw === '.') {
            continue;
        }
        if (!isQueryEditorSqlIdentifierToken(token)) {
            continue;
        }

        const keyword = token.quoted ? '' : stripCompletionIdentifierQuotes(token.raw).toLowerCase();
        if (state.expectsSource) {
            if (QUERY_EDITOR_SQL_TABLE_SOURCE_MODIFIERS.has(keyword)) {
                continue;
            }

            const pathTokens = [token.raw];
            let pathEnd = index;
            const maxPathTokens = String(resolveSqlDialect(dbType) || dbType || '').toLowerCase() === 'iotdb'
                ? QUERY_EDITOR_IOTDB_TABLE_PATH_MAX_PARTS
                : 3;
            while (
                pathTokens.length < maxPathTokens
                && tokens[pathEnd + 1]?.raw === '.'
                && isQueryEditorSqlIdentifierToken(tokens[pathEnd + 2])
            ) {
                pathTokens.push(tokens[pathEnd + 2].raw);
                pathEnd += 2;
            }
            const sourceKind = state.expectsSource;
            state.expectsSource = undefined;

            // FROM generate_series(...) and similar expressions are not
            // physical table metadata targets.
            if (
                tokens[pathEnd + 1]?.raw === '('
                && (sourceKind === 'from' || sourceKind === 'join' || sourceKind === 'comma')
            ) {
                state.sourceContextActive = false;
                state.sourceContextKind = undefined;
                index = pathEnd;
                continue;
            }

            const tableText = pathTokens.join('.');
            const pathSegments = splitQueryIdentifierPathSegments(tableText, dbType);
            const parts = pathSegments
                .map((part) => part.value.trim())
                .filter(Boolean);
            if (parts.length === 0) {
                index = pathEnd;
                continue;
            }

            let alias: string | undefined;
            let consumedEnd = pathEnd;
            const nextToken = tokens[pathEnd + 1];
            const nextKeyword = isQueryEditorSqlIdentifierToken(nextToken) && !nextToken.quoted
                ? stripCompletionIdentifierQuotes(nextToken.raw).toLowerCase()
                : '';
            if (nextKeyword === 'as') {
                const aliasToken = tokens[pathEnd + 2];
                if (isQueryEditorSqlIdentifierToken(aliasToken)) {
                    const normalizedAlias = stripCompletionIdentifierQuotes(aliasToken.raw).trim();
                    const aliasKeyword = aliasToken.quoted ? '' : normalizedAlias.toLowerCase();
                    if (normalizedAlias && (aliasToken.quoted || !QUERY_EDITOR_SQL_TABLE_ALIAS_RESERVED_WORDS.has(aliasKeyword))) {
                        alias = normalizedAlias;
                        consumedEnd = pathEnd + 2;
                    }
                }
            } else if (isQueryEditorSqlIdentifierToken(nextToken)) {
                const normalizedAlias = stripCompletionIdentifierQuotes(nextToken.raw).trim();
                if (normalizedAlias && (nextToken.quoted || !QUERY_EDITOR_SQL_TABLE_ALIAS_RESERVED_WORDS.has(nextKeyword))) {
                    alias = normalizedAlias;
                    consumedEnd = pathEnd + 1;
                }
            }

            references.push({
                tableIdent: parts.join('.'),
                parts,
                ...(alias ? { alias } : {}),
            });
            defineHiddenReferenceProperty(references[references.length - 1], 'segments', pathSegments);
            if (alias) {
                const aliasToken = nextKeyword === 'as' ? tokens[pathEnd + 2] : nextToken;
                if (isQueryEditorSqlIdentifierToken(aliasToken)) {
                    defineHiddenReferenceProperty(references[references.length - 1], 'aliasSegment', {
                        raw: aliasToken.raw,
                        value: stripCompletionIdentifierQuotes(aliasToken.raw).trim(),
                        quoted: Boolean(aliasToken.quoted),
                    });
                }
            }
            state.sourceContextActive = !alias;
            state.sourceContextKind = sourceKind;
            index = consumedEnd;
            continue;
        }

        if (keyword === 'select') {
            state.queryStatementActive = true;
            // INSERT/REPLACE ... SELECT 会切换到内部查询；已识别的其它语句
            // 类型不能被表达式或函数名中的同名标识符覆盖。
            if (!state.statementKind || state.statementKind === 'insert' || state.statementKind === 'replace') {
                state.statementKind = 'select';
            }
            state.sourceContextActive = false;
            state.sourceContextKind = undefined;
            continue;
        }
        if (keyword === 'delete' || keyword === 'insert' || keyword === 'replace' || keyword === 'merge') {
            if (!state.statementKind) {
                state.queryStatementActive = true;
                state.statementKind = keyword as QueryEditorSqlStatementKind;
                state.sourceContextActive = false;
                state.sourceContextKind = undefined;
            }
            continue;
        }
        if (keyword === 'update') {
            if (!state.statementKind) {
                state.queryStatementActive = true;
                state.statementKind = 'update';
                state.expectsSource = 'update';
                state.sourceContextActive = true;
                state.sourceContextKind = 'update';
            }
            continue;
        }
        if (keyword === 'from' && state.queryStatementActive) {
            state.fromListActive = true;
            state.expectsSource = 'from';
            state.sourceContextActive = true;
            state.sourceContextKind = 'from';
            continue;
        }
        if (keyword === 'join' || keyword === 'straight_join' || keyword === 'apply') {
            state.fromListActive = true;
            state.expectsSource = 'join';
            state.sourceContextActive = true;
            state.sourceContextKind = 'join';
            continue;
        }
        if (keyword === 'into') {
            state.queryStatementActive = true;
            state.expectsSource = keyword;
            state.sourceContextActive = true;
            state.sourceContextKind = keyword;
            continue;
        }
        if (QUERY_EDITOR_SQL_FROM_LIST_END_WORDS.has(keyword)) {
            state.fromListActive = false;
            state.sourceContextActive = false;
            state.sourceContextKind = undefined;
            state.expectsSource = undefined;
            continue;
        }
        if (QUERY_EDITOR_SQL_TABLE_ALIAS_RESERVED_WORDS.has(keyword)) {
            state.sourceContextActive = false;
            state.sourceContextKind = undefined;
        }
    }

    const state = getState();
    let expectsTableSource = state.sourceContextActive;
    // Once a physical source has been parsed, a trailing dot is normally the
    // start of a column qualification (`FROM users.`), not another table
    // source. Qualified table completion has its own dot-aware path below;
    // keeping this flag false prevents hover/DDL inference from targeting the
    // column token as a table.
    if (expectsTableSource && String(source || '').replace(/\s+$/, '').endsWith('.')) {
        expectsTableSource = false;
    }
    return {
        references,
        expectsTableSource,
        allowsTableAlias: state.sourceContextActive
            && state.statementKind === 'select'
            && (state.sourceContextKind === 'from' || state.sourceContextKind === 'join' || state.sourceContextKind === 'comma'),
    };
};

const defineHiddenReferenceProperty = <T extends object, K extends PropertyKey, V>(
    target: T,
    key: K,
    value: V,
): T & Record<K, V> => {
    Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
    });
    return target as T & Record<K, V>;
};

export const collectQueryEditorTableReferences = (source: string, dbType = ''): QueryEditorTableReference[] => (
    analyzeQueryEditorTableReferences(source, dbType).references
);

export type QueryEditorExecutionContext = { dbName?: string; schemaName?: string };

export const resolveIotdbVisibleStorageGroup = (
    parts: string[],
    visible: Map<string, string>,
): string | undefined => {
    if (parts.length < 2 || visible.size === 0) return undefined;
    for (let length = parts.length - 1; length >= 1; length -= 1) {
        const matched = visible.get(parts.slice(0, length).join('.').toLowerCase());
        if (matched) return matched;
    }
    return undefined;
};

export const usesQueryEditorCatalogQualifiedTwoPartNames = (dialect: string): boolean => {
    const normalizedDialect = String(resolveSqlDialect(dialect) || '').toLowerCase();
    return isMysqlFamilyDialect(normalizedDialect)
        || normalizedDialect === 'clickhouse'
        || normalizedDialect === 'tdengine';
};
