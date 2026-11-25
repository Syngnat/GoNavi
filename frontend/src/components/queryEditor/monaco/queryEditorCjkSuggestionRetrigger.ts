import type { SavedConnection } from '../../../types';
import {
    isQueryEditorTableSourceAtPosition,
    normalizeMetadataDialect,
} from '../QueryEditorHelpers';

type EditorPosition = {
    lineNumber: number;
    column: number;
};

type EditorModelLike = {
    getLineContent?: (lineNumber: number) => string;
    getValue?: () => string;
};

type EditorContentChange = {
    rangeLength?: number;
    text?: string;
};

type EditorContentChangeEvent = {
    changes?: EditorContentChange[];
};

type EditorLike = {
    getContribution?: (id: string) => unknown;
    getModel?: () => EditorModelLike | null;
    getPosition?: () => EditorPosition | null;
    onDidChangeModelContent?: (
        listener: (event: EditorContentChangeEvent) => void,
    ) => { dispose?: () => void } | void;
    trigger?: (source: string, command: string, args: unknown) => void;
};

type SuggestControllerLike = {
    triggerSuggest?: (onlyFrom?: Set<unknown>, auto?: boolean, noFilter?: boolean) => void;
    widget?: {
        value?: {
            _ctxSuggestWidgetVisible?: {
                get?: () => boolean;
            };
        };
    };
};

type BindQueryEditorCjkSuggestionRetriggerInput = {
    editor: EditorLike;
    editorRef: { current: EditorLike | null };
    connectionsRef: { current: SavedConnection[] };
    currentConnectionIdRef: { current: string };
};

const CJK_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_CHARACTER_GLOBAL_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

const normalizeCjkIdentifiersForSourceDetection = (text: string): string => (
    text.replace(CJK_CHARACTER_GLOBAL_PATTERN, 'x')
);

export const isCjkDeletionAtTableSource = (
    editor: EditorLike,
    event: EditorContentChangeEvent,
    dialect: string,
): boolean => {
    const changes = Array.isArray(event?.changes) ? event.changes : [];
    const hasDeletion = changes.some((change) => (
        Number(change?.rangeLength) > 0 && String(change?.text || '') === ''
    ));
    if (!hasDeletion) return false;

    const model = editor.getModel?.();
    const position = editor.getPosition?.();
    if (!model || !position) return false;

    const line = String(model.getLineContent?.(position.lineNumber) || '');
    const prefix = line.slice(0, Math.max(0, Number(position.column) - 1));
    if (!CJK_CHARACTER_PATTERN.test(prefix.slice(-1))) return false;

    return isQueryEditorTableSourceAtPosition(
        normalizeCjkIdentifiersForSourceDetection(String(model.getValue?.() || '')),
        position.lineNumber,
        position.column,
        dialect,
    );
};

export const bindQueryEditorCjkSuggestionRetrigger = ({
    editor,
    editorRef,
    connectionsRef,
    currentConnectionIdRef,
}: BindQueryEditorCjkSuggestionRetriggerInput) => {
    // Monaco 只在光标右移时重跑 incomplete provider；回删中文注释片段仍会
    // 沿用旧候选做本地过滤，于是停在“无建议”。这里在补全层可见时显式重取。
    let retriggerTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetrigger = (suggestController: SuggestControllerLike) => {
        if (retriggerTimer !== null) {
            clearTimeout(retriggerTimer);
        }
        retriggerTimer = setTimeout(() => {
            retriggerTimer = null;
            if (editorRef.current !== editor) return;
            if (typeof suggestController.triggerSuggest === 'function') {
                suggestController.triggerSuggest();
                return;
            }
            editor.trigger?.('gonavi-cjk-comment-suggestion', 'editor.action.triggerSuggest', undefined);
        }, 0);
    };

    const disposable = editor.onDidChangeModelContent?.((event) => {
        const suggestController = editor.getContribution?.(
            'editor.contrib.suggestController',
        ) as SuggestControllerLike | null;
        if (!suggestController?.widget?.value?._ctxSuggestWidgetVisible?.get?.()) {
            return;
        }

        const connection = connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        );
        if (!isCjkDeletionAtTableSource(
            editor,
            event,
            normalizeMetadataDialect(connection),
        )) {
            return;
        }
        scheduleRetrigger(suggestController);
    });

    return () => {
        if (retriggerTimer !== null) {
            clearTimeout(retriggerTimer);
            retriggerTimer = null;
        }
        disposable?.dispose?.();
    };
};
