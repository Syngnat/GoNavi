import { getDataSourceCapabilityContract } from './dataSourceCapabilities';
import {
    supportsSqlBracketIdentifier,
    supportsSqlEscapedBracketIdentifier,
} from './sqlStatementSelection';

const SQL_EDITOR_DML_KEYWORDS = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'upsert']);
const SQL_EDITOR_READ_KEYWORDS = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain', 'pragma', 'values']);
const SQL_EDITOR_SCHEMA_CHANGE_KEYWORDS = new Set(['create', 'alter', 'drop', 'rename', 'comment', 'reindex']);
const SQL_EDITOR_TRANSACTION_CONTROL_KEYWORDS = new Set(['begin', 'commit', 'rollback', 'savepoint', 'release']);
const SQL_EDITOR_BEGIN_TRANSACTION_CONTROL_KEYWORDS = new Set([
    'transaction',
    'tran',
    'work',
    'isolation',
    'read',
    'write',
    'deferred',
    'immediate',
    'exclusive',
    'distributed',
]);
type SqlEditorWithAnalysis = {
    keyword: string;
    cteHasManagedWrite: boolean;
};

const isSqlEditorKeywordChar = (char: string | undefined): boolean => !!char && /[A-Za-z0-9_]/.test(char);

const skipSqlEditorTrivia = (text: string, start: number): number => {
    let pos = start;
    while (pos < text.length) {
        const char = text[pos];
        if (/\s/.test(char || '')) {
            pos++;
            continue;
        }
        if (text.startsWith('--', pos) || text.startsWith('#', pos)) {
            const nextLine = text.indexOf('\n', pos);
            if (nextLine < 0) return text.length;
            pos = nextLine + 1;
            continue;
        }
        if (text.startsWith('/*', pos)) {
            const blockEnd = text.indexOf('*/', pos + 2);
            if (blockEnd < 0) return text.length;
            pos = blockEnd + 2;
            continue;
        }
        return pos;
    }
    return pos;
};

const readSqlEditorKeyword = (text: string, start: number): { keyword: string; end: number } => {
    const pos = skipSqlEditorTrivia(text, start);
    if (!isSqlEditorKeywordChar(text[pos])) {
        return { keyword: '', end: pos };
    }
    let end = pos + 1;
    while (isSqlEditorKeywordChar(text[end])) {
        end++;
    }
    return { keyword: text.slice(pos, end).toLowerCase(), end };
};

const skipSqlEditorDelimited = (text: string, start: number, delimiter: string): number => {
    let pos = start + 1;
    while (pos < text.length) {
        if (text[pos] === delimiter) {
            if (text[pos + 1] === delimiter) {
                pos += 2;
                continue;
            }
            return pos + 1;
        }
        pos++;
    }
    return text.length;
};

const skipSqlEditorBracketIdentifier = (text: string, start: number, dbType = ''): number => {
    let pos = start + 1;
    while (pos < text.length) {
        if (text[pos] === ']') {
            if (supportsSqlEscapedBracketIdentifier(dbType) && text[pos + 1] === ']') {
                pos += 2;
                continue;
            }
            return pos + 1;
        }
        pos++;
    }
    return text.length;
};

const resolveSqlEditorDollarQuoteTag = (text: string, start: number): string => {
    if (text[start] !== '$') return '';
    let end = start + 1;
    while (isSqlEditorKeywordChar(text[end])) {
        end++;
    }
    return text[end] === '$' ? text.slice(start, end + 1) : '';
};

const skipSqlEditorQuotedOrComment = (text: string, start: number, dbType = ''): number | null => {
    if (text.startsWith('--', start) || text.startsWith('#', start)) {
        const nextLine = text.indexOf('\n', start);
        return nextLine < 0 ? text.length : nextLine + 1;
    }
    if (text.startsWith('/*', start)) {
        const blockEnd = text.indexOf('*/', start + 2);
        return blockEnd < 0 ? text.length : blockEnd + 2;
    }
    const char = text[start];
    if (char === '\'' || char === '"' || char === '`') {
        return skipSqlEditorDelimited(text, start, char);
    }
    if (char === '[' && supportsSqlBracketIdentifier(dbType)) {
        return skipSqlEditorBracketIdentifier(text, start, dbType);
    }
    const dollarTag = resolveSqlEditorDollarQuoteTag(text, start);
    if (dollarTag) {
        const dollarEnd = text.indexOf(dollarTag, start + dollarTag.length);
        return dollarEnd < 0 ? text.length : dollarEnd + dollarTag.length;
    }
    return null;
};

const skipBalancedSqlEditorParens = (text: string, start: number, dbType = ''): number => {
    if (text[start] !== '(') return -1;
    let depth = 0;
    let pos = start;
    while (pos < text.length) {
        const skipped = skipSqlEditorQuotedOrComment(text, pos, dbType);
        if (skipped !== null) {
            pos = skipped;
            continue;
        }
        if (text[pos] === '(') {
            depth++;
            pos++;
            continue;
        }
        if (text[pos] === ')') {
            depth--;
            pos++;
            if (depth === 0) return pos;
            continue;
        }
        pos++;
    }
    return -1;
};

const skipSqlEditorIdentifierToken = (text: string, start: number, dbType = ''): number => {
    if (start >= text.length) return -1;
    const char = text[start];
    if (char === '"' || char === '`') return skipSqlEditorDelimited(text, start, char);
    if (char === '[' && supportsSqlBracketIdentifier(dbType)) {
        return skipSqlEditorBracketIdentifier(text, start, dbType);
    }
    if (!isSqlEditorKeywordChar(char)) return -1;
    let end = start + 1;
    while (isSqlEditorKeywordChar(text[end])) {
        end++;
    }
    return end;
};

const findTopLevelSqlEditorKeyword = (text: string, start: number, keyword: string, dbType = ''): number => {
    let depth = 0;
    let pos = start;
    while (pos < text.length) {
        const skipped = skipSqlEditorQuotedOrComment(text, pos, dbType);
        if (skipped !== null) {
            pos = skipped;
            continue;
        }
        if (text[pos] === '(') {
            depth++;
            pos++;
            continue;
        }
        if (text[pos] === ')') {
            if (depth > 0) depth--;
            pos++;
            continue;
        }
        if (depth === 0 && isSqlEditorKeywordChar(text[pos])) {
            let end = pos + 1;
            while (isSqlEditorKeywordChar(text[end])) {
                end++;
            }
            if (text.slice(pos, end).toLowerCase() === keyword) {
                return end;
            }
            pos = end;
            continue;
        }
        pos++;
    }
    return -1;
};

const resolveSqlEditorWithAnalysis = (text: string, start: number, dbType = ''): SqlEditorWithAnalysis => {
    let pos = skipSqlEditorTrivia(text, start);
    let cteHasManagedWrite = false;
    const recursive = readSqlEditorKeyword(text, pos);
    if (recursive.keyword === 'recursive') {
        pos = recursive.end;
    }

    while (pos < text.length) {
        pos = skipSqlEditorTrivia(text, pos);
        const identifierEnd = skipSqlEditorIdentifierToken(text, pos, dbType);
        if (identifierEnd < 0) return { keyword: '', cteHasManagedWrite };
        pos = skipSqlEditorTrivia(text, identifierEnd);
        if (text[pos] === '(') {
            const columnsEnd = skipBalancedSqlEditorParens(text, pos, dbType);
            if (columnsEnd < 0) return { keyword: '', cteHasManagedWrite };
            pos = skipSqlEditorTrivia(text, columnsEnd);
        }

        const asEnd = findTopLevelSqlEditorKeyword(text, pos, 'as', dbType);
        if (asEnd < 0) return { keyword: '', cteHasManagedWrite };
        pos = skipSqlEditorTrivia(text, asEnd);
        const materialized = readSqlEditorKeyword(text, pos);
        if (materialized.keyword === 'not') {
            const next = readSqlEditorKeyword(text, materialized.end);
            if (next.keyword === 'materialized') {
                pos = next.end;
            }
        } else if (materialized.keyword === 'materialized') {
            pos = materialized.end;
        }

        pos = skipSqlEditorTrivia(text, pos);
        if (text[pos] !== '(') return { keyword: '', cteHasManagedWrite };
        const cteBodyStart = pos + 1;
        const cteEnd = skipBalancedSqlEditorParens(text, pos, dbType);
        if (cteEnd < 0) return { keyword: '', cteHasManagedWrite };
        const cteBody = text.slice(cteBodyStart, Math.max(cteBodyStart, cteEnd - 1));
        if (sqlEditorStatementHasManagedWrite(cteBody, dbType)) {
            cteHasManagedWrite = true;
        }
        pos = skipSqlEditorTrivia(text, cteEnd);
        if (text[pos] === ',') {
            pos++;
            continue;
        }

        return { keyword: readSqlEditorKeyword(text, pos).keyword, cteHasManagedWrite };
    }
    return { keyword: '', cteHasManagedWrite };
};

export const resolveSqlEditorOperationKeyword = (statement: string, dbType = ''): string => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    if (leading.keyword !== 'with') {
        return leading.keyword;
    }
    return resolveSqlEditorWithAnalysis(text, leading.end, dbType).keyword || leading.keyword;
};

export const isSqlEditorSchemaChangingStatement = (statement: string, dbType = ''): boolean => (
    (() => {
        const text = String(statement || '');
        const keyword = resolveSqlEditorOperationKeyword(text, dbType);
        if (SQL_EDITOR_SCHEMA_CHANGE_KEYWORDS.has(keyword)) return true;
        // Anonymous PL/SQL/T-SQL blocks can contain DDL after a non-DDL
        // wrapper keyword. Scan only those block forms; ordinary SELECT/DML
        // statements remain on the cheap keyword path.
        // PostgreSQL `DO $$...$$` bodies are executable code. The lexical
        // scanner intentionally skips dollar-quoted text, so looking for a
        // literal CREATE token there would miss dynamic/static DDL. Treat the
        // block as schema-changing conservatively; stale metadata is worse
        // than one extra refresh.
        if (keyword === 'do') return true;
        if (!['begin', 'declare'].includes(keyword)) return false;
        if (sqlEditorStatementContainsDynamicSql(text, dbType)) return true;
        return sqlEditorStatementContainsSchemaChangeKeyword(text, dbType);
    })()
);

export const hasTopLevelSqlEditorForUpdate = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    if (resolveSqlEditorOperationKeyword(text, dbType) !== 'select') return false;
    let searchFrom = 0;
    while (searchFrom < text.length) {
        const forEnd = findTopLevelSqlEditorKeyword(text, searchFrom, 'for', dbType);
        if (forEnd < 0) return false;
        if (readSqlEditorKeyword(text, forEnd).keyword === 'update') return true;
        searchFrom = forEnd;
    }
    return false;
};

const sqlEditorStatementHasManagedWrite = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    if (leading.keyword === 'with') {
        const analysis = resolveSqlEditorWithAnalysis(text, leading.end, dbType);
        return analysis.cteHasManagedWrite || SQL_EDITOR_DML_KEYWORDS.has(analysis.keyword);
    }
    return SQL_EDITOR_DML_KEYWORDS.has(leading.keyword);
};

const sqlEditorStatementContainsKeyword = (statement: string, wantedKeyword: string, dbType = ''): boolean => {
    const text = String(statement || '');
    for (let pos = 0; pos < text.length;) {
        const skipped = skipSqlEditorQuotedOrComment(text, pos, dbType);
        if (skipped !== null) {
            pos = skipped;
            continue;
        }
        if (!isSqlEditorKeywordChar(text[pos])) {
            pos++;
            continue;
        }
        let end = pos + 1;
        while (isSqlEditorKeywordChar(text[end])) {
            end++;
        }
        if (text.slice(pos, end).toLowerCase() === wantedKeyword) {
            return true;
        }
        pos = end;
    }
    return false;
};

const isSqlEditorSchemaKeywordAtStatementStart = (
    text: string,
    tokenEnd: number,
    keyword: string,
): boolean => {
    const next = skipSqlEditorTrivia(text, tokenEnd);
    if (next >= text.length) {
        return keyword !== 'comment';
    }
    // A variable/column assignment such as `comment := ...` is not a schema
    // statement. COMMENT has an especially common collision with column names,
    // so require its SQL DDL continuation explicitly.
    if (text[next] === '=' || (text[next] === ':' && text[next + 1] === '=')) {
        return false;
    }
    if (keyword === 'comment') {
        return readSqlEditorKeyword(text, next).keyword === 'on';
    }
    return text[next] !== '.';
};

const sqlEditorStatementContainsSchemaChangeKeyword = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    let statementStart = true;
    for (let pos = 0; pos < text.length;) {
        const skipped = skipSqlEditorQuotedOrComment(text, pos, dbType);
        if (skipped !== null) {
            pos = skipped;
            continue;
        }
        if (text[pos] === ';') {
            statementStart = true;
            pos++;
            continue;
        }
        if (!isSqlEditorKeywordChar(text[pos])) {
            pos++;
            continue;
        }

        let end = pos + 1;
        while (isSqlEditorKeywordChar(text[end])) end++;
        const keyword = text.slice(pos, end).toLowerCase();
        if (
            statementStart
            && SQL_EDITOR_SCHEMA_CHANGE_KEYWORDS.has(keyword)
            && isSqlEditorSchemaKeywordAtStatementStart(text, end, keyword)
        ) {
            return true;
        }

        // PL/SQL/T-SQL branches can start a nested statement without a
        // semicolon immediately before it (`IF ... THEN ALTER ...`).
        statementStart = ['begin', 'then', 'else', 'loop', 'case'].includes(keyword);
        pos = end;
    }
    return false;
};

const sqlEditorStatementContainsKeywordSequence = (
    statement: string,
    firstKeyword: string,
    secondKeyword: string,
    dbType = '',
): boolean => {
    const text = String(statement || '');
    let previousKeyword = '';
    for (let pos = 0; pos < text.length;) {
        const skipped = skipSqlEditorQuotedOrComment(text, pos, dbType);
        if (skipped !== null) {
            pos = skipped;
            continue;
        }
        if (!isSqlEditorKeywordChar(text[pos])) {
            pos++;
            continue;
        }
        let end = pos + 1;
        while (isSqlEditorKeywordChar(text[end])) end++;
        const keyword = text.slice(pos, end).toLowerCase();
        if (previousKeyword === firstKeyword && keyword === secondKeyword) {
            return true;
        }
        previousKeyword = keyword;
        pos = end;
    }
    return false;
};

const sqlEditorStatementContainsDynamicSql = (statement: string, dbType = ''): boolean => (
    sqlEditorStatementContainsKeywordSequence(statement, 'execute', 'immediate', dbType)
    || sqlEditorStatementContainsKeyword(statement, 'sp_executesql', dbType)
    || sqlEditorStatementContainsKeywordSequence(statement, 'execute', 'dynamic', dbType)
);

const isSqlEditorBeginTransactionControlStatement = (statement: string, keywordEnd: number): boolean => {
    const text = String(statement || '');
    const next = skipSqlEditorTrivia(text, keywordEnd);
    if (next >= text.length || text[next] === ';') return true;
    return SQL_EDITOR_BEGIN_TRANSACTION_CONTROL_KEYWORDS.has(readSqlEditorKeyword(text, keywordEnd).keyword);
};

export const isSqlEditorTransactionControlStatement = (statement: string, _dbType = ''): boolean => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    if (leading.keyword === 'begin') {
        return isSqlEditorBeginTransactionControlStatement(text, leading.end);
    }
    if (SQL_EDITOR_TRANSACTION_CONTROL_KEYWORDS.has(leading.keyword)) return true;
    return leading.keyword === 'start' && readSqlEditorKeyword(text, leading.end).keyword === 'transaction';
};

const isSqlEditorManagedBlockWrite = (type: string, statement: string): boolean => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    const normalizedType = String(type || '').trim().toLowerCase();
    const isOracleLike = ['oracle', 'dameng', 'dm', 'dm8'].includes(normalizedType);
    const isSqlServer = ['sqlserver', 'mssql', 'sql_server', 'sql-server'].includes(normalizedType);

    if (isOracleLike) {
        if (leading.keyword !== 'begin' && leading.keyword !== 'declare') return false;
    } else if (isSqlServer) {
        if (leading.keyword !== 'begin' || isSqlEditorBeginTransactionControlStatement(text, leading.end)) return false;
    } else {
        return false;
    }

    return [...SQL_EDITOR_DML_KEYWORDS].some((keyword) => sqlEditorStatementContainsKeyword(text, keyword, normalizedType));
};

type DataSourceCapabilityInput = Parameters<typeof getDataSourceCapabilityContract>[0];

const supportsSqlEditorManagedTransaction = (
    type: string,
    connectionConfig?: DataSourceCapabilityInput,
): boolean => {
    const normalizedType = String(type || '').trim();
    // Statement-only utilities intentionally keep their historical generic SQL
    // behavior. Real query entry points pass their saved connection so custom
    // drivers can use the runtime-probe profile from the shared registry.
    if (!normalizedType) return true;
    return getDataSourceCapabilityContract(connectionConfig ?? { type: normalizedType }).transaction.supported;
};

export const shouldUseSqlEditorManagedTransactionForType = (
    type: string,
    statements: string[],
    connectionConfig?: DataSourceCapabilityInput,
): boolean => {
    if (!supportsSqlEditorManagedTransaction(type, connectionConfig)) {
        return false;
    }
    const normalizedType = String(type || '').trim().toLowerCase();
    let hasManagedWrite = false;
    for (const statement of statements) {
        const trimmed = String(statement || '').trim();
        if (!trimmed) continue;
        if (isSqlEditorTransactionControlStatement(trimmed, normalizedType)) return false;
        if (isSqlEditorManagedBlockWrite(type, trimmed)) {
            hasManagedWrite = true;
            continue;
        }
        if (sqlEditorStatementHasManagedWrite(trimmed, normalizedType)) {
            hasManagedWrite = true;
            continue;
        }
        const keyword = resolveSqlEditorOperationKeyword(trimmed, normalizedType);
        if (SQL_EDITOR_READ_KEYWORDS.has(keyword)) continue;
        return false;
    }
    return hasManagedWrite;
};

export const shouldUseSqlEditorManagedTransaction = (statements: string[]): boolean =>
    shouldUseSqlEditorManagedTransactionForType('', statements);

export const canReusePendingSqlEditorTransactionForType = (
    type: string,
    statements: string[],
    connectionConfig?: DataSourceCapabilityInput,
): boolean => {
    if (!supportsSqlEditorManagedTransaction(type, connectionConfig)) {
        return false;
    }
    const normalizedType = String(type || '').trim().toLowerCase();
    let hasReadStatement = false;
    for (const statement of statements) {
        const trimmed = String(statement || '').trim();
        if (!trimmed) continue;
        if (isSqlEditorTransactionControlStatement(trimmed, normalizedType)) return false;
        if (isSqlEditorManagedBlockWrite(type, trimmed)) return false;
        if (sqlEditorStatementHasManagedWrite(trimmed, normalizedType)) return false;
        const keyword = resolveSqlEditorOperationKeyword(trimmed, normalizedType);
        if (!SQL_EDITOR_READ_KEYWORDS.has(keyword)) return false;
        hasReadStatement = true;
    }
    return hasReadStatement;
};

export const canReusePendingSqlEditorTransaction = (statements: string[]): boolean =>
    canReusePendingSqlEditorTransactionForType('', statements);
