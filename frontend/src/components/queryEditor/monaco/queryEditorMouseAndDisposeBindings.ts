import { message } from 'antd';
import {
    normalizeEditorPosition, isQueryEditorPrimaryMouseButton, hasQueryEditorCtrlMetaModifier,
    normalizeMetadataDialect, resolveQueryEditorNavigationTarget,
    isQueryEditorTableSourceAtPosition, dispatchQueryEditorSidebarLocate,
    clearQueryEditorLinkDecorations, clearQueryEditorObjectDecorations, type CompletionTableMeta,
    type CompletionViewMeta, type CompletionTriggerMeta, type CompletionRoutineMeta,
    type CompletionSequenceMeta, type CompletionPackageMeta, type QueryEditorNavigationTarget,
} from '../QueryEditorHelpers';
import {
    buildQueryEditorTableSourceProbeContext, buildQueryEditorTableTargetKey,
} from '../queryEditorHoverDdl';
import { isConnectionScopedQueryEditorMetadata } from '../queryEditorLazyTablesCache';
import { useStore } from '../../../store';
import { setQueryEditorMouseCursor } from './queryEditorMouseCursor';
import { t as translate } from '../../../i18n';
import { clearAIEditorSelection } from '../queryEditorAiSelection';
import {
    sharedActiveEditorModelUri, setSharedActiveEditorModelUri,
} from '../queryEditorCompletionState';
import type { OnMount } from '../../MonacoEditor';
import type { TabData } from '../../../types';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';
import type { createQueryEditorNavigationHover } from './queryEditorNavigationHover';
import type { createQueryEditorImeAndDropHandlers } from './queryEditorImeAndDropHandlers';

export interface BindQueryEditorMouseAndDisposeInput {
    editor: Parameters<OnMount>[0];
    ctrlMetaPressedRef: React.MutableRefObject<boolean>;
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    currentConnectionIdRef: React.MutableRefObject<string>;
    currentDbRef: React.MutableRefObject<string>;
    visibleDbsRef: React.MutableRefObject<string[]>;
    tablesRef: React.MutableRefObject<CompletionTableMeta[]>;
    viewsRef: React.MutableRefObject<CompletionViewMeta[]>;
    materializedViewsRef: React.MutableRefObject<CompletionViewMeta[]>;
    triggersRef: React.MutableRefObject<CompletionTriggerMeta[]>;
    routinesRef: React.MutableRefObject<CompletionRoutineMeta[]>;
    sequencesRef: React.MutableRefObject<CompletionSequenceMeta[]>;
    packagesRef: React.MutableRefObject<CompletionPackageMeta[]>;
    currentSchemaRef: React.MutableRefObject<string>;
    switchQueryContext: (nextConnectionId: string, nextDbName: string, options?: { persist?: boolean; silentPending?: boolean; }) => boolean;
    addTab: (tab: TabData) => void;
    tab: TabData;
    tableNavigationContextRef: React.MutableRefObject<{ key: string; connectionConfig: unknown; version: number; }>;
    tableNavigationActionInFlightRef: React.MutableRefObject<Record<string, Promise<void> | undefined>>;
    editorRef: React.MutableRefObject<any>;
    validateTableNavigationTarget: (connectionId: string, dbName: string, targetTableName: string, contextVersion: number) => Promise<boolean | null>;
    queryEditorMountedRef: React.MutableRefObject<boolean>;
    queryEditorActiveRef: React.MutableRefObject<boolean>;
    missingTableMetadataKeysRef: React.MutableRefObject<Set<string>>;
    clearMissingTableNavigationMetadata: (connectionId: string, dbName: string, targetTableName: string) => void;
    lastHoverTargetPositionRef: React.MutableRefObject<{ lineNumber: number; column: number; } | null>;
    linkDecorationIdsRef: React.MutableRefObject<string[]>;
    openDefinitionObjectEditTab: (navigationTarget: Extract<QueryEditorNavigationTarget, { type: "view" | "materialized-view" | "sequence" | "package"; }>, connectionId: string, targetDbName: string) => Promise<void>;
    openTriggerObjectEditTab: (navigationTarget: Extract<QueryEditorNavigationTarget, { type: "trigger"; }>, connectionId: string, targetDbName: string) => Promise<void>;
    openRoutineObjectEditTab: (navigationTarget: Extract<QueryEditorNavigationTarget, { type: "routine"; }>, connectionId: string, targetDbName: string) => Promise<void>;
    cancelPendingSqlReferencedMetadataRefresh: () => void;
    cancelPendingObjectDecorationRefresh: () => void;
    objectDecorationIdsRef: React.MutableRefObject<string[]>;
    clearSqlFieldDropPreview: (editor: any) => void;
    objectHoverActionRef: React.MutableRefObject<any>;
    triggerSqlAiCompletionActionRef: React.MutableRefObject<any>;
    macFindWithSelectionGuardActionRef: React.MutableRefObject<any>;
    triggerSqlAiCompletionKeydownDisposableRef: React.MutableRefObject<any>;
    triggerAiInlineCompletionRef: React.MutableRefObject<(() => void) | null>;
    acceptAiInlineCompletionRef: React.MutableRefObject<(() => boolean) | null>;
    acceptSqlAiCompletionKeydownDisposableRef: React.MutableRefObject<any>;
    disposeQueryEditorAiContextMenuActions: () => void;
    disposeSqlExecutionContextMenuActions: () => void;
    disposeTransformCaseContextMenuActions: () => void;
    syncModifierState: ReturnType<typeof createQueryEditorNavigationHover>['syncModifierState'];
    handleWindowBlur: ReturnType<typeof createQueryEditorNavigationHover>['handleWindowBlur'];
    handleSqlFieldDragEnd: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleSqlFieldDragEnd'];
    clearImeCompositionFallbackTimer: ReturnType<typeof createQueryEditorImeAndDropHandlers>['clearImeCompositionFallbackTimer'];
    editorDomNode: ReturnType<typeof createQueryEditorImeAndDropHandlers>['editorDomNode'];
    handleImeBeforeInput: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeBeforeInput'];
    handleImeCompositionStart: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeCompositionStart'];
    handleImeCompositionEnd: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleImeCompositionEnd'];
    handleEditorDragOver: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDragOver'];
    handleEditorDragLeave: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDragLeave'];
    handleEditorDrop: ReturnType<typeof createQueryEditorImeAndDropHandlers>['handleEditorDrop'];
}

export const bindQueryEditorMouseAndDispose = ({
    editor, ctrlMetaPressedRef, connectionsRef, currentConnectionIdRef, currentDbRef, visibleDbsRef,
    tablesRef, viewsRef, materializedViewsRef, triggersRef, routinesRef, sequencesRef, packagesRef,
    currentSchemaRef, switchQueryContext, addTab, tab, tableNavigationContextRef,
    tableNavigationActionInFlightRef, editorRef, validateTableNavigationTarget,
    queryEditorMountedRef, queryEditorActiveRef, missingTableMetadataKeysRef,
    clearMissingTableNavigationMetadata, lastHoverTargetPositionRef, linkDecorationIdsRef,
    openDefinitionObjectEditTab, openTriggerObjectEditTab, openRoutineObjectEditTab,
    cancelPendingSqlReferencedMetadataRefresh, cancelPendingObjectDecorationRefresh,
    objectDecorationIdsRef, clearSqlFieldDropPreview, objectHoverActionRef,
    triggerSqlAiCompletionActionRef, macFindWithSelectionGuardActionRef,
    triggerSqlAiCompletionKeydownDisposableRef, triggerAiInlineCompletionRef,
    acceptAiInlineCompletionRef, acceptSqlAiCompletionKeydownDisposableRef,
    disposeQueryEditorAiContextMenuActions, disposeSqlExecutionContextMenuActions,
    disposeTransformCaseContextMenuActions, syncModifierState, handleWindowBlur,
    handleSqlFieldDragEnd, clearImeCompositionFallbackTimer, editorDomNode, handleImeBeforeInput,
    handleImeCompositionStart, handleImeCompositionEnd, handleEditorDragOver, handleEditorDragLeave,
    handleEditorDrop,
}: BindQueryEditorMouseAndDisposeInput) => {
    editor.onMouseDown?.((event: any) => {
        const browserEvent = event?.event;
        const targetPosition = normalizeEditorPosition(event?.target?.position);
        if (!browserEvent || !targetPosition) {
            return;
        }
        if (!isQueryEditorPrimaryMouseButton(browserEvent)) {
            return;
        }
        if (!hasQueryEditorCtrlMetaModifier(browserEvent) && !ctrlMetaPressedRef.current) {
            return;
        }

        const model = editor.getModel?.();
        const lineContent = String(model?.getLineContent?.(targetPosition.lineNumber) || '');
        const metadataDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        // Ctrl+点击热路径禁止整篇读取模型（大文档性能约束），用光标附近有限行做探针
        const probeContext = buildQueryEditorTableSourceProbeContext(model, targetPosition);
        const navigationTarget = resolveQueryEditorNavigationTarget(
            lineContent,
            targetPosition.column,
            currentDbRef.current,
            visibleDbsRef.current,
            tablesRef.current,
            viewsRef.current,
            materializedViewsRef.current,
            triggersRef.current,
            routinesRef.current,
            sequencesRef.current,
            packagesRef.current,
            isQueryEditorTableSourceAtPosition(
                probeContext.text,
                probeContext.lineNumber,
                targetPosition.column,
                metadataDialect,
            ),
            probeContext.context,
            currentSchemaRef.current,
            metadataDialect,
        );
        if (!navigationTarget) {
            return;
        }

        browserEvent.preventDefault?.();
        browserEvent.stopPropagation?.();

        const connectionId = String(currentConnectionIdRef.current || '').trim();
        if (!connectionId) {
            return;
        }

        if (navigationTarget.type === 'database') {
            const nextDbName = String(navigationTarget.dbName || '').trim();
            if (!nextDbName) {
                return;
            }
            if (!switchQueryContext(connectionId, nextDbName)) {
                return;
            }
            return;
        }

        const targetDbName = String(navigationTarget.dbName || '').trim();
        const targetConnection = connectionsRef.current.find((item) => item.id === connectionId);
        const targetUsesConnectionScope = isConnectionScopedQueryEditorMetadata(targetConnection);
        const targetMetadataDialect = normalizeMetadataDialect(targetConnection);
        if (!targetDbName && !targetUsesConnectionScope) {
            return;
        }

        if (navigationTarget.type === 'table') {
            const targetTableName = String(navigationTarget.tableName || '').trim();
            if (!targetTableName) return;
            const targetLookupTableName = String(
                navigationTarget.lookupTableName || targetTableName,
            ).trim();

            // Keep the existing design-tab behavior as the default, but let
            // the user opt into the faster sidebar locate flow. Read the
            // store at click time because Monaco keeps this listener alive
            // across appearance-setting changes and does not recreate it on
            // every React render.
            const queryTableCtrlClickAction = useStore.getState().appearance.queryTableCtrlClickAction;
            if (queryTableCtrlClickAction === 'locate') {
                dispatchQueryEditorSidebarLocate({
                    connectionId,
                    dbName: targetDbName,
                    tableName: targetTableName,
                    schemaName: navigationTarget.schemaName,
                    objectGroup: 'tables',
                });
                return;
            }

            const openTableTab = () => {
                const targetSchemaName = String(navigationTarget.schemaName || '').trim();
                addTab({
                    id: `${connectionId}-${targetDbName}${targetSchemaName ? `-${targetSchemaName}` : ''}-table-${targetTableName}`,
                    title: targetTableName,
                    type: 'table',
                    connectionId,
                    dbName: targetDbName,
                    tableName: targetTableName,
                    schemaName: targetSchemaName || undefined,
                    initialViewMode: 'fields',
                    initialViewModeRequestId: String(Date.now()),
                    objectType: 'table',
                    returnToTabId: tab.id || undefined,
                });
            };
            const navigationContextVersion = tableNavigationContextRef.current.version;
            const navigationActionKey = [
                buildQueryEditorTableTargetKey(
                    connectionId,
                    targetDbName,
                    targetTableName,
                    targetMetadataDialect,
                ),
                String(navigationTarget.schemaName || '').trim(),
                navigationContextVersion,
            ].join('\u0000');
            if (tableNavigationActionInFlightRef.current[navigationActionKey]) {
                return;
            }
            const isCurrentNavigationEditor = () => {
                if (editorRef.current !== editor) {
                    return false;
                }
                try {
                    return Boolean(editor.getModel?.());
                } catch {
                    return false;
                }
            };
            const navigationAction = (async () => {
                const targetExists = await validateTableNavigationTarget(
                    connectionId,
                    targetDbName,
                    targetLookupTableName,
                    navigationContextVersion,
                );
                if (
                    !queryEditorMountedRef.current
                    || !queryEditorActiveRef.current
                    || String(currentConnectionIdRef.current || '').trim() !== connectionId
                    || tableNavigationContextRef.current.version !== navigationContextVersion
                    || !isCurrentNavigationEditor()
                ) {
                    return;
                }
                if (targetExists === null) {
                    openTableTab();
                    return;
                }
                if (targetExists) {
                    missingTableMetadataKeysRef.current.delete(
                        buildQueryEditorTableTargetKey(
                            connectionId,
                            targetDbName,
                            targetTableName,
                            targetMetadataDialect,
                        ),
                    );
                    openTableTab();
                    return;
                }

                clearMissingTableNavigationMetadata(connectionId, targetDbName, targetTableName);
                lastHoverTargetPositionRef.current = null;
                clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
                editor.updateOptions?.({ mouseStyle: 'text' });
                setQueryEditorMouseCursor(editor, '');
                void message.warning(translate('query_editor.message.table_navigation_target_missing', {
                    table: targetTableName,
                }));
            })();
            tableNavigationActionInFlightRef.current[navigationActionKey] = navigationAction;
            void navigationAction
                .catch((error) => {
                    console.warn('GoNavi table navigation handling failed', error);
                })
                .finally(() => {
                    if (tableNavigationActionInFlightRef.current[navigationActionKey] === navigationAction) {
                        delete tableNavigationActionInFlightRef.current[navigationActionKey];
                    }
                });
            return;
        }

        if (navigationTarget.type === 'view' || navigationTarget.type === 'materialized-view') {
            void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
            return;
        }

        if (navigationTarget.type === 'trigger') {
            void openTriggerObjectEditTab(navigationTarget, connectionId, targetDbName);
            return;
        }

        if (navigationTarget.type === 'sequence') {
            void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
            return;
        }

        if (navigationTarget.type === 'package') {
            void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
            return;
        }

        void openRoutineObjectEditTab(navigationTarget, connectionId, targetDbName);
    });

    editor.onDidDispose?.(() => {
        clearAIEditorSelection(tab.id);
        cancelPendingSqlReferencedMetadataRefresh();
        cancelPendingObjectDecorationRefresh();
        clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
        clearQueryEditorObjectDecorations(editor, objectDecorationIdsRef);
        clearSqlFieldDropPreview(editor);
        setQueryEditorMouseCursor(editor, '');
        objectHoverActionRef.current?.dispose?.();
        objectHoverActionRef.current = null;
        triggerSqlAiCompletionActionRef.current?.dispose?.();
        triggerSqlAiCompletionActionRef.current = null;
        macFindWithSelectionGuardActionRef.current?.dispose?.();
        macFindWithSelectionGuardActionRef.current = null;
        triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
        triggerSqlAiCompletionKeydownDisposableRef.current = null;
        triggerAiInlineCompletionRef.current = null;
        acceptAiInlineCompletionRef.current = null;
        acceptSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
        acceptSqlAiCompletionKeydownDisposableRef.current = null;
        const disposedModelUri = String(editor.getModel?.()?.uri?.toString?.() || '');
        if (disposedModelUri && sharedActiveEditorModelUri === disposedModelUri) {
            setSharedActiveEditorModelUri('');
        }
        disposeQueryEditorAiContextMenuActions();
        disposeSqlExecutionContextMenuActions();
        disposeTransformCaseContextMenuActions();
        window.removeEventListener('keydown', syncModifierState);
        window.removeEventListener('keyup', syncModifierState);
        window.removeEventListener('blur', handleWindowBlur);
        window.removeEventListener('dragend', handleSqlFieldDragEnd);
        window.removeEventListener('drop', handleSqlFieldDragEnd);
        clearImeCompositionFallbackTimer();
        editorDomNode?.removeEventListener('beforeinput', handleImeBeforeInput, true);
        editorDomNode?.removeEventListener('compositionstart', handleImeCompositionStart, true);
        editorDomNode?.removeEventListener('compositionend', handleImeCompositionEnd, true);
        editorDomNode?.removeEventListener('dragover', handleEditorDragOver, true);
        editorDomNode?.removeEventListener('dragleave', handleEditorDragLeave, true);
        editorDomNode?.removeEventListener('drop', handleEditorDrop, true);
    });
};
