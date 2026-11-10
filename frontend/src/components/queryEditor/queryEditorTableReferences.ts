import { resolveSqlDialect, isMysqlFamilyDialect } from '../../utils/sqlDialect';
import {
    supportsQueryEditorBracketIdentifier,
    supportsQueryEditorEscapedBracketIdentifier,
    QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN,
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

// 词法器每次调用都会为同一方言重建正则；大文档下单次分析动辄百万级 token，
// 正则编译与逐 token 的方言判定都会累加成肉眼可见的卡顿。方言在这里只影响
// 「方括号是否算定界标识符」，因此把布尔量算一次，token 的 quoted 直接由
// 首尾字符判断（正则匹配出的 token 不含首尾空白，与逐字符辅助函数等价）。
const queryEditorReferenceTokenRegexCache = new Map<string, RegExp>();

const getQueryEditorReferenceTokenRegex = (dbType = '', bracketIdentifiers: boolean): RegExp => {
    const key = `${String(dbType || '')}\u0000${bracketIdentifiers ? 1 : 0}`;
    const cached = queryEditorReferenceTokenRegexCache.get(key);
    if (cached) return cached;
    const regex = new RegExp(`${buildQueryEditorSqlIdentifierPattern(dbType)}|[().,;]`, 'g');
    if (queryEditorReferenceTokenRegexCache.size > 32) {
        queryEditorReferenceTokenRegexCache.clear();
    }
    queryEditorReferenceTokenRegexCache.set(key, regex);
    return regex;
};

const isQuotedReferenceToken = (raw: string, bracketIdentifiers: boolean): boolean => {
    if (raw.length < 2) return false;
    const first = raw[0];
    if (first !== '`' && first !== '"' && !(bracketIdentifiers && first === '[')) {
        return false;
    }
    const closing = first === '[' ? ']' : first;
    return raw[raw.length - 1] === closing;
};

const tokenizeQueryEditorSqlReferences = (masked: string, dbType = ''): QueryEditorSqlReferenceToken[] => {
    const bracketIdentifiers = supportsQueryEditorBracketIdentifier(dbType);
    const tokenRegex = getQueryEditorReferenceTokenRegex(dbType, bracketIdentifiers);
    tokenRegex.lastIndex = 0;
    const tokens: QueryEditorSqlReferenceToken[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(masked)) !== null) {
        const raw = match[0] || '';
        tokens.push({
            raw,
            quoted: !QUERY_EDITOR_SQL_REFERENCE_PUNCTUATION.has(raw) && isQuotedReferenceToken(raw, bracketIdentifiers),
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
    const sourceText = String(source || '');
    const tokens = tokenizeQueryEditorSqlReferences(
        maskQueryEditorSqlLiteralsAndComments(sourceText, dbType),
        dbType,
    );
    const references: QueryEditorTableReference[] = [];
    const states: QueryEditorSqlReferenceDepthState[] = [{
        fromListActive: false,
        queryStatementActive: false,
        sourceContextActive: false,
    }];
    let depth = 0;
    // 方言归一化与 iotdb 路径上限在循环外算一次：旧实现在每个表源处都调用
    // resolveSqlDialect，百万级 token 的文档里会累加成可观测的卡顿。
    const normalizedDialect = String(resolveSqlDialect(dbType) || dbType || '').toLowerCase();
    const maxPathTokens = normalizedDialect === 'iotdb'
        ? QUERY_EDITOR_IOTDB_TABLE_PATH_MAX_PARTS
        : 3;

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

type QueryEditorTableReferencesCacheEntry = {
    source: string;
    dbType: string;
    references: QueryEditorTableReference[];
};

let tableReferencesCache: QueryEditorTableReferencesCacheEntry | null = null;

// 超大文档不参与单条缓存：缓存项会以强引用同时钉住整篇源文本和全部引用对象
// （10MB 文档实测可达上百 MB），而大文档本身每次都要重扫，缓存命中率极低。
const QUERY_EDITOR_TABLE_REFERENCES_CACHE_MAX_SOURCE_LENGTH = 200_000;

export const clearQueryEditorTableReferencesCache = (): void => {
    tableReferencesCache = null;
};

export const collectQueryEditorTableReferences = (source: string, dbType = ''): QueryEditorTableReference[] => {
    const normalizedSource = String(source ?? '');
    const normalizedDbType = String(dbType ?? '');
    if (normalizedSource.length > QUERY_EDITOR_TABLE_REFERENCES_CACHE_MAX_SOURCE_LENGTH) {
        tableReferencesCache = null;
        return analyzeQueryEditorTableReferences(normalizedSource, normalizedDbType).references;
    }
    const cached = tableReferencesCache;
    if (cached && cached.source === normalizedSource && cached.dbType === normalizedDbType) {
        return cached.references;
    }
    const references = analyzeQueryEditorTableReferences(normalizedSource, normalizedDbType).references;
    // Inline ghost completion asks for the same statement several times per
    // keystroke; cache one result instead of re-lexing the whole text.
    tableReferencesCache = { source: normalizedSource, dbType: normalizedDbType, references };
    return references;
};

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
