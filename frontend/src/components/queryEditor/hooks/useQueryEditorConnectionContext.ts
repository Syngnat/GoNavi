import { useRef, useMemo, useState, useEffect, useDeferredValue, useCallback } from 'react';
import { useStore } from '../../../store';
import { supportsQueryEditorSchemaSelection } from '../queryEditorSchemaContext';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import {
    buildQueryEditorMetadataRenderContextKey,
    buildQueryEditorTableNavigationContextKey,
} from '../queryEditorVisibilityContext';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import { isElasticsearchConnection } from '../../../utils/elasticsearchConsole';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { InspectElasticsearchConsole } from '../../../../wailsjs/go/app/App';
import { resolveQueryEditorMonacoLanguage } from '../QueryEditorHelpers';
import { EMPTY_QUERY_EDITOR_SQL_LOGS } from '../queryEditorRunHelpers';
import { buildQueryEditorInlineMemoryEntries } from '../queryEditorInlineMemory';
import type { QueryEditorMetadataRequestSnapshot } from '../queryEditorHoverDdl';
import { ColumnDefinition } from '../../../types';
import { resolveQueryEditorTabSplitRatio } from '../../../utils/queryEditorSplitLayout';
import { isNativeDetachedWindow } from '../../../utils/nativeDetachedWindowClient';
import { saveQueryEditorResultSessionForOpenTab } from '../../../utils/queryEditorResultSessionCache';
import { useQueryEditorResultSessionLifecycle } from '../queryEditorResultSessionLifecycle';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorConnectionContextInput {
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
    tab: QueryEditorProps['tab'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    metadataGenerationRef: QueryEditorCoreStateApi['metadataGenerationRef'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    currentSchema: QueryEditorCoreStateApi['currentSchema'];
    queryEditorMountedRef: QueryEditorCoreStateApi['queryEditorMountedRef'];
    queryOptions: QueryEditorCoreStateApi['queryOptions'];
    restoredResultSessionRef: QueryEditorCoreStateApi['restoredResultSessionRef'];
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    activeResultKeyRef: QueryEditorCoreStateApi['activeResultKeyRef'];
    resultSets: QueryEditorCoreStateApi['resultSets'];
    activeResultKey: QueryEditorCoreStateApi['activeResultKey'];
}

export const useQueryEditorConnectionContext = ({
    currentConnectionId, isObjectEditQueryTab, tab, currentDb, metadataGenerationRef, editorRef,
    monacoRef, isActive, currentSchema, queryEditorMountedRef, queryOptions,
    restoredResultSessionRef, resultSetsRef, activeResultKeyRef, resultSets, activeResultKey,
}: UseQueryEditorConnectionContextInput) => {
    const connections = useStore(state => state.connections);
    const connectionTags = useStore(state => state.connectionTags);
    const sidebarRootOrder = useStore(state => state.sidebarRootOrder);
    const rootSortMode = useStore(state => state.rootSortMode);
    const rootConnectionSortMode = useStore(state => state.rootConnectionSortMode);
    const currentConnection = connections.find(
        (connection) => connection.id === currentConnectionId,
    );
    const currentConnectionConfig = currentConnection?.config ?? null;
    const canSelectQuerySchema = !isObjectEditQueryTab && supportsQueryEditorSchemaSelection(
        resolveSqlDialect(
            String(currentConnectionConfig?.type || ''),
            String(currentConnectionConfig?.driver || ''),
            { oceanBaseProtocol: currentConnectionConfig?.oceanBaseProtocol },
        ),
    );
    const metadataRenderContextRef = useRef<{ key: string; connectionConfig: unknown }>({
        key: '',
        connectionConfig: null,
    });
    const metadataRenderContextKey = buildQueryEditorMetadataRenderContextKey(
        tab.id,
        currentConnectionId,
        currentDb,
    );
    if (
        metadataRenderContextRef.current.key !== metadataRenderContextKey
        || metadataRenderContextRef.current.connectionConfig !== currentConnectionConfig
    ) {
        metadataGenerationRef.current += 1;
        metadataRenderContextRef.current = {
            key: metadataRenderContextKey,
            connectionConfig: currentConnectionConfig,
        };
    }
    const queryCapableConnections = useMemo(
        () => connections.filter(c => getDataSourceCapabilities(c.config).supportsQueryEditor),
        [connections]
    );
    const currentConnectionCapabilities = useMemo(
        () => getDataSourceCapabilities(
            connections.find(connection => connection.id === currentConnectionId)?.config,
        ),
        [connections, currentConnectionId],
    );
    const isElasticsearchMode = useMemo(
        () => isElasticsearchConnection(
            connections.find(connection => connection.id === currentConnectionId)?.config,
        ),
        [connections, currentConnectionId],
    );
    const [elasticsearchServerMajor, setElasticsearchServerMajor] = useState(0);
    useEffect(() => {
        setElasticsearchServerMajor(0);
    }, [currentConnectionId]);
    useEffect(() => {
        if (!isElasticsearchMode) return;
        const conn = connections.find((connection) => connection.id === currentConnectionId);
        if (!conn) return;
        let cancelled = false;
        const config = buildRpcConnectionConfig({
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || '',
            database: conn.config.database || '',
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        }) as any;
        void InspectElasticsearchConsole(config, '', 'GET /')
            .then((inspection: any) => {
                const major = Number(inspection?.serverMajor || 0);
                if (!cancelled && major > 0) {
                    setElasticsearchServerMajor(major);
                }
            })
            .catch(() => {
                // Execution preflight will surface connection and policy errors.
            });
        return () => {
            cancelled = true;
        };
    }, [connections, currentConnectionId, isElasticsearchMode]);
    const queryEditorMonacoLanguage = useMemo(
        () => resolveQueryEditorMonacoLanguage(
            connections.find(connection => connection.id === currentConnectionId),
        ),
        [connections, currentConnectionId],
    );
    useEffect(() => {
        const model = editorRef.current?.getModel?.();
        if (model && monacoRef.current?.editor?.setModelLanguage) {
            monacoRef.current.editor.setModelLanguage(model, queryEditorMonacoLanguage);
        }
    }, [queryEditorMonacoLanguage]);

    const addSqlLog = useStore(state => state.addSqlLog);
    const sqlLogs = useStore(state => (isActive ? state.sqlLogs : EMPTY_QUERY_EDITOR_SQL_LOGS));
    const sqlLogCount = sqlLogs.length;
    const deferredSqlLogs = useDeferredValue(sqlLogs);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const updateQueryTabDraft = useStore(state => state.updateQueryTabDraft);
    const savedQueries = useStore(state => state.savedQueries);
    const sqlSnippets = useStore(state => state.sqlSnippets);
    const currentConnectionIdRef = useRef(currentConnectionId);
    const currentDbRef = useRef(currentDb);
    const currentSchemaRef = useRef(currentSchema);
    const latestSelectedSchemaRef = useRef('');
    const schemaLoadSeqRef = useRef(0);
    const schemaContextKeyRef = useRef('');
    const tableNavigationContextRef = useRef<{ key: string; connectionConfig: unknown; version: number }>({
        key: '',
        connectionConfig: null,
        version: 0,
    });
    const tableNavigationContextKey = buildQueryEditorTableNavigationContextKey(
        tab.id,
        currentConnectionId,
        currentDb,
        currentSchema,
    );
    if (
        tableNavigationContextRef.current.key !== tableNavigationContextKey
        || tableNavigationContextRef.current.connectionConfig !== currentConnectionConfig
    ) {
        tableNavigationContextRef.current = {
            key: tableNavigationContextKey,
            connectionConfig: currentConnectionConfig,
            version: tableNavigationContextRef.current.version + 1,
        };
    }
    const inlineSqlMemoryEntries = useMemo(() => buildQueryEditorInlineMemoryEntries({
        currentConnectionId,
        currentDb,
        savedQueries,
        sqlLogs: deferredSqlLogs,
    }), [currentConnectionId, currentDb, savedQueries, deferredSqlLogs]);
    const draftSnapshotTab = useMemo(() => ({
        id: tab.id,
        title: tab.title,
        connectionId: tab.connectionId,
        dbName: tab.dbName,
        filePath: tab.filePath,
        savedQueryId: tab.savedQueryId,
        readOnly: tab.readOnly,
    }), [tab.connectionId, tab.dbName, tab.filePath, tab.id, tab.readOnly, tab.savedQueryId, tab.title]);
    const connectionsRef = useRef(connections);
    const isQueryEditorMetadataRequestCurrent = useCallback((
        snapshot: QueryEditorMetadataRequestSnapshot,
    ): boolean => (
        queryEditorMountedRef.current
        && metadataGenerationRef.current === snapshot.generation
        && String(currentConnectionIdRef.current || '').trim() === snapshot.connectionId
        && connectionsRef.current.find((connection) => connection.id === snapshot.connectionId)?.config === snapshot.connectionConfig
    ), []);
    const columnsCacheRef = useRef<Record<string, ColumnDefinition[]>>({});
    const saveQuery = useStore(state => state.saveQuery);
    const theme = useStore(state => state.theme);
    const languagePreference = useStore((state) => state.languagePreference);
    void languagePreference;
    const darkMode = theme === 'dark';

    const sqlFormatOptions = useStore(state => state.sqlFormatOptions);
    const setSqlFormatOptions = useStore(state => state.setSqlFormatOptions);
    const queryEditorEditorHeightRatio = resolveQueryEditorTabSplitRatio(
        tab.id,
        queryOptions?.queryEditorEditorHeightRatio,
    );
    const sqlEditorTransactionOptions = useStore(state => state.sqlEditorTransactionOptions);
    const setSqlEditorTransactionOptions = useStore(state => state.setSqlEditorTransactionOptions);
    const [isResultPanelVisible, setIsResultPanelVisible] = useState(
        () => restoredResultSessionRef.current?.isResultPanelVisible
            ?? (tab.resultPanelVisible === true)
    );
    const isResultPanelVisibleRef = useRef(isResultPanelVisible);
    isResultPanelVisibleRef.current = isResultPanelVisible;
    const publishesDetachedResultSession = useMemo(() => isNativeDetachedWindow(), []);

    useEffect(() => {
        const captureSession = (event: Event) => {
            const requestedTabId = String((event as CustomEvent).detail?.tabId || '').trim();
            if (requestedTabId !== tab.id) return;
            saveQueryEditorResultSessionForOpenTab(tab.id, {
                resultSets: resultSetsRef.current,
                activeResultKey: activeResultKeyRef.current,
                isResultPanelVisible: isResultPanelVisibleRef.current,
            }, useStore.getState().tabs);
        };
        window.addEventListener('gonavi:capture-query-result-session', captureSession);
        return () => {
            window.removeEventListener('gonavi:capture-query-result-session', captureSession);
        };
    }, [tab.id]);

    useQueryEditorResultSessionLifecycle({
        tabId: tab.id,
        resultSets,
        activeResultKey,
        isResultPanelVisible,
        publishesDetachedResultSession,
        resultSetsRef,
        activeResultKeyRef,
        isResultPanelVisibleRef,
        editorRef,
        isActive,
    });
    return {
        connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode,
        currentConnection, currentConnectionConfig, canSelectQuerySchema, queryCapableConnections,
        currentConnectionCapabilities, isElasticsearchMode, elasticsearchServerMajor,
        setElasticsearchServerMajor, queryEditorMonacoLanguage, addSqlLog, sqlLogCount, addTab,
        setActiveContext, updateQueryTabDraft, savedQueries, sqlSnippets, currentConnectionIdRef,
        currentDbRef, currentSchemaRef, latestSelectedSchemaRef, schemaLoadSeqRef,
        schemaContextKeyRef, tableNavigationContextRef, inlineSqlMemoryEntries, draftSnapshotTab,
        connectionsRef, isQueryEditorMetadataRequestCurrent, columnsCacheRef, saveQuery,
        languagePreference, darkMode, sqlFormatOptions, setSqlFormatOptions,
        queryEditorEditorHeightRatio, sqlEditorTransactionOptions, setSqlEditorTransactionOptions,
        isResultPanelVisible, setIsResultPanelVisible, isResultPanelVisibleRef,
    };
};

export type QueryEditorConnectionContextApi = ReturnType<typeof useQueryEditorConnectionContext>;
