import { t as translate } from '../../i18n';
import { QUERY_EDITOR_HOVER_DELAY_MS } from './QueryEditorHelpers';
import { buildQueryEditorAiInlineSuggestOptions } from './QueryEditorAiAssist';

export const QUERY_EDITOR_TABLE_SUGGESTION_ROW_HEIGHT = 36;
export const QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS = 'is-find-widget-visible';
export const QUERY_EDITOR_FIND_CONTROLLER_ID = 'editor.contrib.findController';
export const QUERY_EDITOR_QUICK_SUGGESTIONS_DELAY_MS = 250;

type QueryEditorFindReplaceState = {
    isRevealed?: boolean;
    onFindReplaceStateChange?: (
        listener: (event: { isRevealed?: boolean }) => void,
    ) => { dispose?: () => void } | void;
};

type QueryEditorClassListHost = {
    classList?: {
        toggle?: (token: string, force?: boolean) => void;
    };
};

type QueryEditorContributionHost = {
    getContribution?: (id: string) => unknown;
};

const readQueryEditorFindReplaceState = (contribution: unknown): QueryEditorFindReplaceState | null => {
    if (!contribution || typeof contribution !== 'object') {
        return null;
    }
    const getState = (contribution as { getState?: unknown }).getState;
    if (typeof getState !== 'function') {
        return null;
    }
    const state = getState.call(contribution);
    if (!state || typeof state !== 'object') {
        return null;
    }
    return state as QueryEditorFindReplaceState;
};

export const buildQueryEditorMonacoOptions = (
    isObjectEditQueryTab: boolean,
    wordWrapEnabled = false,
    automaticLayout = true,
) => ({
    minimap: { enabled: false },
    automaticLayout: Boolean(automaticLayout),
    fixedOverflowWidgets: true,
    wordWrap: wordWrapEnabled ? ('on' as const) : ('off' as const),
    // Keep the find widget as an overlay; Monaco's default top spacer creates a blank band.
    find: {
        addExtraSpaceOnTop: false,
    },
    hover: {
        enabled: true,
        delay: QUERY_EDITOR_HOVER_DELAY_MS,
        above: false,
    },
    scrollBeyondLastLine: false,
    quickSuggestions: { other: true, comments: false, strings: false },
    quickSuggestionsDelay: QUERY_EDITOR_QUICK_SUGGESTIONS_DELAY_MS,
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: 'off' as const,
    occurrencesHighlight: 'off' as const,
    suggestLineHeight: QUERY_EDITOR_TABLE_SUGGESTION_ROW_HEIGHT,
    inlineSuggest: buildQueryEditorAiInlineSuggestOptions(),
    ...(isObjectEditQueryTab
        ? {
            lineNumbersMinChars: 4,
            stickyScroll: { enabled: false },
        }
        : {}),
});

export const collectQueryEditorSplitLayoutObserveTargets = <T,>(
    root: T | null | undefined,
    _pane?: unknown,
): T[] => (root ? [root] : []);

export const syncQueryEditorFindWidgetVisibleClass = (
    stage: QueryEditorClassListHost | null | undefined,
    visible: boolean,
): void => {
    stage?.classList?.toggle?.(QUERY_EDITOR_FIND_WIDGET_VISIBLE_CLASS, Boolean(visible));
};

export const installQueryEditorFindWidgetOverflowClass = (
    editor: QueryEditorContributionHost | null | undefined,
    getStage: () => QueryEditorClassListHost | null | undefined,
): (() => void) => {
    const findState = readQueryEditorFindReplaceState(
        editor?.getContribution?.(QUERY_EDITOR_FIND_CONTROLLER_ID),
    );
    const clear = () => {
        syncQueryEditorFindWidgetVisibleClass(getStage(), false);
    };
    if (!findState || typeof findState.onFindReplaceStateChange !== 'function') {
        return clear;
    }

    const sync = () => {
        syncQueryEditorFindWidgetVisibleClass(getStage(), Boolean(findState.isRevealed));
    };
    sync();
    const disposable = findState.onFindReplaceStateChange((event) => {
        if (event?.isRevealed) {
            sync();
        }
    });
    return () => {
        disposable?.dispose?.();
        clear();
    };
};

export const applyQueryEditorAutomaticLayout = (
    editor: {
        updateOptions?: (options: { automaticLayout: boolean }) => void;
        layout?: () => void;
    } | null | undefined,
    isActive: boolean,
): void => {
    if (!editor) {
        return;
    }
    editor.updateOptions?.({ automaticLayout: Boolean(isActive) });
    if (isActive) {
        editor.layout?.();
    }
};

export const buildQueryEditorMonacoActionLabel = (key: string): string => (
    `GoNavi: ${translate(key)}`
);

export const setQueryEditorMouseCursor = (
    editor: { getDomNode?: () => { style?: { cursor?: string } } | null } | null | undefined,
    cursor: '' | 'pointer',
): void => {
    const domNode = editor?.getDomNode?.();
    if (domNode?.style) {
        domNode.style.cursor = cursor;
    }
};
