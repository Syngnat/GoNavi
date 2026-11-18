import { resolveSqlStatementPrefix } from '../../utils/sqlStatementSelection';
import { MAX_INLINE_INSERT_CHARS } from './queryEditorAiAssistTypes';

type QueryEditorStatementPrefixCacheEntry = {
    prefix: string;
    sqlDialect: string;
    value: string;
};

// 单条缓存会被「原始方言」与「归一化方言」交替请求打穿：同一次 ghost 里
// 两者都会出现，单槽位导致同一份前缀被整篇重扫四次。保留最近几条、
// 以完全相同的 (prefix, dialect) 谓词匹配，计算结果与不做缓存完全一致。
const STATEMENT_PREFIX_CACHE_MAX_ENTRIES = 3;

// 语句扫描的文本上限。10MB 前缀上跑一次 findSqlStatementRanges 实测约
// 260–360ms，而「当前语句」几乎总在光标附近。超过该长度时只取行对齐的
// 尾部窗口扫描：正常 SQL 完全走原路径，结果逐字节一致；只有超过 64KiB
// 的超长语句会被截断起点，这与 resolveBoundedSqlStatementContext 的既有
// 取舍一致。
export const QUERY_EDITOR_AI_STATEMENT_SCAN_MAX_CHARS = 64 * 1024;

const statementScanText = (source: string): string => {
    if (source.length <= QUERY_EDITOR_AI_STATEMENT_SCAN_MAX_CHARS) {
        return source;
    }
    let start = source.length - QUERY_EDITOR_AI_STATEMENT_SCAN_MAX_CHARS;
    const nextBreak = source.indexOf('\n', start);
    if (nextBreak >= 0 && nextBreak + 1 < source.length) {
        start = nextBreak + 1;
    }
    return source.slice(start);
};

const statementPrefixCache: QueryEditorStatementPrefixCacheEntry[] = [];

export const clearCurrentStatementPrefixCache = (): void => {
    statementPrefixCache.length = 0;
};

export const getCurrentStatementPrefix = (prefix: string, sqlDialect = ''): string => {
    // 缓存键用「实际参与扫描的文本」，因此单条条目最多钉住 64KiB，
    // 而不是整篇文档。
    const source = statementScanText(String(prefix ?? ''));
    const dialect = String(sqlDialect ?? '');
    for (let index = statementPrefixCache.length - 1; index >= 0; index -= 1) {
        const cached = statementPrefixCache[index];
        if (cached.prefix === source && cached.sqlDialect === dialect) {
            return cached.value;
        }
    }
    const value = resolveSqlStatementPrefix(source, dialect);
    statementPrefixCache.push({ prefix: source, sqlDialect: dialect, value });
    if (statementPrefixCache.length > STATEMENT_PREFIX_CACHE_MAX_ENTRIES) {
        statementPrefixCache.shift();
    }
    return value;
};

type UnclosedBlockCommentCacheEntry = { text: string; value: boolean };
let unclosedBlockCommentCache: UnclosedBlockCommentCacheEntry | null = null;

// 同一次 ghost 里同一个前缀会被问 4 次（memory 门控、recheck、request、
// local）。单条缓存把这 4 次全文 lastIndexOf 扫描降到 1 次，结果完全相同。
export const hasUnclosedBlockComment = (text: string): boolean => {
    const source = String(text || '');
    const cached = unclosedBlockCommentCache;
    if (cached && cached.text === source) {
        return cached.value;
    }
    const value = source.lastIndexOf('/*') > source.lastIndexOf('*/');
    unclosedBlockCommentCache = { text: source, value };
    return value;
};

export const hasUnclosedSqlString = (text: string): boolean => {
    let singleOpen = false;
    let doubleOpen = false;
    let backtickOpen = false;
    const value = String(text || '');
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const next = value[index + 1];
        if (char === "'" && !doubleOpen && !backtickOpen) {
            if (next === "'") {
                index += 1;
            } else {
                singleOpen = !singleOpen;
            }
        } else if (char === '"' && !singleOpen && !backtickOpen) {
            doubleOpen = !doubleOpen;
        } else if (char === '`' && !singleOpen && !doubleOpen) {
            backtickOpen = !backtickOpen;
        }
    }
    return singleOpen || doubleOpen || backtickOpen;
};

export const findCaseInsensitiveOverlap = (prefix: string, completion: string): number => {
    const left = String(prefix || '');
    const right = String(completion || '');
    const max = Math.min(left.length, right.length);
    const leftLower = left.toLowerCase();
    const rightLower = right.toLowerCase();
    for (let length = max; length > 0; length -= 1) {
        if (leftLower.slice(left.length - length) === rightLower.slice(0, length)) {
            return length;
        }
    }
    return 0;
};

export const truncateHead = (text: string, limit: number): string => {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return value.slice(value.length - limit);
};

export const truncateTail = (text: string, limit: number): string => {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return value.slice(0, limit);
};

export const limitInlineInsertText = (text: string): string => {
    const value = String(text || '').trimEnd();
    if (value.length <= MAX_INLINE_INSERT_CHARS) {
        return value;
    }
    const truncated = value.slice(0, MAX_INLINE_INSERT_CHARS);
    const lastStatementEnd = Math.max(truncated.lastIndexOf(';'), truncated.lastIndexOf('\n'));
    return (lastStatementEnd > 80 ? truncated.slice(0, lastStatementEnd + 1) : truncated).trimEnd();
};
