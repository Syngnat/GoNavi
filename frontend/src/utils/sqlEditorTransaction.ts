import { getDataSourceCapabilityContract } from './dataSourceCapabilities';
import { firstEmbeddedWriteKeyword, hasEmbeddedWriteStatement } from './sqlEmbeddedWrite';
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

/** SET 的作用域关键字：命中这些时影响服务器/账号，不属于「仅当前会话」。 */
const SQL_EDITOR_SERVER_SCOPED_SET_KEYWORDS = new Set([
    'global',
    'persist',
    'persist_only',
    'password',
    'role',
    'default',
    'resource',
]);

/**
 * 会话级 SET 中会改变身份、审计、约束或事务语义的设置。
 * 它们虽然不写业务数据，但不能与 `SET NAMES` 同级静默，仍需保留告警可见性。
 */
const SQL_EDITOR_SENSITIVE_SESSION_SET_KEYWORDS = new Set([
    'authorization',
    'autocommit',
    'sql_log_bin',
    'session_replication_role',
    'foreign_key_checks',
    'unique_checks',
    'sql_mode',
]);

/** 缺分号时可能藏在语句体里的执行类命令，用于会话/维护语句的尾随写守卫。 */
const SQL_EDITOR_EMBEDDED_EXECUTION_KEYWORDS = new Set([
    'call', 'exec', 'execute', 'prepare', 'load', 'merge',
]);

const hasEmbeddedExecutableStatement = (text: string, dbType: string): boolean => {
    if (hasEmbeddedWriteStatement(text, dbType)) return true;
    for (let index = 0; index < text.length;) {
        const skipped = skipSqlEditorQuotedOrComment(text, index, dbType);
        if (skipped !== null) {
            index = skipped;
            continue;
        }
        if (!isSqlEditorKeywordChar(text[index])) {
            index++;
            continue;
        }
        let end = index + 1;
        while (isSqlEditorKeywordChar(text[end])) {
            end++;
        }
        if (SQL_EDITOR_EMBEDDED_EXECUTION_KEYWORDS.has(text.slice(index, end).toLowerCase())) {
            return true;
        }
        index = end;
    }
    return false;
};

const isSqlEditorSensitiveSetTarget = (keyword: string): boolean => (
    SQL_EDITOR_SERVER_SCOPED_SET_KEYWORDS.has(keyword)
    || SQL_EDITOR_SENSITIVE_SESSION_SET_KEYWORDS.has(keyword)
);

/**
 * 语句是否为「会话级、不修改业务数据」的命令（SET / USE）。
 *
 * 用于「写操作未纳入托管事务」提示：`SET SESSION ...`、`SET NAMES ...`、`USE db`
 * 会立即生效且无法回滚，但从不修改业务数据，按写操作告警只会误导。
 * `SET GLOBAL` / `SET PERSIST` / `SET PASSWORD` / `SET ROLE` 等作用域超出当前会话，
 * `SET autocommit` / `SET SESSION AUTHORIZATION` 等会改变身份或事务语义，
 * 均按原逻辑提示，避免放宽不可逆操作的可见性。
 *
 * 安全守卫：缺分号时整段会被切成一条语句（issue #1308），因此只有确认语句体内
 * 没有尾随写/执行命令时才允许排除，避免 `SET @x=1 DELETE FROM t` 被整体放过。
 */
export const isSqlEditorSessionScopedNonDataStatement = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    if (hasEmbeddedExecutableStatement(text, dbType)) return false;
    const keyword = resolveSqlEditorOperationKeyword(text, dbType);
    if (keyword === 'use') return true;
    if (keyword !== 'set') return false;
    const leading = readSqlEditorKeyword(text, 0);
    let pos = skipSqlEditorTrivia(text, leading.end);
    if (text.startsWith('@@', pos)) {
        // `SET @@GLOBAL.x = ...` / `SET @@SESSION.x = ...`
        pos = skipSqlEditorTrivia(text, pos + 2);
        let scope = readSqlEditorKeyword(text, pos);
        if (scope.keyword === 'session' || scope.keyword === 'local') {
            let variablePos = skipSqlEditorTrivia(text, scope.end);
            if (text[variablePos] === '.') {
                variablePos = skipSqlEditorTrivia(text, variablePos + 1);
            }
            scope = readSqlEditorKeyword(text, variablePos);
        }
        return !isSqlEditorSensitiveSetTarget(scope.keyword);
    }
    // 裸 `SET x = ...` / `SET @x = ...` 默认就是会话变量。
    let next = readSqlEditorKeyword(text, pos);
    if (next.keyword === 'session' || next.keyword === 'local') {
        next = readSqlEditorKeyword(text, skipSqlEditorTrivia(text, next.end));
    }
    return !isSqlEditorSensitiveSetTarget(next.keyword);
};

/**
 * 纯统计/物理维护命令：不修改业务数据，也不具备事务回滚语义。
 *
 * 只收录不会改写表内容或持有排他锁的子集；OPTIMIZE / REPAIR / VACUUM FULL /
 * CLUSTER / FLUSH / KILL / LOCK 等仍按高危操作保留告警。
 */
export const isSqlEditorNonDataMaintenanceStatement = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    switch (leading.keyword) {
        case 'update': {
            // SQL Server: UPDATE STATISTICS ...；`UPDATE statistics SET ...`
            // 是名为 statistics 的表上的 DML，不能误判为维护。
            const second = readSqlEditorKeyword(text, leading.end);
            if (second.keyword !== 'statistics') return false;
            return readSqlEditorKeyword(text, second.end).keyword !== 'set';
        }
        case 'cache': {
            return readSqlEditorKeyword(text, leading.end).keyword === 'index';
        }
        case 'load': {
            // `LOAD INDEX INTO CACHE` 是维护；`LOAD DATA ...` 是数据写入。
            return readSqlEditorKeyword(text, leading.end).keyword === 'index';
        }
        case 'vacuum': {
            // VACUUM FULL 会重写表并持排他锁。
            return !/\bfull\b/i.test(text);
        }
        case 'analyze':
        case 'check':
        case 'checksum':
        case 'checkpoint':
            return true;
        default:
            return false;
    }
};

const SQL_EDITOR_POSTGRES_LIKE_TYPES = new Set([
    'postgres', 'postgresql', 'kingbase', 'kingbase8', 'kingbasees', 'kingbasev8',
    'highgo', 'vastbase', 'opengauss', 'open_gauss', 'open-gauss',
    'gaussdb', 'gauss_db', 'gauss-db',
]);

const SQL_EDITOR_SESSION_RESET_TYPES = new Set(['trino', 'presto']);

/**
 * 会话状态复位类命令（PG 的 RESET/DISCARD/PREPARE/DEALLOCATE/LISTEN/UNLISTEN）。
 *
 * MySQL 的 RESET MASTER/REPLICA 属于服务器/复制管理，不在本白名单内；
 * PG 的 `PREPARE TRANSACTION` 是两阶段提交，也不能按普通 PREPARE 排除。
 */
export const isSqlEditorSessionResetStatement = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    const leading = readSqlEditorKeyword(text, 0);
    const normalizedType = String(dbType || '').trim().toLowerCase();
    switch (leading.keyword) {
        case 'discard':
        case 'listen':
        case 'unlisten':
        case 'deallocate':
            return true;
        case 'reset':
            return SQL_EDITOR_POSTGRES_LIKE_TYPES.has(normalizedType)
                || SQL_EDITOR_SESSION_RESET_TYPES.has(normalizedType);
        case 'prepare':
            return readSqlEditorKeyword(text, leading.end).keyword !== 'transaction';
        default:
            return false;
    }
};

/**
 * 不修改业务数据、也不修改 schema 的语句总判定：会话命令、事务控制、
 * 纯统计维护与会话复位。
 *
 * 只用于「未纳入托管事务」告警与侧栏刷新这类降噪场景；
 * 只读保护与生产风险确认必须使用更宽的投影。
 */
export const isSqlEditorNonDataStatement = (statement: string, dbType = ''): boolean => {
    const text = String(statement || '');
    // 缺分号时整段会被切成一条语句（issue #1308）：任何类别都必须先确认语句体内
    // 没有尾随写/执行命令，否则 `COMMIT DELETE FROM t` 会被整体当成事务控制放过。
    // 扫描从首个关键字之后开始，避免把 `UPDATE STATISTICS` 自身的 update 当成内嵌写。
    const leading = readSqlEditorKeyword(text, 0);
    if (hasEmbeddedExecutableStatement(text.slice(leading.end), dbType)) return false;
    return isSqlEditorSessionScopedNonDataStatement(text, dbType)
        || isSqlEditorTransactionControlStatement(text, dbType)
        || isSqlEditorNonDataMaintenanceStatement(text, dbType)
        || isSqlEditorSessionResetStatement(text, dbType);
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
    // 缺分号导致首关键字为读、体内却埋着 DML 时（issue #1308），
    // 只看首关键字会把这批语句判为"不可托管的读"，从而跳过托管事务、
    // 以 autocommit 直接下发，数据库侧再无事务可回滚。
    //
    // 两道门缺一不可：
    // - 首关键字必须是读关键字。内嵌写扫描的关键字集合额外收录了 DDL，
    //   若不加此前置，`CREATE OR REPLACE PROCEDURE` / `DROP TRIGGER` 这类
    //   首关键字本身就是 DDL 的语句会因命中 'create'/'drop' 立刻返回 true，
    //   被误判为"可托管写"而路由到 DBQueryMultiTransactional，绕过失败补偿
    //   恢复逻辑，并与后端 isBatchableWriteSQLStatement（只认 DML）漂移。
    //   这也是 sqlEmbeddedWrite 模块注释声明的调用约束。
    // - 命中关键字必须是 DML。DDL 交给非托管路径，与后端口径一致。
    if (SQL_EDITOR_READ_KEYWORDS.has(leading.keyword)
        && SQL_EDITOR_DML_KEYWORDS.has(firstEmbeddedWriteKeyword(text, dbType))) {
        return true;
    }
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
    // PostgreSQL 的 ABORT 等价 ROLLBACK；MySQL 的 XA START/END/PREPARE/COMMIT/ROLLBACK
    // 是两阶段事务控制，本身同样不写业务数据。
    if (leading.keyword === 'abort' || leading.keyword === 'xa') return true;
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
