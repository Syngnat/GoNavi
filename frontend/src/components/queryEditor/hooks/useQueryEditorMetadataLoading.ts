import { useEffect } from 'react';
import {
    getTabQueryValue,
    normalizeMetadataDialect,
    resolveOracleLikeDefaultSchemaName,
    getCaseInsensitiveValue,
    collectQueryEditorReferencedDatabaseNames,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
    type CompletionTableMeta,
    type CompletionColumnMeta,
    type CompletionViewMeta,
    type CompletionSynonymMeta,
    type CompletionTriggerMeta,
    type CompletionRoutineMeta,
    type CompletionSequenceMeta,
    type CompletionPackageMeta,
    type MetadataQuerySpec,
    type MetadataQueryResult,
    queryCompletionMetadataRowsBySpecs,
    buildCompletionSynonymsMetadataQuerySpecs,
    buildCompletionViewsMetadataQuerySpecs,
    buildCompletionMaterializedViewsMetadataQuerySpecs,
    buildCompletionTriggersMetadataQuerySpecs,
    buildCompletionFunctionsMetadataQuerySpecs,
    buildCompletionSequencesMetadataQuerySpecs,
    buildCompletionPackagesMetadataQuerySpecs,
} from '../QueryEditorHelpers';
import {
    DBGetDatabases,
    DBQuery,
    DBGetTables,
    DBGetAllColumns,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { filterVisibleDatabaseNames } from '../../../utils/databaseVisibility';
import {
    setSharedVisibleDbs,
    sharedCurrentConnectionId,
    setSharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataGeneration,
    setSharedTablesData,
    setSharedAllColumnsData,
    setSharedViewsData,
    setSharedMaterializedViewsData,
    setSharedSynonymsData,
    setSharedTriggersData,
    setSharedRoutinesData,
    setSharedSequencesData,
    setSharedPackagesData,
    sharedQueryEditorMetadataReloadRequestListeners,
    setSharedCurrentDb,
} from '../queryEditorCompletionState';
import {
    QUERY_EDITOR_CURRENT_SCHEMA_SQL,
    extractQueryEditorCurrentSchema,
    resolveLoadedQueryEditorSchema,
} from '../queryEditorSchemaContext';
import { loadSchemas } from '../../sidebar/sidebarMetadataLoaders';
import {
    installQueryEditorHoverDdlCacheInvalidationListener,
    uninstallQueryEditorHoverDdlCacheInvalidationListener,
    type QueryEditorMetadataRequestSnapshot,
} from '../queryEditorHoverDdl';
import type { SidebarDatabaseRefreshRequest } from '../../../utils/sidebarDatabaseRefresh';
import {
    resetSharedQueryEditorMetadata,
    buildQueryEditorMetadataIdentityKey,
    fetchCompletionTableCommentMap,
    buildCompletionTableMeta,
} from '../queryEditorCompletionTables';
import { isConnectionScopedQueryEditorMetadata } from '../queryEditorLazyTablesCache';
import {
    collectQueryEditorSynonymMetadata,
    collectQueryEditorColumnMetadata,
    collectQueryEditorViewMetadata,
    collectQueryEditorMaterializedViewMetadata,
    collectQueryEditorTriggerMetadata,
    collectQueryEditorRoutineMetadata,
    collectQueryEditorSequenceMetadata,
    collectQueryEditorPackageMetadata,
} from '../metadata/queryEditorMetadataRowCollectors';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorAiAssistActionsApi } from './useQueryEditorAiAssistActions';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorMetadataLoadingInput {
    tab: QueryEditorProps['tab'];
    lastExternalQueryRef: QueryEditorCoreStateApi['lastExternalQueryRef'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    lastLocalQueryRef: QueryEditorCoreStateApi['lastLocalQueryRef'];
    setQuery: QueryEditorCoreStateApi['setQuery'];
    syncQueryToEditor: QueryEditorAiAssistActionsApi['syncQueryToEditor'];
    hasBeenActive: QueryEditorCoreStateApi['hasBeenActive'];
    autoFetchVisible: QueryEditorExecutionStatusApi['autoFetchVisible'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    queryEditorActiveRef: QueryEditorCoreStateApi['queryEditorActiveRef'];
    setDbList: QueryEditorCoreStateApi['setDbList'];
    schemaLoadSeqRef: QueryEditorConnectionContextApi['schemaLoadSeqRef'];
    setSchemaLoading: QueryEditorCoreStateApi['setSchemaLoading'];
    canSelectQuerySchema: QueryEditorConnectionContextApi['canSelectQuerySchema'];
    schemaContextKeyRef: QueryEditorConnectionContextApi['schemaContextKeyRef'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    latestSelectedSchemaRef: QueryEditorConnectionContextApi['latestSelectedSchemaRef'];
    setCurrentSchema: QueryEditorCoreStateApi['setCurrentSchema'];
    setSchemaList: QueryEditorCoreStateApi['setSchemaList'];
    currentConnection: QueryEditorConnectionContextApi['currentConnection'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
    metadataGenerationRef: QueryEditorCoreStateApi['metadataGenerationRef'];
    metadataFetchKeyRef: QueryEditorCoreStateApi['metadataFetchKeyRef'];
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
    incompleteColumnMetadataDbsRef: QueryEditorCoreStateApi['incompleteColumnMetadataDbsRef'];
    missingTableMetadataKeysRef: QueryEditorCoreStateApi['missingTableMetadataKeysRef'];
    queryEditorMetadataForceReloadRef: QueryEditorCoreStateApi['queryEditorMetadataForceReloadRef'];
    setQueryEditorMetadataReloadTick: QueryEditorCoreStateApi['setQueryEditorMetadataReloadTick'];
    isQueryEditorMetadataRequestCurrent: QueryEditorConnectionContextApi['isQueryEditorMetadataRequestCurrent'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    objectDecorationsDirtyRef: QueryEditorCoreStateApi['objectDecorationsDirtyRef'];
    scheduleObjectDecorationRefresh: QueryEditorObjectDecorationsApi['scheduleObjectDecorationRefresh'];
    metadataRetryPendingRef: QueryEditorCoreStateApi['metadataRetryPendingRef'];
    refreshObjectDecorations: QueryEditorObjectDecorationsApi['refreshObjectDecorations'];
    lastSqlReferencedMetadataKeyRef: QueryEditorCoreStateApi['lastSqlReferencedMetadataKeyRef'];
    queryEditorMetadataReloadTick: QueryEditorCoreStateApi['queryEditorMetadataReloadTick'];
    sqlReferencedMetadataKey: QueryEditorCoreStateApi['sqlReferencedMetadataKey'];
}

export const useQueryEditorMetadataLoading = ({
    tab, lastExternalQueryRef, editorRef, lastLocalQueryRef, setQuery, syncQueryToEditor,
    hasBeenActive, autoFetchVisible, connections, currentConnectionId, visibleDbsRef,
    queryEditorActiveRef, setDbList, schemaLoadSeqRef, setSchemaLoading, canSelectQuerySchema,
    schemaContextKeyRef, currentSchemaRef, latestSelectedSchemaRef, setCurrentSchema, setSchemaList,
    currentConnection, currentDb, updateQueryTabDraft, currentConnectionIdRef, isObjectEditQueryTab,
    metadataGenerationRef, metadataFetchKeyRef, tablesRef, allColumnsRef, viewsRef,
    materializedViewsRef, synonymsRef, triggersRef, routinesRef, sequencesRef, packagesRef,
    columnsCacheRef, incompleteColumnMetadataDbsRef, missingTableMetadataKeysRef,
    queryEditorMetadataForceReloadRef, setQueryEditorMetadataReloadTick,
    isQueryEditorMetadataRequestCurrent, currentDbRef, getCurrentQuery, objectDecorationsDirtyRef,
    scheduleObjectDecorationRefresh, metadataRetryPendingRef, refreshObjectDecorations,
    lastSqlReferencedMetadataKeyRef, queryEditorMetadataReloadTick, sqlReferencedMetadataKey,
}: UseQueryEditorMetadataLoadingInput) => {
    // If opening a saved query, load its SQL
    useEffect(() => {
        const incoming = getTabQueryValue(tab);
        if (incoming === lastExternalQueryRef.current) {
            return;
        }
        lastExternalQueryRef.current = incoming;
        const editorHasFocus = editorRef.current?.hasTextFocus?.() === true;
        if (editorHasFocus && incoming === lastLocalQueryRef.current) {
            setQuery(incoming);
            return;
        }
        syncQueryToEditor(incoming);
    }, [tab.id, tab.query]);

    // Fetch Database List
    useEffect(() => {
        if (!hasBeenActive || !autoFetchVisible) {
            return;
        }

        let cancelled = false;
        const fetchDbs = async () => {
            const conn = connections.find(c => c.id === currentConnectionId);
            if (!conn) return;

            const config = {
              ...conn.config,
              port: Number(conn.config.port),
              password: conn.config.password || "",
              database: conn.config.database || "",
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
            };

            const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
            if (cancelled) return;
            if (res.success && Array.isArray(res.data)) {
                let dbs = res.data.map((row: any) => row.Database || row.database);

                dbs = filterVisibleDatabaseNames(conn, dbs);

                // 存储可见数据库列表用于跨库智能提示
                visibleDbsRef.current = dbs;
                if (queryEditorActiveRef.current) {
                    setSharedVisibleDbs(dbs);
                }

                setDbList(dbs);
            } else {
                visibleDbsRef.current = [];
                if (queryEditorActiveRef.current) {
                    setSharedVisibleDbs([]);
                }
                setDbList([]);
            }
        };
        void fetchDbs().catch((error) => {
            if (cancelled) return;
            console.warn('GoNavi query editor database list fetch failed', error);
            visibleDbsRef.current = [];
            if (queryEditorActiveRef.current) setSharedVisibleDbs([]);
            setDbList([]);
        });
        return () => {
            cancelled = true;
        };
    }, [autoFetchVisible, currentConnectionId, connections, hasBeenActive]);

    // PostgreSQL keeps database and schema as separate execution contexts. Load the
    // available schemas without mutating the saved connection configuration.
    useEffect(() => {
        if (!hasBeenActive || !autoFetchVisible) {
            schemaLoadSeqRef.current += 1;
            setSchemaLoading(false);
            return;
        }
        if (!canSelectQuerySchema) {
            schemaLoadSeqRef.current += 1;
            schemaContextKeyRef.current = '';
            currentSchemaRef.current = '';
            latestSelectedSchemaRef.current = '';
            setCurrentSchema('');
            setSchemaList([]);
            setSchemaLoading(false);
            return;
        }

        const conn = currentConnection;
        const dbName = String(currentDb || '').trim();
        if (!conn || !dbName) {
            schemaLoadSeqRef.current += 1;
            setSchemaList([]);
            setSchemaLoading(false);
            return;
        }

        const contextKey = `${tab.id}\u0000${currentConnectionId}\u0000${dbName}`;
        if (schemaContextKeyRef.current !== contextKey) {
            schemaContextKeyRef.current = contextKey;
            latestSelectedSchemaRef.current = '';
            const rememberedSchema = String(currentSchemaRef.current || '').trim();
            setSchemaList(rememberedSchema ? [rememberedSchema] : []);
        }

        const requestSeq = schemaLoadSeqRef.current + 1;
        schemaLoadSeqRef.current = requestSeq;
        let cancelled = false;
        setSchemaLoading(true);

        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || '',
            database: conn.config.database || '',
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        };
        const loadCurrentSchema = DBQuery(
            buildRpcConnectionConfig(config) as any,
            dbName,
            QUERY_EDITOR_CURRENT_SCHEMA_SQL,
        ).then((result) => (
            result.success ? extractQueryEditorCurrentSchema(result.data) : ''
        )).catch(() => '');

        void Promise.all([loadSchemas(conn, dbName), loadCurrentSchema])
            .then(([result, databaseDefaultSchema]) => {
                if (cancelled) return;
                const resolved = resolveLoadedQueryEditorSchema({
                    requestSeq,
                    currentRequestSeq: schemaLoadSeqRef.current,
                    latestSelectedSchema: latestSelectedSchemaRef.current,
                    explicitSchema: String(tab.schemaName || ''),
                    rememberedSchema: String(tab.schemaName || ''),
                    currentSchema: databaseDefaultSchema,
                    schemaNames: Array.isArray(result.schemas) ? result.schemas : [],
                });
                if (!resolved) return;
                currentSchemaRef.current = resolved.selectedSchema;
                setCurrentSchema(resolved.selectedSchema);
                setSchemaList(resolved.schemaNames);
                if (resolved.selectedSchema) {
                    updateQueryTabDraft(tab.id, { schemaName: resolved.selectedSchema });
                }
            })
            .catch(() => {
                if (cancelled || requestSeq !== schemaLoadSeqRef.current) return;
                const fallbackSchema = String(currentSchemaRef.current || tab.schemaName || '').trim();
                setSchemaList(fallbackSchema ? [fallbackSchema] : []);
            })
            .finally(() => {
                if (!cancelled && requestSeq === schemaLoadSeqRef.current) {
                    setSchemaLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        autoFetchVisible,
        canSelectQuerySchema,
        currentConnection,
        currentConnectionId,
        currentDb,
        hasBeenActive,
        setSchemaLoading,
        tab.id,
        updateQueryTabDraft,
    ]);

    // Fetch Metadata for Autocomplete (Cross-database)
    // 注册重载回调：结构变更（含表设计器等外部入口）触发刷新事件后，通过 tick 重跑本 effect 拉取最新元数据
    useEffect(() => {
        // 组件挂载时对当前 window 重新安装刷新监听（测试环境会替换 window 桩，模块级安装只覆盖首个 window）
        installQueryEditorHoverDdlCacheInvalidationListener();
        const reloadListener = (request: SidebarDatabaseRefreshRequest) => {
            if (request.connectionId !== String(currentConnectionIdRef.current || '').trim()) {
                return;
            }
            const updatesSharedActiveContext = queryEditorActiveRef.current
                && !isObjectEditQueryTab
                && String(sharedCurrentConnectionId || '').trim() === request.connectionId;
            // 先失效再调度 effect：在 React 清理旧 effect 前返回的请求也不能把旧结构写回。
            metadataGenerationRef.current += 1;
            metadataFetchKeyRef.current = '';
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
            incompleteColumnMetadataDbsRef.current.clear();
            missingTableMetadataKeysRef.current.clear();
            if (updatesSharedActiveContext) {
                setSharedQueryEditorMetadataGeneration(sharedQueryEditorMetadataGeneration + 1);
                setSharedTablesData([]);
                setSharedAllColumnsData([]);
                setSharedViewsData([]);
                setSharedMaterializedViewsData([]);
                setSharedSynonymsData([]);
                setSharedTriggersData([]);
                setSharedRoutinesData([]);
                setSharedSequencesData([]);
                setSharedPackagesData([]);
            }
            queryEditorMetadataForceReloadRef.current = true;
            setQueryEditorMetadataReloadTick((tick) => tick + 1);
        };
        sharedQueryEditorMetadataReloadRequestListeners.add(reloadListener);
        return () => {
            sharedQueryEditorMetadataReloadRequestListeners.delete(reloadListener);
            if (sharedQueryEditorMetadataReloadRequestListeners.size === 0) {
                uninstallQueryEditorHoverDdlCacheInvalidationListener();
                // No editor can receive refresh events while the set is empty.
                // Drop shared metadata as well so a later mount cannot reuse a
                // cache that may have changed while the listener was absent.
                resetSharedQueryEditorMetadata(true);
            }
        };
    }, []);
    useEffect(() => {
        if (!hasBeenActive || !autoFetchVisible || isObjectEditQueryTab) {
            return;
        }

        let cancelled = false;
        // 事件驱动的重载只生效一次；普通依赖变化不绕过去重
        const forceMetadataReload = queryEditorMetadataForceReloadRef.current;
        queryEditorMetadataForceReloadRef.current = false;
        const metadataGeneration = metadataGenerationRef.current;
        // 仅在本次 effect 成功完成后写入；中途 cancel 不得留下 key，否则同 key 永远不再拉取 → 超链接全灭
        let activeFetchKey = '';
        let metadataFetchFailed = false;
        const fetchMetadata = async () => {
            const conn = connections.find(c => c.id === currentConnectionId);
            if (!conn) return;
            const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                generation: metadataGeneration,
                connectionId: currentConnectionId,
                connectionConfig: conn.config,
            };
            const isCurrentMetadataRequest = () => (
                !cancelled && isQueryEditorMetadataRequestCurrent(metadataSnapshot)
            );

            const visibleDbs = filterVisibleDatabaseNames(conn, visibleDbsRef.current);
            visibleDbsRef.current = visibleDbs;
            if (queryEditorActiveRef.current) {
                setSharedVisibleDbs(visibleDbs);
            }
            setDbList((current) => (
                current.length === visibleDbs.length
                && current.every((database, index) => database === visibleDbs[index])
                    ? current
                    : visibleDbs
            ));

            const config = {
              ...conn.config,
              port: Number(conn.config.port),
              password: conn.config.password || "",
              database: conn.config.database || "",
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
            };

                const metadataDbName = String(currentDbRef.current ?? currentDb ?? '').trim();
            const connectionScopedMetadata = isConnectionScopedQueryEditorMetadata(conn);
            if (!metadataDbName && !connectionScopedMetadata) return;
            const metadataDialect = normalizeMetadataDialect(conn);
            const oracleMetadataOwner = metadataDialect === 'oracle'
                ? (resolveOracleLikeDefaultSchemaName(config) || metadataDbName)
                : '';
            const isMetadataRowForDatabase = (
                row: Record<string, any>,
                targetDbName: string,
                ownerKeys: string[],
            ): boolean => {
                if (metadataDialect !== 'oracle') return true;
                const targetOwner = String(targetDbName || '').trim();
                if (!targetOwner) return true;
                const rowOwner = String(getCaseInsensitiveValue(row, ownerKeys) || '').trim();
                if (rowOwner) {
                    return rowOwner.toLowerCase() === targetOwner.toLowerCase();
                }
                // USER_* compatibility queries omit OWNER and always refer to
                // the login schema. Never attribute those rows to another
                // explicitly selected owner.
                return !oracleMetadataOwner
                    || oracleMetadataOwner.toLowerCase() === targetOwner.toLowerCase();
            };
            if (queryEditorActiveRef.current) {
                setSharedCurrentDb(metadataDbName);
            }
            const metadataDbNames = collectQueryEditorReferencedDatabaseNames(
                getCurrentQuery(),
                metadataDbName,
                visibleDbs,
                metadataDialect,
            );
            if (metadataDbNames.length === 0 && connectionScopedMetadata) {
                metadataDbNames.push('');
            }
            const metadataFetchKey = [
                currentConnectionId,
                ...metadataDbNames.map((dbName) => (
                    buildQueryEditorMetadataIdentityKey(metadataDialect, dbName)
                )).sort(),
            ].join('\u0000');
            const hasCurrentDbTables = tablesRef.current.some(
                (table) => (
                    buildQueryEditorMetadataIdentityKey(metadataDialect, table.dbName)
                    === buildQueryEditorMetadataIdentityKey(metadataDialect, metadataDbName)
                ),
            );
            if (!forceMetadataReload && metadataFetchKeyRef.current === metadataFetchKey && hasCurrentDbTables) {
                if (objectDecorationsDirtyRef.current) {
                    scheduleObjectDecorationRefresh(
                        editorRef.current,
                        QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
                    );
                }
                return;
            }
            // key 相同但表为空（中途 cancel / 异常）：允许重拉
            activeFetchKey = metadataFetchKey;

            const allTables: CompletionTableMeta[] = [];
            const allColumns: CompletionColumnMeta[] = [];
            const allViews: CompletionViewMeta[] = [];
            const allMaterializedViews: CompletionViewMeta[] = [];
            const allSynonyms: CompletionSynonymMeta[] = [];
            const allTriggers: CompletionTriggerMeta[] = [];
            const allRoutines: CompletionRoutineMeta[] = [];
            const allSequences: CompletionSequenceMeta[] = [];
            const allPackages: CompletionPackageMeta[] = [];
            const runMetadataQuerySpecs = async (
                targetDbName: string,
                specs: MetadataQuerySpec[],
            ): Promise<MetadataQueryResult[]> => {
                const results = await queryCompletionMetadataRowsBySpecs(config, targetDbName, specs);
                // An empty successful catalog is valid; an empty result for a
                // non-empty spec set means every compatibility query failed and
                // must remain retryable (especially over SSH).
                if (specs.length > 0 && results.length === 0) {
                    metadataFetchFailed = true;
                }
                return results;
            };
            const syncMetadataSnapshot = () => {
                if (!isCurrentMetadataRequest()) {
                    return false;
                }
                tablesRef.current = [...allTables];
                allColumnsRef.current = [...allColumns];
                viewsRef.current = [...allViews];
                materializedViewsRef.current = [...allMaterializedViews];
                synonymsRef.current = [...allSynonyms];
                triggersRef.current = [...allTriggers];
                routinesRef.current = [...allRoutines];
                sequencesRef.current = [...allSequences];
                packagesRef.current = [...allPackages];
                if (queryEditorActiveRef.current) {
                    setSharedCurrentDb(metadataDbName);
                    setSharedTablesData(tablesRef.current);
                    setSharedAllColumnsData(allColumnsRef.current);
                    setSharedViewsData(viewsRef.current);
                    setSharedMaterializedViewsData(materializedViewsRef.current);
                    setSharedSynonymsData(synonymsRef.current);
                    setSharedTriggersData(triggersRef.current);
                    setSharedRoutinesData(routinesRef.current);
                    setSharedSequencesData(sequencesRef.current);
                    setSharedPackagesData(packagesRef.current);
                }
                return true;
            };

            const synonymSpecs = buildCompletionSynonymsMetadataQuerySpecs(metadataDialect);
            const synonymResults = await runMetadataQuerySpecs(metadataDbName, synonymSpecs);
            if (cancelled) return;
            const seenSynonyms = new Set<string>();
            collectQueryEditorSynonymMetadata({ synonymResults, metadataDialect, seenSynonyms, allSynonyms });

            for (const dbName of metadataDbNames) {
                if (cancelled) return;
                const tableComments = await fetchCompletionTableCommentMap(config, dbName, metadataDialect);
                if (cancelled) return;

                // 获取表
                let resTables: any = { success: false, data: [] };
                try {
                    resTables = await DBGetTables(buildRpcConnectionConfig(config) as any, dbName);
                } catch (error) {
                    metadataFetchFailed = true;
                    if (cancelled) return;
                    console.warn('GoNavi query editor table metadata fetch failed', error);
                }
                if (cancelled) return;
                if (!resTables?.success || !Array.isArray(resTables.data)) {
                    metadataFetchFailed = true;
                }
                if (resTables?.success && Array.isArray(resTables.data)) {
                    resTables.data.forEach((row: any) => {
                        const tableMeta = buildCompletionTableMeta(dbName, row, tableComments, metadataDialect);
                        if (tableMeta) {
                            allTables.push(tableMeta);
                        }
                    });
                }
                if (!syncMetadataSnapshot()) return;

                // 获取列 (所有数据库类型都支持 DBGetAllColumns)
                let resCols: any = { success: false, data: [] };
                try {
                    resCols = await DBGetAllColumns(buildRpcConnectionConfig(config) as any, dbName);
                } catch (error) {
                    metadataFetchFailed = true;
                    if (cancelled) return;
                    console.warn('GoNavi query editor column metadata fetch failed', error);
                }
                if (cancelled) return;
                if (!resCols?.success || !Array.isArray(resCols.data)) {
                    metadataFetchFailed = true;
                }
                collectQueryEditorColumnMetadata({
                    resCols, metadataDialect, dbName, incompleteColumnMetadataDbsRef, allColumns,
                });
                if (!syncMetadataSnapshot()) return;

                const viewSpecs = buildCompletionViewsMetadataQuerySpecs(metadataDialect, dbName, {
                        includeCurrentOwnerFallback: metadataDialect !== 'oracle'
                            || !oracleMetadataOwner
                            || oracleMetadataOwner.toLowerCase() === dbName.toLowerCase(),
                    });
                const viewResults = await runMetadataQuerySpecs(dbName, viewSpecs);
                if (cancelled) return;
                const seenViews = new Set<string>();
                collectQueryEditorViewMetadata({
                    viewResults, isMetadataRowForDatabase, dbName, metadataDialect, seenViews,
                    allViews,
                });
                if (!syncMetadataSnapshot()) return;

                const materializedViewSpecs = buildCompletionMaterializedViewsMetadataQuerySpecs(metadataDialect, dbName);
                const materializedViewResults = await runMetadataQuerySpecs(dbName, materializedViewSpecs);
                if (cancelled) return;
                const seenMaterializedViews = new Set<string>();
                collectQueryEditorMaterializedViewMetadata({
                    materializedViewResults, metadataDialect, dbName, seenMaterializedViews,
                    allMaterializedViews,
                });
                if (!syncMetadataSnapshot()) return;

                const triggerSpecs = buildCompletionTriggersMetadataQuerySpecs(metadataDialect, dbName);
                const triggerResults = await runMetadataQuerySpecs(dbName, triggerSpecs);
                if (cancelled) return;
                const seenTriggers = new Set<string>();
                collectQueryEditorTriggerMetadata({ triggerResults, metadataDialect, dbName, seenTriggers, allTriggers });
                if (!syncMetadataSnapshot()) return;

                const routineSpecs = buildCompletionFunctionsMetadataQuerySpecs(metadataDialect, dbName, {
                        includeCurrentOwnerFallback: metadataDialect !== 'oracle'
                            || !oracleMetadataOwner
                            || oracleMetadataOwner.toLowerCase() === dbName.toLowerCase(),
                    });
                const routineResults = await runMetadataQuerySpecs(dbName, routineSpecs);
                if (cancelled) return;
                const seenRoutines = new Set<string>();
                collectQueryEditorRoutineMetadata({
                    routineResults, isMetadataRowForDatabase, dbName, metadataDialect, seenRoutines,
                    allRoutines,
                });
                if (!syncMetadataSnapshot()) return;

                const sequenceSpecs = buildCompletionSequencesMetadataQuerySpecs(metadataDialect, dbName);
                const sequenceResults = await runMetadataQuerySpecs(dbName, sequenceSpecs);
                if (cancelled) return;
                const seenSequences = new Set<string>();
                collectQueryEditorSequenceMetadata({ sequenceResults, metadataDialect, dbName, seenSequences, allSequences });
                if (!syncMetadataSnapshot()) return;

                const packageSpecs = buildCompletionPackagesMetadataQuerySpecs(metadataDialect, dbName);
                const packageResults = await runMetadataQuerySpecs(dbName, packageSpecs);
                if (cancelled) return;
                const seenPackages = new Set<string>();
                collectQueryEditorPackageMetadata({ packageResults, metadataDialect, dbName, seenPackages, allPackages });
                if (!syncMetadataSnapshot()) return;
            }

            if (!syncMetadataSnapshot()) return;
            // 成功完成后才固化 key，避免 cancel 后同 key 被误判为「已完成」
            if (metadataFetchFailed) {
                // Keep the current metadata usable for hover fallback, but leave
                // the completion key empty so a later effect rerun can retry
                // transient table/column catalog failures. Keep the SQL-reference
                // marker stable; otherwise every keystroke during an SSH outage
                // would start another full-database fetch.
                metadataFetchKeyRef.current = '';
                metadataRetryPendingRef.current = true;
                refreshObjectDecorations();
                return;
            }
            metadataFetchKeyRef.current = activeFetchKey;
            metadataRetryPendingRef.current = false;
            lastSqlReferencedMetadataKeyRef.current = activeFetchKey;
            refreshObjectDecorations();
        };
        void fetchMetadata().catch((error) => {
            if (!cancelled) {
                console.warn('GoNavi query editor metadata refresh failed', error);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [
        autoFetchVisible,
        currentConnectionId,
        currentDb,
        connections,
        hasBeenActive,
        isQueryEditorMetadataRequestCurrent,
        isObjectEditQueryTab,
        queryEditorMetadataReloadTick,
        refreshObjectDecorations,
        scheduleObjectDecorationRefresh,
        sqlReferencedMetadataKey,
    ]);
};

export type QueryEditorMetadataLoadingApi = ReturnType<typeof useQueryEditorMetadataLoading>;
