import { describe, expect, it, vi } from 'vitest';
import { applyParamNameDecorations } from './queryEditorParamsDecorations';

const createEditor = (text: string, length = text.length) => {
    const deltaDecorations = vi.fn((_oldIds: string[], _decorations: unknown[]) => ['id-1']);
    return {
        editor: {
            getModel: () => ({
                getValue: () => text,
                getValueLength: () => length,
                getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
            }),
            deltaDecorations,
        },
        deltaDecorations,
    };
};

const appliedDecorations = (deltaDecorations: ReturnType<typeof createEditor>['deltaDecorations']) => (
    (deltaDecorations.mock.calls[0]?.[1] ?? []) as unknown[]
);

const monaco = {
    Range: class {
        constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
        ) {}
    },
    editor: { TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 } },
} as any;

describe('applyParamNameDecorations', () => {
    it('highlights every occurrence in ordinary SQL', () => {
        const { editor, deltaDecorations } = createEditor('SELECT :a, :b, :a');
        applyParamNameDecorations(editor as any, monaco, ['a', 'b']);
        expect(appliedDecorations(deltaDecorations)).toHaveLength(3);
    });

    it('clears decorations instead of scanning an oversized document', () => {
        const { editor, deltaDecorations } = createEditor(':a', 2_000_000);
        applyParamNameDecorations(editor as any, monaco, ['a']);
        expect(appliedDecorations(deltaDecorations)).toHaveLength(0);
    });

    // deltaDecorations 每条约 0.5–1μs，密集占位符下仅靠长度上限挡不住。
    it('stops instead of installing an unbounded decoration set', () => {
        const text = ':a '.repeat(5_000);
        const { editor, deltaDecorations } = createEditor(text);
        applyParamNameDecorations(editor as any, monaco, ['a']);
        expect(appliedDecorations(deltaDecorations)).toHaveLength(0);
    });
});
