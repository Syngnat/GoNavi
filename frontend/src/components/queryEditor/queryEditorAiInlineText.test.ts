import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSqlStatementPrefix } = vi.hoisted(() => ({
    resolveSqlStatementPrefix: vi.fn((sql: string, dialect: string) => `${dialect}:${sql}`),
}));

vi.mock('../../utils/sqlStatementSelection', () => ({ resolveSqlStatementPrefix }));

import {
    QUERY_EDITOR_AI_STATEMENT_SCAN_MAX_CHARS,
    clearCurrentStatementPrefixCache,
    getCurrentStatementPrefix,
    hasUnclosedBlockComment,
} from './queryEditorAiInlineText';

describe('getCurrentStatementPrefix', () => {
    beforeEach(() => {
        resolveSqlStatementPrefix.mockClear();
        clearCurrentStatementPrefixCache();
    });

    it('reuses the latest result for the same text and dialect', () => {
        expect(getCurrentStatementPrefix('SELECT 1', 'mysql')).toBe('mysql:SELECT 1');
        expect(getCurrentStatementPrefix('SELECT 1', 'mysql')).toBe('mysql:SELECT 1');
        expect(resolveSqlStatementPrefix).toHaveBeenCalledTimes(1);
    });

    it('rescans when the text changes', () => {
        getCurrentStatementPrefix('SELECT 11', 'mysql');
        getCurrentStatementPrefix('SELECT 12', 'mysql');
        expect(resolveSqlStatementPrefix).toHaveBeenCalledTimes(2);
    });

    it('rescans when the dialect changes', () => {
        getCurrentStatementPrefix('SELECT 3', 'mysql');
        getCurrentStatementPrefix('SELECT 3', 'postgres');
        expect(resolveSqlStatementPrefix).toHaveBeenCalledTimes(2);
    });

    // 同一次 ghost 里既有原始方言也有归一化方言：单槽位缓存会让同一份前缀
    // 被整篇重扫四次。多个槽位必须能同时命中。
    it('keeps one entry per dialect for the same text', () => {
        getCurrentStatementPrefix('SELECT 4', 'mariadb');
        getCurrentStatementPrefix('SELECT 4', 'mysql');
        getCurrentStatementPrefix('SELECT 4', 'mariadb');
        getCurrentStatementPrefix('SELECT 4', 'mysql');
        expect(resolveSqlStatementPrefix).toHaveBeenCalledTimes(2);
    });

    it('never hands the full oversized prefix to the statement scanner', () => {
        const prefix = `${'SELECT 1;\n'.repeat(50_000)}SELECT 2`;
        getCurrentStatementPrefix(prefix, 'mysql');
        const scanned = String(resolveSqlStatementPrefix.mock.calls[0][0]);
        expect(scanned.length).toBeLessThanOrEqual(QUERY_EDITOR_AI_STATEMENT_SCAN_MAX_CHARS);
        expect(scanned.endsWith('SELECT 2')).toBe(true);
    });

    it('scans ordinary documents in full', () => {
        const prefix = 'SELECT 1;\nSELECT 2';
        getCurrentStatementPrefix(prefix, 'mysql');
        expect(resolveSqlStatementPrefix.mock.calls[0][0]).toBe(prefix);
    });
});

describe('hasUnclosedBlockComment', () => {
    it('detects an unclosed block comment', () => {
        expect(hasUnclosedBlockComment('SELECT 1 /* open')).toBe(true);
        expect(hasUnclosedBlockComment('SELECT 1 /* closed */')).toBe(false);
    });

    it('answers repeated calls for the same prefix without rescanning', () => {
        const prefix = `SELECT 1 /* ${'x'.repeat(200_000)}`;
        const lastIndexOf = vi.spyOn(String.prototype, 'lastIndexOf');
        try {
            expect(hasUnclosedBlockComment(prefix)).toBe(true);
            const callsAfterFirst = lastIndexOf.mock.calls.length;
            expect(hasUnclosedBlockComment(prefix)).toBe(true);
            expect(lastIndexOf.mock.calls.length).toBe(callsAfterFirst);
        } finally {
            lastIndexOf.mockRestore();
        }
    });
});
