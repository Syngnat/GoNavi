import { describe, expect, it, vi } from 'vitest';

import { QUERY_EDITOR_HOVER_DELAY_MS } from './QueryEditorHelpers';
import {
    applyQueryEditorAutomaticLayout,
    buildQueryEditorMonacoActionLabel,
    buildQueryEditorMonacoOptions,
    collectQueryEditorSplitLayoutObserveTargets,
    installQueryEditorFindWidgetOverflowClass,
    QUERY_EDITOR_FIND_CONTROLLER_ID,
    QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
    QUERY_EDITOR_QUICK_SUGGESTIONS_DELAY_MS,
    setQueryEditorMouseCursor,
    syncQueryEditorFindWidgetVisibleClass,
} from './queryEditorMonacoLayout';

describe('query editor monaco layout', () => {
    it('keeps completion and hover enabled while gating automaticLayout to the visible tab', () => {
        const hidden = buildQueryEditorMonacoOptions(false, false, false);
        const visible = buildQueryEditorMonacoOptions(false, true, true);

        expect(hidden).toMatchObject({
            automaticLayout: false,
            quickSuggestions: { other: true, comments: false, strings: false },
            quickSuggestionsDelay: QUERY_EDITOR_QUICK_SUGGESTIONS_DELAY_MS,
            suggestOnTriggerCharacters: true,
            hover: { enabled: true, delay: QUERY_EDITOR_HOVER_DELAY_MS, above: false },
            wordBasedSuggestions: 'off',
            occurrencesHighlight: 'off',
            wordWrap: 'off',
        });
        expect(visible).toMatchObject({
            automaticLayout: true,
            wordWrap: 'on',
            inlineSuggest: expect.objectContaining({ enabled: true }),
        });
    });

    it('only observes the outer workbench root so editor-height updates cannot loop through ResizeObserver', () => {
        const root = { id: 'root' };
        const pane = { id: 'pane' };

        expect(collectQueryEditorSplitLayoutObserveTargets(root, pane)).toEqual([root]);
        expect(collectQueryEditorSplitLayoutObserveTargets(null, pane)).toEqual([]);
    });

    it('toggles find-widget overflow with a stage class instead of scanning the Monaco subtree', () => {
        const stage = { classList: { toggle: vi.fn() } };

        syncQueryEditorFindWidgetVisibleClass(stage, true);
        syncQueryEditorFindWidgetVisibleClass(stage, false);

        expect(stage.classList.toggle).toHaveBeenNthCalledWith(
            1,
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            true,
        );
        expect(stage.classList.toggle).toHaveBeenNthCalledWith(
            2,
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            false,
        );
    });

    it('ignores Monaco contributions that do not expose find state', () => {
        const stage = { classList: { toggle: vi.fn() } };
        const editor = {
            getContribution: vi.fn(() => ({ dispose: vi.fn() })),
        };

        const dispose = installQueryEditorFindWidgetOverflowClass(editor, () => stage);
        dispose();

        expect(stage.classList.toggle).toHaveBeenCalledTimes(1);
        expect(stage.classList.toggle).toHaveBeenCalledWith(
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            false,
        );
    });

    it('syncs the find-widget class from Monaco find state and clears it on dispose', () => {
        const listeners: Array<(event: { isRevealed?: boolean }) => void> = [];
        const findState = {
            isRevealed: false,
            onFindReplaceStateChange: vi.fn((listener: (event: { isRevealed?: boolean }) => void) => {
                listeners.push(listener);
                return { dispose: vi.fn() };
            }),
        };
        const stage = { classList: { toggle: vi.fn() } };
        const editor = {
            getContribution: vi.fn((id: string) => (
                id === QUERY_EDITOR_FIND_CONTROLLER_ID ? { getState: () => findState } : null
            )),
        };

        const dispose = installQueryEditorFindWidgetOverflowClass(editor, () => stage);

        expect(stage.classList.toggle).toHaveBeenCalledWith(
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            false,
        );

        findState.isRevealed = true;
        listeners[0]?.({ isRevealed: true });
        expect(stage.classList.toggle).toHaveBeenCalledWith(
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            true,
        );

        dispose();
        expect(findState.onFindReplaceStateChange.mock.results[0]?.value.dispose).toHaveBeenCalledTimes(1);
        expect(stage.classList.toggle).toHaveBeenLastCalledWith(
            QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS,
            false,
        );
    });

    it('turns automaticLayout off for hidden editors and layouts when they become visible', () => {
        const editor = {
            updateOptions: vi.fn(),
            layout: vi.fn(),
        };

        applyQueryEditorAutomaticLayout(editor, false);
        expect(editor.updateOptions).toHaveBeenCalledWith({ automaticLayout: false });
        expect(editor.layout).not.toHaveBeenCalled();

        applyQueryEditorAutomaticLayout(editor, true);
        expect(editor.updateOptions).toHaveBeenCalledWith({ automaticLayout: true });
        expect(editor.layout).toHaveBeenCalledTimes(1);
    });

    it('prefixes Monaco action labels with the product name', () => {
        expect(buildQueryEditorMonacoActionLabel('query_editor.action.find_in_editor')).toContain('GoNavi:');
    });

    it('writes the editor mouse cursor onto the DOM node', () => {
        const style: { cursor?: string } = {};
        setQueryEditorMouseCursor({ getDomNode: () => ({ style }) }, 'pointer');
        expect(style.cursor).toBe('pointer');
        setQueryEditorMouseCursor({ getDomNode: () => ({ style }) }, '');
        expect(style.cursor).toBe('');
    });
});
