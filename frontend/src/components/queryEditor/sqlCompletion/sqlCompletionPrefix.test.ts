import { describe, expect, it } from 'vitest';

import { resolveSqlCompletionWord } from './sqlCompletionPrefix';

const model = (line: string, word = '', startColumn = 0, endColumn = 0) => ({
    getLineContent: () => line,
    getWordUntilPosition: () => ({ word, startColumn, endColumn }),
});

describe('resolveSqlCompletionWord', () => {
    it('covers a CJK table-comment fragment when Monaco returns an empty word', () => {
        const line = 'SELECT * FROM 认证';
        expect(resolveSqlCompletionWord(model(line), { lineNumber: 1, column: line.length + 1 })).toEqual({
            word: '认证',
            startColumn: line.length - 1,
            endColumn: line.length + 1,
        });
    });

    it('keeps Monaco ASCII ranges when they already cover the word', () => {
        expect(resolveSqlCompletionWord(
            model('SELECT * FROM auth', 'auth', 15, 19),
            { lineNumber: 1, column: 19 },
        )).toEqual({ word: 'auth', startColumn: 15, endColumn: 19 });
    });

    it('includes a mixed CJK/ASCII fragment so accepting the item replaces all of it', () => {
        const line = 'SELECT * FROM 订单abc';
        expect(resolveSqlCompletionWord(model(line, 'abc', 18, 21), { lineNumber: 1, column: line.length + 1 })).toEqual({
            word: '订单abc',
            startColumn: line.length - 4,
            endColumn: line.length + 1,
        });
    });

    it('keeps a wider Monaco range when the trailing token is only its CJK suffix', () => {
        const line = 'SELECT * FROM abc-认证';
        expect(resolveSqlCompletionWord(model(line, 'abc-认证', 15, line.length + 1), {
            lineNumber: 1,
            column: line.length + 1,
        })).toEqual({
            word: 'abc-认证',
            startColumn: 15,
            endColumn: line.length + 1,
        });
    });
});
