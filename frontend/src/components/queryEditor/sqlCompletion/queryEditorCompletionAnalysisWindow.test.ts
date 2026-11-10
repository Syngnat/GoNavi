import { describe, expect, it, vi } from 'vitest';

import {
    QUERY_EDITOR_COMPLETION_ANALYSIS_PREFIX_CHARS,
    QUERY_EDITOR_COMPLETION_ANALYSIS_SUFFIX_CHARS,
    readQueryEditorCompletionAnalysisText,
} from './queryEditorCompletionAnalysisWindow';

const singleLineOffsetAt = (value: string, position: { lineNumber: number; column: number }) => {
    if (position.lineNumber !== 1) {
        return value.length;
    }
    return Math.max(0, Math.min(value.length, position.column - 1));
};

const createSingleLineModel = (value: string) => {
    const offsetAt = (position: { lineNumber: number; column: number }) => (
        singleLineOffsetAt(value, position)
    );
    const positionAt = (offset: number) => ({
        lineNumber: 1,
        column: Math.max(1, Math.min(value.length, offset) + 1),
    });
    return {
        getValueLength: () => value.length,
        getValue: vi.fn(() => value),
        getOffsetAt: vi.fn(offsetAt),
        getPositionAt: vi.fn(positionAt),
        getValueInRange: vi.fn((range: any) => {
            const start = offsetAt({
                lineNumber: range.startLineNumber,
                column: range.startColumn,
            });
            const end = offsetAt({
                lineNumber: range.endLineNumber,
                column: range.endColumn,
            });
            return value.slice(start, end);
        }),
    };
};

describe('queryEditorCompletionAnalysisWindow', () => {
    it('keeps reading the full document for small SQL', () => {
        const value = 'SELECT 1';
        const model = createSingleLineModel(value);

        const result = readQueryEditorCompletionAnalysisText(model, { lineNumber: 1, column: 7 });

        expect(model.getValue).toHaveBeenCalledTimes(1);
        expect(result.text).toBe(value);
        expect(result.cursorOffset).toBe(6);
    });

    it('reads only a bounded window around the cursor for large SQL', () => {
        const prefix = 'x'.repeat(40_000);
        const suffix = 'y'.repeat(40_000);
        const value = `${prefix}CURSOR${suffix}`;
        const model = createSingleLineModel(value);

        const result = readQueryEditorCompletionAnalysisText(model, {
            lineNumber: 1,
            column: prefix.length + 1,
        });

        expect(model.getValue).not.toHaveBeenCalled();
        expect(result.cursorOffset).toBe(QUERY_EDITOR_COMPLETION_ANALYSIS_PREFIX_CHARS);
        expect(result.text.length).toBe(
            QUERY_EDITOR_COMPLETION_ANALYSIS_PREFIX_CHARS
            + QUERY_EDITOR_COMPLETION_ANALYSIS_SUFFIX_CHARS,
        );
        expect(result.text.slice(result.cursorOffset, result.cursorOffset + 6)).toBe('CURSOR');
    });

    it('falls back to the full document when the model cannot read a range', () => {
        const value = 'x'.repeat(60_000);
        const model = {
            getValueLength: () => value.length,
            getValue: vi.fn(() => value),
        };

        const result = readQueryEditorCompletionAnalysisText(model, { lineNumber: 1, column: 1 });

        expect(model.getValue).toHaveBeenCalledTimes(1);
        expect(result.text).toBe(value);
        expect(result.cursorOffset).toBe(0);
    });

    it('normalizes CRLF before computing the cursor offset', () => {
        const value = 'a\r\nb';
        const model = createSingleLineModel(value);

        const result = readQueryEditorCompletionAnalysisText(model, { lineNumber: 2, column: 2 });

        expect(result.text).toBe('a\nb');
        expect(result.cursorOffset).toBe(3);
    });
});