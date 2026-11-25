import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection } from '../../../types';
import {
    bindQueryEditorCjkSuggestionRetrigger,
    isCjkDeletionAtTableSource,
} from './queryEditorCjkSuggestionRetrigger';

const connections = [{
    id: 'conn-1',
    name: 'Local',
    config: { type: 'mysql' },
}] as SavedConnection[];

const createEditor = (text: string, suggestVisible = true) => {
    let contentListener: ((event: any) => void) | null = null;
    const triggerSuggest = vi.fn();
    const editor = {
        getContribution: vi.fn(() => ({
            triggerSuggest,
            widget: {
                value: {
                    _ctxSuggestWidgetVisible: {
                        get: () => suggestVisible,
                    },
                },
            },
        })),
        getModel: vi.fn(() => ({
            getLineContent: () => text,
            getValue: () => text,
        })),
        getPosition: vi.fn(() => ({
            lineNumber: 1,
            column: text.length + 1,
        })),
        onDidChangeModelContent: vi.fn((listener: (event: any) => void) => {
            contentListener = listener;
            return { dispose: vi.fn() };
        }),
        trigger: vi.fn(),
    };
    return {
        editor,
        triggerSuggest,
        emitContentChange: (event: any) => contentListener?.(event),
    };
};

describe('query editor CJK suggestion retrigger', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('detects a CJK table-source deletion so Monaco can rebuild filtered candidates', () => {
        const { editor } = createEditor('SELECT * FROM 商品基本');

        expect(isCjkDeletionAtTableSource(
            editor,
            { changes: [{ rangeLength: 1, text: '' }] },
            'mysql',
        )).toBe(true);
        expect(isCjkDeletionAtTableSource(
            editor,
            { changes: [{ rangeLength: 0, text: '信' }] },
            'mysql',
        )).toBe(false);

        const stringLiteral = createEditor("SELECT * FROM users WHERE title = '商品基本信'");
        expect(isCjkDeletionAtTableSource(
            stringLiteral.editor,
            { changes: [{ rangeLength: 1, text: '' }] },
            'mysql',
        )).toBe(false);
    });

    it('retriggers suggestions after backspacing a CJK table-comment fragment', () => {
        vi.useFakeTimers();
        const { editor, triggerSuggest, emitContentChange } = createEditor('SELECT * FROM 商品基本信');
        const dispose = bindQueryEditorCjkSuggestionRetrigger({
            editor,
            editorRef: { current: editor },
            connectionsRef: { current: connections },
            currentConnectionIdRef: { current: 'conn-1' },
        });

        emitContentChange({ changes: [{ rangeLength: 1, text: '' }] });
        vi.runAllTimers();

        expect(triggerSuggest).toHaveBeenCalledTimes(1);
        expect(editor.trigger).not.toHaveBeenCalled();
        dispose();
    });

    it('does not reopen suggestions when the widget is hidden or the edit is outside a table source', () => {
        vi.useFakeTimers();
        const hidden = createEditor('SELECT * FROM 商品基本信', false);
        bindQueryEditorCjkSuggestionRetrigger({
            editor: hidden.editor,
            editorRef: { current: hidden.editor },
            connectionsRef: { current: connections },
            currentConnectionIdRef: { current: 'conn-1' },
        });
        hidden.emitContentChange({ changes: [{ rangeLength: 1, text: '' }] });

        const stringLiteral = createEditor("SELECT * FROM users WHERE title = '商品基本信'");
        bindQueryEditorCjkSuggestionRetrigger({
            editor: stringLiteral.editor,
            editorRef: { current: stringLiteral.editor },
            connectionsRef: { current: connections },
            currentConnectionIdRef: { current: 'conn-1' },
        });
        stringLiteral.emitContentChange({ changes: [{ rangeLength: 1, text: '' }] });
        vi.runAllTimers();

        expect(hidden.triggerSuggest).not.toHaveBeenCalled();
        expect(stringLiteral.triggerSuggest).not.toHaveBeenCalled();
        expect(hidden.editor.trigger).not.toHaveBeenCalled();
        expect(stringLiteral.editor.trigger).not.toHaveBeenCalled();
    });
});
