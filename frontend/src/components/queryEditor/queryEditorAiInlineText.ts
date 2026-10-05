import { resolveSqlStatementPrefix } from '../../utils/sqlStatementSelection';
import { MAX_INLINE_INSERT_CHARS } from './queryEditorAiAssistTypes';

export const getCurrentStatementPrefix = (prefix: string, sqlDialect = ''): string => (
    resolveSqlStatementPrefix(prefix, sqlDialect)
);

export const hasUnclosedBlockComment = (text: string): boolean =>
    String(text || '').lastIndexOf('/*') > String(text || '').lastIndexOf('*/');

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
