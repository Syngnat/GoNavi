import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { message } from 'antd';
import {
    buildQueryEditorMetadataIdentityKey,
    resetSharedQueryEditorMetadata,
} from '../queryEditorCompletionTables';
import { normalizeMetadataDialect } from '../QueryEditorHelpers';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import { supportsQueryEditorSchemaSelection } from '../queryEditorSchemaContext';
import { t as translate } from '../../../i18n';
import {
    sharedQueryEditorMetadataContextKey,
    sharedQueryEditorMetadataConnectionConfig,
    setSharedQueryEditorMetadataContextKey,
    setSharedQueryEditorMetadataConnectionConfig,
    setSharedCurrentDb,
    setSharedCurrentConnectionId,
    setSharedCurrentSchema,
    setSharedConnections,
    setSharedVisibleDbs,
    setSharedActiveEditorModelUri,
} from '../queryEditorCompletionState';
import { useQueryEditorParams } from '../params/useQueryEditorParams';
import type { QueryParameterAnalysisInfo } from '../params/queryEditorParamsModel';
import type { QueryEditorRunScope } from '../queryEditorRunHelpers';
import { applyParamNameDecorations } from '../params/queryEditorParamsDecorations';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorQueryContextInput {
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    metadataContextKeyRef: QueryEditorCoreStateApi['metadataContextKeyRef'];
    metadataContextConnectionConfigRef: QueryEditorCoreStateApi['metadataContextConnectionConfigRef'];
    metadataFetchKeyRef: QueryEditorCoreStateApi['metadataFetchKeyRef'];
    metadataRetryPendingRef: QueryEditorCoreStateApi['metadataRetryPendingRef'];
    aiContextMetadataWarmupRef: QueryEditorCoreStateApi['aiContextMetadataWarmupRef'];
    aiContextCacheRef: QueryEditorCoreStateApi['aiContextCacheRef'];
    incompleteColumnMetadataDbsRef: QueryEditorCoreStateApi['incompleteColumnMetadataDbsRef'];
    missingTableMetadataKeysRef: QueryEditorCoreStateApi['missingTableMetadataKeysRef'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    allColumnsRef: QueryEditorCoreStateApi['allColumnsRef'];
    viewsRef: QueryEditorCoreStateApi['viewsRef'];
    materializedViewsRef: QueryEditorCoreStateApi['materializedViewsRef'];
    synonymsRef: QueryEditorCoreStateApi['synonymsRef'];
    triggersRef: QueryEditorCoreStateApi['triggersRef'];
    routinesRef: QueryEditorCoreStateApi['routinesRef'];
    sequencesRef: QueryEditorCoreStateApi['sequencesRef'];
    packagesRef: QueryEditorCoreStateApi['packagesRef'];
    columnsCacheRef: QueryEditorConnectionContextApi['columnsCacheRef'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    latestSelectedSchemaRef: QueryEditorConnectionContextApi['latestSelectedSchemaRef'];
    schemaContextKeyRef: QueryEditorConnectionContextApi['schemaContextKeyRef'];
    schemaLoadSeqRef: QueryEditorConnectionContextApi['schemaLoadSeqRef'];
    setCurrentSchema: QueryEditorCoreStateApi['setCurrentSchema'];
    setSchemaList: QueryEditorCoreStateApi['setSchemaList'];
    connections: QueryEditorConnectionContextApi['connections'];
    isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
    setSchemaLoading: QueryEditorCoreStateApi['setSchemaLoading'];
    tab: QueryEditorProps['tab'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    queryContextLockRunSeqRef: QueryEditorCoreStateApi['queryContextLockRunSeqRef'];
    pendingSqlTransactionRef: QueryEditorExecutionStatusApi['pendingSqlTransactionRef'];
    deferredContextRunSeqRef: QueryEditorCoreStateApi['deferredContextRunSeqRef'];
    pendingRunAfterSchemaLoadRef: QueryEditorCoreStateApi['pendingRunAfterSchemaLoadRef'];
    setCurrentConnectionId: QueryEditorCoreStateApi['setCurrentConnectionId'];
    setCurrentDb: QueryEditorCoreStateApi['setCurrentDb'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    setActiveContext: QueryEditorConnectionContextApi['setActiveContext'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    currentConnectionConfig: QueryEditorConnectionContextApi['currentConnectionConfig'];
    savedQueries: QueryEditorConnectionContextApi['savedQueries'];
    currentConnection: QueryEditorConnectionContextApi['currentConnection'];
    query: QueryEditorCoreStateApi['query'];
    paramsPanelAvailableRef: QueryEditorCoreStateApi['paramsPanelAvailableRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    queryEditorMountedRef: QueryEditorCoreStateApi['queryEditorMountedRef'];
    aiInlineGhostTimerRef: QueryEditorCoreStateApi['aiInlineGhostTimerRef'];
    aiInlineGhostRequestSeqRef: QueryEditorCoreStateApi['aiInlineGhostRequestSeqRef'];
}

export const useQueryEditorQueryContext = ({
    isActive, metadataContextKeyRef, metadataContextConnectionConfigRef, metadataFetchKeyRef,
    metadataRetryPendingRef, aiContextMetadataWarmupRef, aiContextCacheRef,
    incompleteColumnMetadataDbsRef, missingTableMetadataKeysRef, tablesRef, allColumnsRef, viewsRef,
    materializedViewsRef, synonymsRef, triggersRef, routinesRef, sequencesRef, packagesRef,
    columnsCacheRef, currentSchemaRef, latestSelectedSchemaRef, schemaContextKeyRef,
    schemaLoadSeqRef, setCurrentSchema, setSchemaList, connections, isObjectEditQueryTab,
    setSchemaLoading, tab, currentConnectionIdRef, currentDbRef, queryContextLockRunSeqRef,
    pendingSqlTransactionRef, deferredContextRunSeqRef, pendingRunAfterSchemaLoadRef,
    setCurrentConnectionId, setCurrentDb, visibleDbsRef, editorRef, setActiveContext,
    updateQueryTabDraft, currentConnectionId, currentDb, currentConnectionConfig, savedQueries,
    currentConnection, query, paramsPanelAvailableRef, monacoRef, queryEditorMountedRef,
    aiInlineGhostTimerRef, aiInlineGhostRequestSeqRef,
}: UseQueryEditorQueryContextInput) => {
    const resetMetadataForContext = useCallback((
        connectionId: string,
        dbName: string,
        connectionConfig: unknown,
    ) => {
        const nextContextKey = [
            String(connectionId || '').trim(),
            buildQueryEditorMetadataIdentityKey(
                normalizeMetadataDialect({ config: connectionConfig }),
                dbName,
            ),
        ].join('\u0000');
        if (
            metadataContextKeyRef.current === nextContextKey
            && metadataContextConnectionConfigRef.current === connectionConfig
        ) {
            return false;
        }
        metadataContextKeyRef.current = nextContextKey;
        metadataContextConnectionConfigRef.current = connectionConfig;
        metadataFetchKeyRef.current = '';
        metadataRetryPendingRef.current = false;
        aiContextMetadataWarmupRef.current = {};
        aiContextCacheRef.current = null;
        incompleteColumnMetadataDbsRef.current.clear();
        missingTableMetadataKeysRef.current.clear();
        tablesRef.current = [];
        allColumnsRef.current = [];
        viewsRef.current = [];
        materializedViewsRef.current = [];
        synonymsRef.current = [];
        triggersRef.current = [];
        routinesRef.current = [];
        sequencesRef.current = [];
        packagesRef.current = [];
        columnsCacheRef.current = {};
        if (isActive) {
            resetSharedQueryEditorMetadata();
        }
        return true;
    }, [isActive]);

    const resetQuerySchemaContext = useCallback((
        nextConnectionId: string,
        nextDbName: string,
    ) => {
        currentSchemaRef.current = '';
        latestSelectedSchemaRef.current = '';
        schemaContextKeyRef.current = '';
        schemaLoadSeqRef.current += 1;
        setCurrentSchema('');
        setSchemaList([]);

        const targetConnection = connections.find((item) => item.id === nextConnectionId);
        const targetDialect = resolveSqlDialect(
            String(targetConnection?.config?.type || ''),
            String(targetConnection?.config?.driver || ''),
            { oceanBaseProtocol: targetConnection?.config?.oceanBaseProtocol },
        );
        const shouldLoadSchema = !isObjectEditQueryTab
            && Boolean(String(nextDbName || '').trim())
            && supportsQueryEditorSchemaSelection(targetDialect);
        setSchemaLoading(shouldLoadSchema);
    }, [connections, isObjectEditQueryTab, setSchemaLoading]);

    const switchQueryContext = useCallback((
        nextConnectionId: string,
        nextDbName: string,
        options: { persist?: boolean; silentPending?: boolean } = {},
    ): boolean => {
        const normalizedConnectionId = String(nextConnectionId || '').trim();
        const normalizedDbName = String(nextDbName || '').trim();
        const contextChanged = normalizedConnectionId !== String(currentConnectionIdRef.current || '').trim()
            || normalizedDbName !== String(currentDbRef.current || '').trim();
        if (!contextChanged) return true;
        if (queryContextLockRunSeqRef.current !== 0) {
            if (!options.silentPending) {
                void message.info(translate('common.loading'));
            }
            return false;
        }
        if (pendingSqlTransactionRef.current) {
            if (!options.silentPending) {
                void message.warning(translate('query_editor.transaction.message.pending_managed_transaction'));
            }
            return false;
        }

        deferredContextRunSeqRef.current += 1;
        pendingRunAfterSchemaLoadRef.current = false;
        currentConnectionIdRef.current = normalizedConnectionId;
        currentDbRef.current = normalizedDbName;
        setCurrentConnectionId(normalizedConnectionId);
        setCurrentDb(normalizedDbName);
        resetQuerySchemaContext(normalizedConnectionId, normalizedDbName);

        const targetConnectionConfig = connections.find(
            (connection) => connection.id === normalizedConnectionId,
        )?.config ?? null;
        if (isActive) {
            const metadataContextChanged = resetMetadataForContext(
                normalizedConnectionId,
                normalizedDbName,
                targetConnectionConfig,
            );
            const nextSharedMetadataContextKey = `${tab.id}\u0000${normalizedConnectionId}\u0000${normalizedDbName}\u0000`;
            if (
                !metadataContextChanged
                && (
                    sharedQueryEditorMetadataContextKey !== nextSharedMetadataContextKey
                    || sharedQueryEditorMetadataConnectionConfig !== targetConnectionConfig
                )
            ) {
                resetSharedQueryEditorMetadata();
            }
            setSharedQueryEditorMetadataContextKey(nextSharedMetadataContextKey);
            setSharedQueryEditorMetadataConnectionConfig(targetConnectionConfig);
            setSharedCurrentDb(normalizedDbName);
            setSharedCurrentConnectionId(normalizedConnectionId);
            setSharedCurrentSchema('');
            setSharedConnections(connections);
            setSharedVisibleDbs(visibleDbsRef.current);
            setSharedActiveEditorModelUri(String(editorRef.current?.getModel?.()?.uri?.toString?.() || ''));
        }
        if (isActive && normalizedConnectionId) {
            setActiveContext({ connectionId: normalizedConnectionId, dbName: normalizedDbName });
        }
        if (options.persist !== false) {
            updateQueryTabDraft(tab.id, {
                connectionId: normalizedConnectionId,
                dbName: normalizedDbName,
                schemaName: '',
            });
        }
        return true;
    }, [
        connections,
        isActive,
        pendingSqlTransactionRef,
        resetMetadataForContext,
        resetQuerySchemaContext,
        setActiveContext,
        tab.id,
        updateQueryTabDraft,
    ]);

    useEffect(() => {
        resetMetadataForContext(currentConnectionId, currentDb, currentConnectionConfig);
    }, [currentConnectionConfig, currentConnectionId, currentDb, resetMetadataForContext]);

    const currentSavedQuery = useMemo(() => {
        const savedId = String(tab.savedQueryId || '').trim();
        if (savedId) {
            return savedQueries.find((item) => item.id === savedId) || null;
        }
        const tabId = String(tab.id || '').trim();
        if (!tabId) {
            return null;
        }
        return savedQueries.find((item) => item.id === tabId) || null;
    }, [savedQueries, tab.id, tab.savedQueryId]);

    // 运行时绑定参数：面板防抖分析 + 执行前权威门控（见 handleRun）。
    const paramsState = useQueryEditorParams({
        config: (currentConnection?.config ?? null) as Record<string, unknown> | null,
        dbName: currentDb,
        sql: query,
        getSql: () => editorRef.current?.getValue?.() ?? query,
        enabled: Boolean(currentConnectionId),
        savedParams: currentSavedQuery?.parameters ?? null,
        resetToken: `${currentConnectionId || ''}:${currentDb || ''}`,
    });
    const [paramsDialogState, setParamsDialogState] = useState<{
        open: boolean;
        analysis: QueryParameterAnalysisInfo | null;
    }>({ open: false, analysis: null });
    const lastParamsRunScopeRef = useRef<QueryEditorRunScope>('default');
    paramsPanelAvailableRef.current = paramsState.hasParams || !!paramsState.analysis;

    // 参数名在 Monaco 中的展示高亮：随分析结果刷新（面板/执行同节奏）。
    useEffect(() => {
        applyParamNameDecorations(editorRef.current, monacoRef.current, paramsState.analysis?.parameterNames || []);
    }, [paramsState.analysis]);

    useEffect(() => {
        queryEditorMountedRef.current = true;
        return () => {
            queryEditorMountedRef.current = false;
            if (aiInlineGhostTimerRef.current !== null) {
                clearTimeout(aiInlineGhostTimerRef.current);
                aiInlineGhostTimerRef.current = null;
            }
            aiInlineGhostRequestSeqRef.current += 1;
        };
    }, []);
    return {
        switchQueryContext, currentSavedQuery, paramsState, paramsDialogState, setParamsDialogState,
        lastParamsRunScopeRef,
    };
};

export type QueryEditorQueryContextApi = ReturnType<typeof useQueryEditorQueryContext>;
