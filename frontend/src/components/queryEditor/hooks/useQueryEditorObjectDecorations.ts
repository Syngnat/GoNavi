import { useCallback, useEffect } from 'react';
import { message } from 'antd';
import {
    QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
    getQueryEditorDecorationModelTextIfLightweight,
    normalizeMetadataDialect,
    collectQueryEditorObjectDecorationCandidates,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS,
    buildQueryEditorAliasMap,
    resolveQueryEditorHoverTarget,
    isQueryEditorTableSourceAtPosition,
    QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
    getQueryEditorModelValueLength,
    clearQueryEditorObjectDecorations,
    normalizeEditorPosition,
} from '../QueryEditorHelpers';
import {
    buildQueryEditorDecorationProbeContext,
    buildQueryEditorTableTargetKey,
    buildQueryEditorObjectResolveContext,
} from '../queryEditorHoverDdl';
import { DBTableExists } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    QUERY_EDITOR_TABLE_NAVIGATION_VALIDATION_TIMEOUT_MS,
    invalidateSharedLazyTablesCache,
    mirrorColumnsCacheIntoBoundedCache,
} from '../queryEditorLazyTablesCache';
import {
    setSharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataGeneration,
    setSharedTablesData,
    setSharedAllColumnsData,
} from '../queryEditorCompletionState';
import {
    buildQueryEditorMetadataIdentityKey,
    isExactQueryEditorTableName,
} from '../queryEditorCompletionTables';
import { buildQueryEditorMonacoActionLabel } from '../queryEditorRunHelpers';
import { t as translate } from '../../../i18n';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorObjectDecorationsInput {
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
    objectDecorationIdsRef: QueryEditorCoreStateApi['objectDecorationIdsRef'];
    objectDecorationsDirtyRef: QueryEditorCoreStateApi['objectDecorationsDirtyRef'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    viewsRef: QueryEditorCoreStateApi['viewsRef'];
    materializedViewsRef: QueryEditorCoreStateApi['materializedViewsRef'];
    triggersRef: QueryEditorCoreStateApi['triggersRef'];
    routinesRef: QueryEditorCoreStateApi['routinesRef'];
    sequencesRef: QueryEditorCoreStateApi['sequencesRef'];
    packagesRef: QueryEditorCoreStateApi['packagesRef'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    allColumnsRef: QueryEditorCoreStateApi['allColumnsRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    objectDecorationRefreshSeqRef: QueryEditorCoreStateApi['objectDecorationRefreshSeqRef'];
    objectDecorationIdleCallbackRef: QueryEditorCoreStateApi['objectDecorationIdleCallbackRef'];
    objectDecorationFallbackTimerRef: QueryEditorCoreStateApi['objectDecorationFallbackTimerRef'];
    sqlReferencedMetadataTimerRef: QueryEditorCoreStateApi['sqlReferencedMetadataTimerRef'];
    queryEditorMountedRef: QueryEditorCoreStateApi['queryEditorMountedRef'];
    queryEditorActiveRef: QueryEditorCoreStateApi['queryEditorActiveRef'];
    lastLocalQueryRef: QueryEditorCoreStateApi['lastLocalQueryRef'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    tableNavigationValidationInFlightRef: QueryEditorCoreStateApi['tableNavigationValidationInFlightRef'];
    tableNavigationContextRef: QueryEditorConnectionContextApi['tableNavigationContextRef'];
    metadataGenerationRef: QueryEditorCoreStateApi['metadataGenerationRef'];
    missingTableMetadataKeysRef: QueryEditorCoreStateApi['missingTableMetadataKeysRef'];
    columnsCacheRef: QueryEditorConnectionContextApi['columnsCacheRef'];
    aiContextCacheRef: QueryEditorCoreStateApi['aiContextCacheRef'];
    objectHoverActionRef: QueryEditorCoreStateApi['objectHoverActionRef'];
    lastHoverTargetPositionRef: QueryEditorCoreStateApi['lastHoverTargetPositionRef'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    currentSchema: QueryEditorCoreStateApi['currentSchema'];
}

export const useQueryEditorObjectDecorations = ({
    editorRef, monacoRef, isObjectEditQueryTab, objectDecorationIdsRef, objectDecorationsDirtyRef,
    tablesRef, viewsRef, materializedViewsRef, triggersRef, routinesRef, sequencesRef, packagesRef,
    connectionsRef, currentConnectionIdRef, allColumnsRef, currentDbRef, visibleDbsRef,
    currentSchemaRef, objectDecorationRefreshSeqRef, objectDecorationIdleCallbackRef,
    objectDecorationFallbackTimerRef, sqlReferencedMetadataTimerRef, queryEditorMountedRef,
    queryEditorActiveRef, lastLocalQueryRef, isActive, tableNavigationValidationInFlightRef,
    tableNavigationContextRef, metadataGenerationRef, missingTableMetadataKeysRef, columnsCacheRef,
    aiContextCacheRef, objectHoverActionRef, lastHoverTargetPositionRef, currentDb, currentSchema,
}: UseQueryEditorObjectDecorationsInput) => {
    const refreshObjectDecorations = useCallback((maxTextLength = QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        if (!editor || !monaco || !model) {
            return;
        }

        if (isObjectEditQueryTab) {
            objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
            objectDecorationsDirtyRef.current = false;
            return;
        }

        const objectMetadataCount = tablesRef.current.length
            + viewsRef.current.length
            + materializedViewsRef.current.length
            + triggersRef.current.length
            + routinesRef.current.length
            + sequencesRef.current.length
            + packagesRef.current.length;
        if (objectMetadataCount > 5_000) {
            objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
            objectDecorationsDirtyRef.current = false;
            return;
        }

        const text = getQueryEditorDecorationModelTextIfLightweight(model, maxTextLength);
        if (text === null) {
            objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
            objectDecorationsDirtyRef.current = false;
            return;
        }

        const decorations: any[] = [];
        const seen = new Set<string>();
        const metadataDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        const candidates = collectQueryEditorObjectDecorationCandidates(text, QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS, metadataDialect);
        const lines = text.split('\n');
        const lineStartOffsets: number[] = [];
        let lineStartOffset = 0;
        lines.forEach((line) => {
            lineStartOffsets.push(lineStartOffset);
            lineStartOffset += line.length + 1;
        });
        const decorationColumns = allColumnsRef.current.length <= 2_000
            ? allColumnsRef.current
            : [];
        const aliasMap = buildQueryEditorAliasMap(text, currentDbRef.current, metadataDialect);

        for (const candidate of candidates) {
            const probeContext = buildQueryEditorDecorationProbeContext(
                lines,
                lineStartOffsets,
                candidate.lineNumber,
                candidate.positionColumn,
            );
            const hoverTarget = resolveQueryEditorHoverTarget(
                probeContext.text,
                candidate.lineContent,
                candidate.positionColumn,
                currentDbRef.current,
                visibleDbsRef.current,
                tablesRef.current,
                decorationColumns,
                viewsRef.current,
                materializedViewsRef.current,
                triggersRef.current,
                routinesRef.current,
                sequencesRef.current,
                packagesRef.current,
                isQueryEditorTableSourceAtPosition(
                    probeContext.text,
                    probeContext.lineNumber,
                    candidate.positionColumn,
                    metadataDialect,
                ),
                probeContext.context,
                currentSchemaRef.current,
                aliasMap,
                true,
                metadataDialect,
            );
            if (!hoverTarget) continue;

            const inlineClassName = hoverTarget.kind === 'column'
                ? 'gonavi-query-editor-column-token'
                : hoverTarget.kind === 'database'
                    ? 'gonavi-query-editor-db-token'
                    : 'gonavi-query-editor-object-token';
            const key = `${candidate.lineNumber}:${hoverTarget.range.startColumn}:${hoverTarget.range.endColumn}:${inlineClassName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            decorations.push({
                range: new monaco.Range(
                    candidate.lineNumber,
                    hoverTarget.range.startColumn,
                    candidate.lineNumber,
                    hoverTarget.range.endColumn,
                ),
                options: { inlineClassName },
            });
        }

        objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, decorations);
        objectDecorationsDirtyRef.current = false;
    }, [isObjectEditQueryTab]);

    const cancelPendingObjectDecorationRefresh = useCallback(() => {
        objectDecorationRefreshSeqRef.current += 1;
        if (typeof window === 'undefined') {
            objectDecorationIdleCallbackRef.current = null;
            objectDecorationFallbackTimerRef.current = null;
            return;
        }
        if (objectDecorationIdleCallbackRef.current !== null) {
            window.cancelIdleCallback?.(objectDecorationIdleCallbackRef.current);
            objectDecorationIdleCallbackRef.current = null;
        }
        if (objectDecorationFallbackTimerRef.current !== null) {
            window.clearTimeout(objectDecorationFallbackTimerRef.current);
            objectDecorationFallbackTimerRef.current = null;
        }
    }, []);

    const cancelPendingSqlReferencedMetadataRefresh = useCallback(() => {
        if (sqlReferencedMetadataTimerRef.current === null || typeof window === 'undefined') {
            return;
        }
        window.clearTimeout(sqlReferencedMetadataTimerRef.current);
        sqlReferencedMetadataTimerRef.current = null;
    }, []);

    const scheduleObjectDecorationRefresh = useCallback((
        editor: any,
        maxTextLength = QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
    ) => {
        cancelPendingObjectDecorationRefresh();
        if (isObjectEditQueryTab || typeof window === 'undefined') {
            return;
        }
        const scheduledModel = editor?.getModel?.();
        if (!scheduledModel) {
            return;
        }
        const refreshSeq = objectDecorationRefreshSeqRef.current;
        const runRefresh = () => {
            objectDecorationIdleCallbackRef.current = null;
            objectDecorationFallbackTimerRef.current = null;
            if (
                refreshSeq !== objectDecorationRefreshSeqRef.current
                || !queryEditorMountedRef.current
                || !queryEditorActiveRef.current
                || editorRef.current !== editor
                || editor.getModel?.() !== scheduledModel
            ) {
                return;
            }
            const modelLength = getQueryEditorModelValueLength(scheduledModel)
                ?? lastLocalQueryRef.current.length;
            if (modelLength > maxTextLength) {
                if (objectDecorationIdsRef.current.length > 0) {
                    clearQueryEditorObjectDecorations(editor, objectDecorationIdsRef);
                }
                objectDecorationsDirtyRef.current = false;
                return;
            }
            refreshObjectDecorations(maxTextLength);
        };

        if (typeof window.requestIdleCallback === 'function') {
            objectDecorationIdleCallbackRef.current = window.requestIdleCallback(runRefresh, { timeout: 1_200 });
            return;
        }
        objectDecorationFallbackTimerRef.current = window.setTimeout(runRefresh, 0);
    }, [cancelPendingObjectDecorationRefresh, isObjectEditQueryTab, refreshObjectDecorations]);

    useEffect(() => {
        if (isActive) {
            return;
        }
        cancelPendingSqlReferencedMetadataRefresh();
        cancelPendingObjectDecorationRefresh();
    }, [cancelPendingObjectDecorationRefresh, cancelPendingSqlReferencedMetadataRefresh, isActive]);

    useEffect(() => () => {
        cancelPendingSqlReferencedMetadataRefresh();
        cancelPendingObjectDecorationRefresh();
    }, [cancelPendingObjectDecorationRefresh, cancelPendingSqlReferencedMetadataRefresh]);

    const validateTableNavigationTarget = useCallback(async (
        connectionId: string,
        dbName: string,
        targetTableName: string,
        contextVersion: number,
    ): Promise<boolean | null> => {
        const conn = connectionsRef.current.find((item) => item.id === connectionId);
        if (!conn) {
            return null;
        }
        const metadataDialect = normalizeMetadataDialect(conn);
        const targetMetadataKey = buildQueryEditorTableTargetKey(
            connectionId,
            dbName,
            targetTableName,
            metadataDialect,
        );
        if (!targetMetadataKey || !String(targetTableName || '').trim()) {
            return null;
        }

        const validationKey = `${targetMetadataKey}\u0000${contextVersion}`;
        const pendingValidation = tableNavigationValidationInFlightRef.current[validationKey];
        if (pendingValidation) {
            return pendingValidation;
        }

        const connectionConfig = conn.config;
        const config = {
            ...connectionConfig,
            port: Number(connectionConfig.port),
            password: connectionConfig.password || '',
            database: connectionConfig.database || '',
            useSSH: connectionConfig.useSSH || false,
            ssh: connectionConfig.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        };

        const validationPromise = (async (): Promise<boolean | null> => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    DBTableExists(
                        buildRpcConnectionConfig(config) as any,
                        dbName,
                        targetTableName,
                    ),
                    new Promise<null>((resolve) => {
                        timeoutId = globalThis.setTimeout(
                            () => resolve(null),
                            QUERY_EDITOR_TABLE_NAVIGATION_VALIDATION_TIMEOUT_MS,
                        );
                    }),
                ]);
                if (
                    !queryEditorMountedRef.current
                    || !queryEditorActiveRef.current
                    || String(currentConnectionIdRef.current || '').trim() !== connectionId
                    || connectionsRef.current.find((item) => item.id === connectionId)?.config !== connectionConfig
                    || tableNavigationContextRef.current.version !== contextVersion
                ) {
                    return null;
                }
                if (!result) {
                    return null;
                }
                const exists = (result?.data as { exists?: unknown } | null | undefined)?.exists;
                return result?.success && typeof exists === 'boolean' ? exists : null;
            } catch (error) {
                console.warn('GoNavi table navigation validation failed', error);
                return null;
            } finally {
                if (timeoutId !== undefined) {
                    globalThis.clearTimeout(timeoutId);
                }
                delete tableNavigationValidationInFlightRef.current[validationKey];
            }
        })();

        tableNavigationValidationInFlightRef.current[validationKey] = validationPromise;
        return validationPromise;
    }, []);

    const clearMissingTableNavigationMetadata = useCallback((
        connectionId: string,
        dbName: string,
        targetTableName: string,
    ) => {
        metadataGenerationRef.current += 1;
        setSharedQueryEditorMetadataGeneration(sharedQueryEditorMetadataGeneration + 1);
        const metadataDialect = normalizeMetadataDialect(
            connectionsRef.current.find((item) => item.id === connectionId),
        );
        missingTableMetadataKeysRef.current.add(
            buildQueryEditorTableTargetKey(
                connectionId,
                dbName,
                targetTableName,
                metadataDialect,
            ),
        );
        const normalizedDbName = String(dbName || '').trim();
        const normalizedDbKey = buildQueryEditorMetadataIdentityKey(metadataDialect, normalizedDbName);
        const isTargetTableName = (value: string): boolean => (
            isExactQueryEditorTableName(value, targetTableName, metadataDialect)
        );
        tablesRef.current = tablesRef.current.filter((table) => (
            buildQueryEditorMetadataIdentityKey(metadataDialect, table.dbName) !== normalizedDbKey
            || !isTargetTableName(String(table.tableName || ''))
        ));
        allColumnsRef.current = allColumnsRef.current.filter((column) => (
            buildQueryEditorMetadataIdentityKey(metadataDialect, column.dbName) !== normalizedDbKey
            || !isTargetTableName(String(column.tableName || ''))
        ));
        Object.keys(columnsCacheRef.current).forEach((cacheKey) => {
            const [cachedConnectionId = '', cachedDbName = ''] = cacheKey.split('|');
            if (
                cachedConnectionId === connectionId
                && buildQueryEditorMetadataIdentityKey(metadataDialect, cachedDbName)
                    === normalizedDbKey
            ) {
                delete columnsCacheRef.current[cacheKey];
            }
        });
        // A validation result invalidates any in-flight response for the same
        // database; otherwise that response can reinsert the missing table.
        invalidateSharedLazyTablesCache(connectionId, dbName);
        aiContextCacheRef.current = null;
        setSharedTablesData(tablesRef.current);
        setSharedAllColumnsData(allColumnsRef.current);
        mirrorColumnsCacheIntoBoundedCache(columnsCacheRef.current);
        refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
    }, [refreshObjectDecorations]);

    const showObjectInfoAtPosition = useCallback((position?: { lineNumber: number; column: number } | null) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        const model = editor?.getModel?.();
        const normalizedPosition = normalizeEditorPosition(position || editor?.getPosition?.());
        if (!editor || !model || !normalizedPosition) {
            return false;
        }
        const lineContent = String(model.getLineContent?.(normalizedPosition.lineNumber) || '');
        const resolveContext = buildQueryEditorObjectResolveContext(model, normalizedPosition, lineContent);
        const metadataDialect = normalizeMetadataDialect(connectionsRef.current.find(
            (item) => item.id === currentConnectionIdRef.current,
        ));
        const hoverTarget = resolveQueryEditorHoverTarget(
            resolveContext.text,
            lineContent,
            normalizedPosition.column,
            currentDbRef.current,
            visibleDbsRef.current,
            tablesRef.current,
            allColumnsRef.current,
            viewsRef.current,
            materializedViewsRef.current,
            triggersRef.current,
            routinesRef.current,
            sequencesRef.current,
            packagesRef.current,
            isQueryEditorTableSourceAtPosition(resolveContext.text, resolveContext.lineNumber, normalizedPosition.column, metadataDialect),
            resolveContext.documentContext,
            currentSchemaRef.current,
            undefined,
            true,
            metadataDialect,
        );
        if (!hoverTarget) {
            return false;
        }
        editor.focus?.();
        const hoverRange = monaco
            ? new monaco.Range(
                normalizedPosition.lineNumber,
                hoverTarget.range.startColumn,
                normalizedPosition.lineNumber,
                hoverTarget.range.endColumn,
            )
            : {
                startLineNumber: normalizedPosition.lineNumber,
                startColumn: hoverTarget.range.startColumn,
                endLineNumber: normalizedPosition.lineNumber,
                endColumn: hoverTarget.range.endColumn,
            };
        const contentHoverController = editor.getContribution?.('editor.contrib.contentHover');
        if (contentHoverController?.showContentHover) {
            contentHoverController.showContentHover(hoverRange, 1, 2, false);
            return true;
        }
        editor.setPosition?.({
            lineNumber: normalizedPosition.lineNumber,
            column: hoverTarget.range.startColumn,
        });
        editor.trigger?.('gonavi-hover', 'editor.action.showHover', null);
        return true;
    }, []);

    const registerShowObjectInfoAction = useCallback(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) {
            return;
        }

        objectHoverActionRef.current?.dispose?.();
        const showObjectInfoKeybinding = monaco.KeyMod?.CtrlCmd && monaco.KeyCode?.KeyQ
            ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ]
            : undefined;
        objectHoverActionRef.current = editor.addAction({
            id: 'gonavi.queryEditor.showObjectInfo',
            label: buildQueryEditorMonacoActionLabel('query_editor.action.show_object_info'),
            keybindings: showObjectInfoKeybinding,
            run: () => {
                const preferredPosition = lastHoverTargetPositionRef.current || editor.getPosition?.();
                const shown = showObjectInfoAtPosition(preferredPosition);
                if (!shown) {
                    void message.info({
                        key: 'gonavi-query-editor-object-info-miss',
                        content: translate('query_editor.message.object_info_target_not_found'),
                    });
                }
            },
        });
    }, [showObjectInfoAtPosition]);

    useEffect(() => {
        refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
    }, [currentDb, currentSchema, refreshObjectDecorations]);
    return {
        refreshObjectDecorations, cancelPendingObjectDecorationRefresh,
        cancelPendingSqlReferencedMetadataRefresh, scheduleObjectDecorationRefresh,
        validateTableNavigationTarget, clearMissingTableNavigationMetadata,
        showObjectInfoAtPosition, registerShowObjectInfoAction,
    };
};

export type QueryEditorObjectDecorationsApi = ReturnType<typeof useQueryEditorObjectDecorations>;
