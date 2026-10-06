import { useEffect } from 'react';
import {
    getTabQueryValue,
    normalizeMetadataDialect,
    resolveOracleLikeDefaultSchemaName,
    collectQueryEditorReferencedDatabaseNames,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
    type CompletionSynonymMeta,
} from '../QueryEditorHelpers';
import { DBGetDatabases } from '../../../../wailsjs/go/app/App';
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
import { resolveLoadedQueryEditorSchema } from '../queryEditorSchemaContext';
import {
    installQueryEditorHoverDdlCacheInvalidationListener,
    uninstallQueryEditorHoverDdlCacheInvalidationListener,
    type QueryEditorMetadataRequestSnapshot,
} from '../queryEditorHoverDdl';
import type { SidebarDatabaseRefreshRequest } from '../../../utils/sidebarDatabaseRefresh';
import {
    resetSharedQueryEditorMetadata,
    buildQueryEditorMetadataIdentityKey,
} from '../queryEditorCompletionTables';
import { isConnectionScopedQueryEditorMetadata } from '../queryEditorLazyTablesCache';
import {
    fetchQueryEditorDatabaseMetadata,
    fetchQueryEditorSynonymMetadata,
    type QueryEditorMetadataFetchContext,
} from '../metadata/queryEditorDatabaseMetadataFetch';
import { fetchQueryEditorSchemaContext } from '../metadata/queryEditorSchemaContextFetch';
import {
    buildQueryEditorSessionMetadataKey,
    buildQueryEditorSessionMetadataScope,
    queryEditorDatabaseMetadataSession,
    queryEditorSchemaContextSession,
    queryEditorSynonymSession,
    type QueryEditorDatabaseMetadata,
    type QueryEditorSchemaContext,
    type QueryEditorSessionFetcher,
    type QueryEditorSessionResource,
} from '../metadata/queryEditorSessionMetadataStore';
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
        const applySchemaContext = (context: QueryEditorSchemaContext, appliedSeq = requestSeq) => {
            const resolved = resolveLoadedQueryEditorSchema({
                requestSeq: appliedSeq,
                currentRequestSeq: schemaLoadSeqRef.current,
                latestSelectedSchema: latestSelectedSchemaRef.current,
                explicitSchema: String(tab.schemaName || ''),
                rememberedSchema: String(tab.schemaName || ''),
                currentSchema: context.defaultSchema,
                schemaNames: context.schemaNames,
            });
            if (!resolved) return;
            currentSchemaRef.current = resolved.selectedSchema;
            setCurrentSchema(resolved.selectedSchema);
            setSchemaList(resolved.schemaNames);
            if (resolved.selectedSchema) {
                updateQueryTabDraft(tab.id, { schemaName: resolved.selectedSchema });
            }
        };

        // 同一连接、同一库的 schema 列表在各查询页之间复用：有缓存时直接生效、不转圈，
        // 过期的缓存先用着并在后台刷新。
        const schemaSessionKey = buildQueryEditorSessionMetadataKey(currentConnectionId, conn.config, dbName);
        const cachedSchemaContext = queryEditorSchemaContextSession.read(schemaSessionKey);
        if (cachedSchemaContext) {
            applySchemaContext(cachedSchemaContext.value);
            setSchemaLoading(false);
            if (!cachedSchemaContext.stale) {
                return () => {
                    cancelled = true;
                };
            }
        } else {
            setSchemaLoading(true);
        }
        const blocksOnSchemaLoad = !cachedSchemaContext;

        // schema 列表只有两条请求，页面切走也让它跑完，下一个查询页直接用。
        const schemaLoad = queryEditorSchemaContextSession.load({
            key: schemaSessionKey,
            scope: buildQueryEditorSessionMetadataScope(currentConnectionId, dbName),
            fetch: () => fetchQueryEditorSchemaContext(conn, dbName),
        });
        void schemaLoad.promise
            .then((result) => {
                if (!result) return;
                if (blocksOnSchemaLoad) {
                    if (!cancelled) applySchemaContext(result.value);
                    return;
                }
                // 后台刷新不跟某一次 effect 绑定：只要本页还停在同一个连接和库上就应用新列表。
                if (
                    schemaContextKeyRef.current === contextKey
                    && isQueryEditorMetadataRequestCurrent({
                        generation: metadataGenerationRef.current,
                        connectionId: currentConnectionId,
                        connectionConfig: conn.config,
                    })
                ) {
                    applySchemaContext(result.value, schemaLoadSeqRef.current);
                }
            })
            .catch(() => {
                if (cancelled || !blocksOnSchemaLoad || requestSeq !== schemaLoadSeqRef.current) return;
                const fallbackSchema = String(currentSchemaRef.current || tab.schemaName || '').trim();
                setSchemaList(fallbackSchema ? [fallbackSchema] : []);
            })
            .finally(() => {
                if (blocksOnSchemaLoad && !cancelled && requestSeq === schemaLoadSeqRef.current) {
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
        isQueryEditorMetadataRequestCurrent,
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
        const releaseSessionLoads: Array<() => void> = [];
        const startBackgroundRefreshes: Array<() => void> = [];
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

            const fetchContext: QueryEditorMetadataFetchContext = { config, metadataDialect, oracleMetadataOwner };
            const buildSessionKey = (dbName: string) => buildQueryEditorSessionMetadataKey(
                currentConnectionId,
                conn.config,
                buildQueryEditorMetadataIdentityKey(metadataDialect, dbName),
                oracleMetadataOwner,
            );
            let synonyms: CompletionSynonymMeta[] = [];
            const databaseMetadata = new Map<string, QueryEditorDatabaseMetadata>();
            const syncMetadataSnapshot = () => {
                if (!isCurrentMetadataRequest()) {
                    return false;
                }
                const loaded: QueryEditorDatabaseMetadata[] = [];
                metadataDbNames.forEach((dbName) => {
                    const metadata = databaseMetadata.get(dbName);
                    if (!metadata) return;
                    loaded.push(metadata);
                    if (metadata.columnsIncomplete === undefined) return;
                    const incompleteKey = buildQueryEditorMetadataIdentityKey(metadataDialect, dbName);
                    if (metadata.columnsIncomplete) {
                        incompleteColumnMetadataDbsRef.current.add(incompleteKey);
                    } else {
                        incompleteColumnMetadataDbsRef.current.delete(incompleteKey);
                    }
                });
                tablesRef.current = loaded.flatMap((metadata) => metadata.tables);
                allColumnsRef.current = loaded.flatMap((metadata) => metadata.columns);
                viewsRef.current = loaded.flatMap((metadata) => metadata.views);
                materializedViewsRef.current = loaded.flatMap((metadata) => metadata.materializedViews);
                synonymsRef.current = [...synonyms];
                triggersRef.current = loaded.flatMap((metadata) => metadata.triggers);
                routinesRef.current = loaded.flatMap((metadata) => metadata.routines);
                sequencesRef.current = loaded.flatMap((metadata) => metadata.sequences);
                packagesRef.current = loaded.flatMap((metadata) => metadata.packages);
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

            // 其它查询页已经加载过的库直接复用；过期的先用着，等本页可用后再在后台刷新。
            // apply 返回 false 表示本次请求已不是当前上下文。
            const loadSessionMetadata = async <T,>(
                session: QueryEditorSessionResource<T>,
                dbName: string,
                fetch: QueryEditorSessionFetcher<T>,
                apply: (value: T) => boolean,
            ): Promise<boolean> => {
                const key = buildSessionKey(dbName);
                const scope = buildQueryEditorSessionMetadataScope(currentConnectionId, dbName);
                const cached = session.read(key);
                if (cached) {
                    if (cached.stale) {
                        startBackgroundRefreshes.push(() => {
                            // 刷新不跟本次 effect 绑定：跑完后让本页从更新后的缓存重新装配一次（不再发请求）。
                            void session.load({ key, scope, fetch, keepAlive: true }).promise.then((result) => {
                                if (!result?.cacheable || !isQueryEditorMetadataRequestCurrent(metadataSnapshot)) return;
                                metadataFetchKeyRef.current = '';
                                setQueryEditorMetadataReloadTick((tick) => tick + 1);
                            }, () => undefined);
                        });
                    }
                    return apply(cached.value);
                }
                const load = session.load({
                    key,
                    scope,
                    fetch,
                    onProgress: (partial) => {
                        apply(partial);
                    },
                });
                releaseSessionLoads.push(load.release);
                const result = await load.promise;
                if (cancelled) return false;
                if (!result?.cacheable) {
                    metadataFetchFailed = true;
                }
                return result ? apply(result.value) : true;
            };

            const synonymsLoaded = await loadSessionMetadata(
                queryEditorSynonymSession,
                metadataDbName,
                () => fetchQueryEditorSynonymMetadata(fetchContext, metadataDbName),
                (value) => {
                    synonyms = value;
                    return !cancelled;
                },
            );
            if (!synonymsLoaded) return;

            for (const dbName of metadataDbNames) {
                if (cancelled) return;
                const databaseLoaded = await loadSessionMetadata(
                    queryEditorDatabaseMetadataSession,
                    dbName,
                    (report, shouldStop) => fetchQueryEditorDatabaseMetadata(fetchContext, dbName, report, shouldStop),
                    (value) => {
                        databaseMetadata.set(dbName, value);
                        return syncMetadataSnapshot();
                    },
                );
                if (!databaseLoaded) return;
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
        }).finally(() => {
            startBackgroundRefreshes.forEach((start) => start());
        });
        return () => {
            cancelled = true;
            releaseSessionLoads.forEach((release) => release());
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
