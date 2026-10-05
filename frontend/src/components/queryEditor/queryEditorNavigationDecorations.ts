import { t as translate } from '../../i18n';
import type {
    CompletionTableMeta,
    CompletionViewMeta,
    CompletionTriggerMeta,
    CompletionRoutineMeta,
    CompletionSequenceMeta,
    CompletionPackageMeta,
} from './queryEditorCompletionCandidates';
import type { QueryEditorTableCtrlClickAction } from './queryEditorIdentifierPaths';
import { findIdentifierWindowAtOffset } from './queryEditorSqlScan';
import { resolveQueryEditorNavigationTarget } from './queryEditorNavigationTarget';

export const resolveQueryEditorNavigationDecorations = (
    lineContent: string,
    column: number,
    currentDb: string,
    visibleDbs: string[],
    tables: CompletionTableMeta[],
    views: CompletionViewMeta[] = [],
    materializedViews: CompletionViewMeta[] = [],
    triggers: CompletionTriggerMeta[] = [],
    routines: CompletionRoutineMeta[] = [],
    sequences: CompletionSequenceMeta[] = [],
    packages: CompletionPackageMeta[] = [],
    shortcutModifierLabel = 'Ctrl/Cmd',
    tableSourceContext = false,
    documentContext?: { text: string; offset: number },
    currentSchema = '',
    tableCtrlClickActionOrDialect: QueryEditorTableCtrlClickAction | string = 'open-design',
    dialectOrTableCtrlClickAction: QueryEditorTableCtrlClickAction | string = '',
): Array<{ startColumn: number; endColumn: number; hoverMessage: string }> => {
    const isTableCtrlClickAction = (value: string): value is QueryEditorTableCtrlClickAction => (
        value === 'open-design' || value === 'locate'
    );
    const firstOptionalArgument = String(tableCtrlClickActionOrDialect || '').trim();
    const secondOptionalArgument = String(dialectOrTableCtrlClickAction || '').trim();
    // Keep both pre-merge call shapes working: this PR previously passed the
    // dialect immediately after currentSchema, while dev added the click action
    // in that position.
    const tableCtrlClickAction = isTableCtrlClickAction(firstOptionalArgument)
        ? firstOptionalArgument
        : isTableCtrlClickAction(secondOptionalArgument)
            ? secondOptionalArgument
            : 'open-design';
    const dialect = isTableCtrlClickAction(firstOptionalArgument)
        ? secondOptionalArgument
        : firstOptionalArgument;
    const text = String(lineContent || '');
    if (!text) return [];
    const offset = Math.max(0, Number(column || 1) - 2);
    const windowRange = findIdentifierWindowAtOffset(text, offset, true, dialect);
    if (!windowRange) return [];

    const navigationTarget = resolveQueryEditorNavigationTarget(
        lineContent,
        column,
        currentDb,
        visibleDbs,
        tables,
        views,
        materializedViews,
        triggers,
        routines,
        sequences,
        packages,
        tableSourceContext,
        documentContext,
        currentSchema,
        dialect,
    );
    if (!navigationTarget) return [];

    const hoverMessage = (() => {
        if (navigationTarget.type === 'database') {
            return translate('query_editor.hover.switch_database_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        if (navigationTarget.type === 'table') {
            return translate(
                tableCtrlClickAction === 'locate'
                    ? 'query_editor.hover.locate_table_with_shortcut'
                    : 'query_editor.hover.open_table_with_shortcut',
                {
                    shortcut: shortcutModifierLabel,
                },
            );
        }
        if (navigationTarget.type === 'view') {
            return translate('query_editor.hover.open_view_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        if (navigationTarget.type === 'materialized-view') {
            return translate('query_editor.hover.open_materialized_view_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        if (navigationTarget.type === 'trigger') {
            return translate('query_editor.hover.open_trigger_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        if (navigationTarget.type === 'sequence') {
            return translate('query_editor.hover.open_sequence_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        if (navigationTarget.type === 'package') {
            return translate('query_editor.hover.open_package_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
        }
        return navigationTarget.routineType === 'PROCEDURE'
            ? translate('query_editor.hover.open_procedure_with_shortcut', {
                shortcut: shortcutModifierLabel,
            })
            : translate('query_editor.hover.open_function_with_shortcut', {
                shortcut: shortcutModifierLabel,
            });
    })();

    return [{
        startColumn: windowRange.start + 1,
        endColumn: windowRange.end + 1,
        hoverMessage,
    }];
};

export const resolveNextQueryEditorTableLocateIndex = (
    previous: { lineNumber: number; signature: string; index: number } | null | undefined,
    lineNumber: number,
    signature: string,
    count: number,
): number => {
    if (count <= 0) return 0;
    return previous
        && previous.lineNumber === lineNumber
        && previous.signature === signature
        ? (previous.index + 1) % count
        : 0;
};

export const dispatchQueryEditorSidebarLocate = (detail: Record<string, unknown>) => {
    if (typeof window === 'undefined') {
        return;
    }
    const connectionId = String(detail.connectionId || '').trim();
    const dbName = String(detail.dbName || '').trim();
    const objectName = String(detail.tableName || detail.viewName || detail.triggerName || detail.routineName || detail.objectName || '').trim();
    if ((!connectionId || !dbName || !objectName) && !String(detail.savedQueryId || '').trim()) {
        return;
    }
    window.dispatchEvent(new CustomEvent('gonavi:locate-sidebar-object', {
        detail,
    }));
};

export const resolveEventTargetNode = (target: EventTarget | null): Node | null => (
    typeof Node !== 'undefined' && target instanceof Node ? target : null
);

export const isDocumentLevelShortcutTarget = (targetNode: Node | null): boolean => {
    if (!targetNode) {
        return true;
    }
    if (typeof document === 'undefined') {
        return false;
    }
    return targetNode === document.body || targetNode === document.documentElement;
};

export const shouldHandleQueryEditorRunShortcutFallback = ({
    editorHasFocus,
    targetNode,
    editorPane,
}: {
    editorHasFocus: boolean;
    targetNode: Node | null;
    editorPane?: Pick<Node, 'contains'> | null;
}): boolean => {
    if (!editorHasFocus) {
        return false;
    }
    if (targetNode && editorPane?.contains(targetNode)) {
        return false;
    }
    return isDocumentLevelShortcutTarget(targetNode);
};

export const clearQueryEditorLinkDecorations = (
    editor: any,
    decorationIdsRef: React.MutableRefObject<string[]>,
) => {
    if (!editor?.deltaDecorations) {
        decorationIdsRef.current = [];
        return;
    }
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
};

export const clearQueryEditorObjectDecorations = (
    editor: any,
    decorationIdsRef: React.MutableRefObject<string[]>,
) => {
    if (!editor?.deltaDecorations) {
        decorationIdsRef.current = [];
        return;
    }
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
};
