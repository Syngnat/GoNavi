import { useCallback, useEffect } from 'react';
import { message } from 'antd';
import {
    type QueryEditorAiEditorSnapshot,
    type QueryEditorAiContext,
    resolveQueryEditorInlineCompletionIntentDetails,
} from '../QueryEditorAiAssist';
import {
    normalizeEditorPosition,
    normalizeMetadataDialect,
    type CompletionTableMeta,
    type CompletionColumnMeta,
    normalizeCommentText,
} from '../QueryEditorHelpers';
import {
    queryEditorLazyTablesCache as boundedLazyTablesCache,
    buildQueryEditorLazyTablesCacheKey as buildBoundedLazyTablesCacheKey,
    buildQueryEditorMetadataCacheScope,
} from '../queryEditorMetadataCaches';
import {
    sharedTablesData,
    sharedAllColumnsData,
    setSharedTablesData,
    setSharedAllColumnsData,
    sharedQueryEditorMetadataContextKey,
    sharedQueryEditorMetadataConnectionConfig,
    setSharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataGeneration,
    setSharedQueryEditorMetadataContextKey,
    setSharedQueryEditorMetadataConnectionConfig,
    setSharedCurrentDb,
    setSharedCurrentConnectionId,
    setSharedCurrentSchema,
    setSharedConnections,
    setSharedVisibleDbs,
    setSharedViewsData,
    setSharedMaterializedViewsData,
    setSharedSynonymsData,
    setSharedTriggersData,
    setSharedRoutinesData,
    setSharedSequencesData,
    setSharedPackagesData,
    setSharedActiveEditorModelUri,
} from '../queryEditorCompletionState';
import { peekDatabaseServerVersion } from '../queryEditorServerVersion';
import {
    buildQueryEditorMetadataIdentityKey,
    fetchCompletionTableCommentMap,
    buildCompletionTableMeta,
    buildCompletionTableMetadataIdentityKey,
} from '../queryEditorCompletionTables';
import {
    buildCompletionColumnMetadataIdentityKey,
    shouldRefreshQueryEditorCompletionColumns,
} from '../queryEditorCompletionColumns';
import { resolveQueryEditorAiConnectionHost } from '../queryEditorAiContext';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import {
    isConnectionScopedQueryEditorMetadata,
    buildSharedLazyTablesCacheKey,
    getSharedLazyTablesRevision,
    mirrorColumnsCacheIntoBoundedCache,
} from '../queryEditorLazyTablesCache';
import type { QueryEditorMetadataRequestSnapshot } from '../queryEditorHoverDdl';
import { DBGetTables, DBGetAllColumns } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    isTableMetadataIncomplete,
    getTableMetadataIssueDetail,
} from '../../../utils/tableMetadataResult';
import { persistQueryTabDraftSnapshot, clearQueryTabDraft } from '../../../utils/sqlFileTabDrafts';
import { useStore } from '../../../store';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorAiContextInput {
    editorRef: QueryEditorCoreStateApi['editorRef'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    tab: QueryEditorProps['tab'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    allColumnsRef: QueryEditorCoreStateApi['allColumnsRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    appearance: QueryEditorCoreStateApi['appearance'];
    aiContextCacheRef: QueryEditorCoreStateApi['aiContextCacheRef'];
    incompleteColumnMetadataDbsRef: QueryEditorCoreStateApi['incompleteColumnMetadataDbsRef'];
    metadataGenerationRef: QueryEditorCoreStateApi['metadataGenerationRef'];
    aiContextMetadataWarmupRef: QueryEditorCoreStateApi['aiContextMetadataWarmupRef'];
    isQueryEditorMetadataRequestCurrent: QueryEditorConnectionContextApi['isQueryEditorMetadataRequestCurrent'];
    isExternalSQLFileTab: QueryEditorCoreStateApi['isExternalSQLFileTab'];
    draftSnapshotTab: QueryEditorConnectionContextApi['draftSnapshotTab'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    connections: QueryEditorConnectionContextApi['connections'];
    currentSchema: QueryEditorCoreStateApi['currentSchema'];
    viewsRef: QueryEditorCoreStateApi['viewsRef'];
    materializedViewsRef: QueryEditorCoreStateApi['materializedViewsRef'];
    synonymsRef: QueryEditorCoreStateApi['synonymsRef'];
    triggersRef: QueryEditorCoreStateApi['triggersRef'];
    routinesRef: QueryEditorCoreStateApi['routinesRef'];
    sequencesRef: QueryEditorCoreStateApi['sequencesRef'];
    packagesRef: QueryEditorCoreStateApi['packagesRef'];
    columnsCacheRef: QueryEditorConnectionContextApi['columnsCacheRef'];
    switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
}

export const useQueryEditorAiContext = ({
    editorRef, getCurrentQuery, tab, currentConnectionIdRef, currentConnectionId, connectionsRef,
    currentDbRef, currentDb, tablesRef, allColumnsRef, visibleDbsRef, appearance, aiContextCacheRef,
    incompleteColumnMetadataDbsRef, metadataGenerationRef, aiContextMetadataWarmupRef,
    isQueryEditorMetadataRequestCurrent, isExternalSQLFileTab, draftSnapshotTab, isActive,
    connections, currentSchema, viewsRef, materializedViewsRef, synonymsRef, triggersRef,
    routinesRef, sequencesRef, packagesRef, columnsCacheRef, switchQueryContext,
}: UseQueryEditorAiContextInput) => {
    const buildQueryEditorAiEditorSnapshot = useCallback((): QueryEditorAiEditorSnapshot => {
        const editor = editorRef.current;
        const model = editor?.getModel?.();
        const position = normalizeEditorPosition(editor?.getPosition?.());
        const value = String(model?.getValue?.() ?? getCurrentQuery() ?? '');
        if (!model || !position || typeof model.getOffsetAt !== 'function') {
            return {
                prefix: value,
                suffix: '',
                currentLineBeforeCursor: value.split(/\r?\n/).pop() || '',
                currentLineAfterCursor: '',
            };
        }

        const offset = Number(model.getOffsetAt(position));
        const safeOffset = Number.isFinite(offset)
            ? Math.max(0, Math.min(offset, value.length))
            : value.length;
        const lineContent = String(model.getLineContent?.(position.lineNumber) || '');
        const lineColumnIndex = Math.max(0, Math.min(position.column - 1, lineContent.length));
        return {
            prefix: value.slice(0, safeOffset),
            suffix: value.slice(safeOffset),
            currentLineBeforeCursor: lineContent.slice(0, lineColumnIndex),
            currentLineAfterCursor: lineContent.slice(lineColumnIndex),
        };
    }, [getCurrentQuery]);

    const buildQueryEditorAiContext = useCallback((): QueryEditorAiContext => {
        const resolvedConnectionId = String(
            currentConnectionIdRef.current
            || currentConnectionId
            || tab.connectionId
            || '',
        ).trim();
        const conn = connectionsRef.current.find(c => c.id === resolvedConnectionId);
        const currentDbName = String(
            currentDbRef.current
            ?? currentDb
            ?? tab.dbName
            ?? '',
        ).trim();
        const metadataDialect = normalizeMetadataDialect(conn);
        const lazyTablesEntry = boundedLazyTablesCache.get(buildBoundedLazyTablesCacheKey(
            resolvedConnectionId,
            currentDbName,
            metadataDialect,
        ));

        // 大库下全量合并可达数十万条且每次补全请求都会调用；依赖引用未变时复用上次结果，
        // 同时保持 tables/columns 数组身份稳定，让下游按数组身份缓存的索引也能跨请求复用。
        const cacheDeps: unknown[] = [
            resolvedConnectionId,
            conn,
            currentDbName,
            lazyTablesEntry,
            sharedTablesData,
            tablesRef.current,
            sharedAllColumnsData,
            allColumnsRef.current,
            visibleDbsRef.current,
            appearance.customTableAliasPrefixEnabled,
            appearance.customTableAliasPrefix,
            peekDatabaseServerVersion(resolvedConnectionId),
        ];
        const cached = aiContextCacheRef.current;
        if (cached && cached.deps.every((dep, index) => dep === cacheDeps[index])) {
            return cached.value;
        }

        const lazyTables = lazyTablesEntry || [];
        const mergedTablesByKey = new Map<string, CompletionTableMeta>();
        [...sharedTablesData, ...tablesRef.current, ...lazyTables].forEach((table) => {
            const tableKey = buildQueryEditorMetadataIdentityKey(
                metadataDialect,
                table?.dbName,
                table?.tableName,
            );
            if (!tableKey.trim()) {
                return;
            }
            mergedTablesByKey.set(tableKey, table);
        });
        const mergedColumnsByKey = new Map<string, CompletionColumnMeta>();
        [...sharedAllColumnsData, ...allColumnsRef.current].forEach((column) => {
            const columnKey = buildCompletionColumnMetadataIdentityKey(
                metadataDialect,
                column?.dbName || '',
                column?.tableName || '',
                column?.name || '',
            );
            if (!columnKey.trim()) {
                return;
            }
            mergedColumnsByKey.set(columnKey, column);
        });
        const value: QueryEditorAiContext = {
            connectionId: resolvedConnectionId,
            connectionName: conn?.name,
            host: resolveQueryEditorAiConnectionHost(conn),
            port: conn?.config?.port,
            sourceType: conn?.config?.type,
            sqlDialect: resolveSqlDialect(
                String(conn?.config?.type || ''),
                String(conn?.config?.driver || ''),
                { oceanBaseProtocol: conn?.config?.oceanBaseProtocol },
            ),
            tableAliasPrefix: appearance.customTableAliasPrefixEnabled
                ? appearance.customTableAliasPrefix
                : '',
            currentDb: currentDbName,
            visibleDbs: visibleDbsRef.current,
            tables: [...mergedTablesByKey.values()],
            columns: [...mergedColumnsByKey.values()],
            databaseVersion: peekDatabaseServerVersion(resolvedConnectionId),
        };
        aiContextCacheRef.current = { deps: cacheDeps, value };
        return value;
    }, [
        appearance.customTableAliasPrefix,
        appearance.customTableAliasPrefixEnabled,
        currentConnectionId,
        currentDb,
        tab.connectionId,
        tab.dbName,
    ]);

    const ensureQueryEditorAiContextMetadata = useCallback(async (
        editorSnapshot: QueryEditorAiEditorSnapshot,
    ): Promise<void> => {
        const connectionId = String(
            currentConnectionIdRef.current
            || currentConnectionId
            || tab.connectionId
            || '',
        ).trim();
        const dbName = String(
            currentDbRef.current
            ?? currentDb
            ?? tab.dbName
            ?? '',
        ).trim();
        const contextConnection = connectionsRef.current.find((item) => item.id === connectionId);
        if (!connectionId || !contextConnection || (!dbName && !isConnectionScopedQueryEditorMetadata(contextConnection))) {
            return;
        }

        const metadataDialect = normalizeMetadataDialect(contextConnection);
        const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot, metadataDialect);
        const normalizedDbName = buildQueryEditorMetadataIdentityKey(metadataDialect, dbName);
        const needsTables = intent.intent === 'table_name'
            || !tablesRef.current.some((table) => (
                buildQueryEditorMetadataIdentityKey(metadataDialect, table.dbName) === normalizedDbName
            ));
        const hasColumnsForDatabase = allColumnsRef.current.some(
            (column) => buildQueryEditorMetadataIdentityKey(metadataDialect, column.dbName) === normalizedDbName,
        );
        const needsColumns = shouldRefreshQueryEditorCompletionColumns(
            intent.intent,
            hasColumnsForDatabase,
            incompleteColumnMetadataDbsRef.current.has(normalizedDbName),
        );
        if (!needsTables && !needsColumns) {
            return;
        }

        const metadataGeneration = metadataGenerationRef.current;
        const lazyTablesCacheKey = buildSharedLazyTablesCacheKey(
            connectionId,
            dbName,
            metadataDialect,
        );
        const lazyTablesCacheRevision = getSharedLazyTablesRevision(lazyTablesCacheKey);
        const warmupKey = `${connectionId}\u0000${normalizedDbName}\u0000${needsTables ? 'tables' : ''}\u0000${needsColumns ? 'columns' : ''}\u0000${metadataGeneration}`;
        const existingWarmup = aiContextMetadataWarmupRef.current[warmupKey];
        if (existingWarmup) {
            await existingWarmup;
            return;
        }

        const warmupPromise = (async (): Promise<boolean> => {
            const conn = connectionsRef.current.find((item) => item.id === connectionId);
            if (!conn) {
                return false;
            }
            const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                generation: metadataGeneration,
                connectionId,
                connectionConfig: conn.config,
            };
            const isCurrentMetadataRequest = () => (
                isQueryEditorMetadataRequestCurrent(metadataSnapshot)
            );
            let warmupSucceeded = true;

            const config = {
                ...conn.config,
                port: Number(conn.config.port),
                password: conn.config.password || '',
                database: conn.config.database || '',
                useSSH: conn.config.useSSH || false,
                ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            };

            if (needsTables) {
                try {
                    if (!isCurrentMetadataRequest()) {
                        return false;
                    }
                    const [tableComments, resTables] = await Promise.all([
                        fetchCompletionTableCommentMap(config, dbName, metadataDialect).catch(() => new Map<string, string>()),
                        DBGetTables(buildRpcConnectionConfig(config) as any, dbName),
                    ]);
                    if (!isCurrentMetadataRequest()) {
                        return false;
                    }
                    if (!resTables?.success) {
                        warmupSucceeded = false;
                    }
                    if (resTables?.success && Array.isArray(resTables.data)) {
                        const fetchedTables = resTables.data
                            .map((row: any) => buildCompletionTableMeta(dbName, row, tableComments, metadataDialect))
                            .filter((table): table is CompletionTableMeta => !!table);
                        if (fetchedTables.length > 0) {
                            const nextTableByKey = new Map(
                                tablesRef.current.map((table) => [
                                    buildCompletionTableMetadataIdentityKey(
                                        metadataDialect,
                                        table.dbName,
                                        table.tableName,
                                    ),
                                    table,
                                ]),
                            );
                            fetchedTables.forEach((table) => {
                                nextTableByKey.set(
                                    buildCompletionTableMetadataIdentityKey(
                                        metadataDialect,
                                        table.dbName,
                                        table.tableName,
                                    ),
                                    table,
                                );
                            });
                            tablesRef.current = [...nextTableByKey.values()];
                            setSharedTablesData(tablesRef.current);
                            if (getSharedLazyTablesRevision(lazyTablesCacheKey) === lazyTablesCacheRevision) {
                                boundedLazyTablesCache.set(
                                    lazyTablesCacheKey,
                                    buildQueryEditorMetadataCacheScope(
                                        connectionId,
                                        buildQueryEditorMetadataIdentityKey(metadataDialect, dbName),
                                    ),
                                    fetchedTables,
                                );
                            }
                        }
                    }
                } catch (error) {
                    warmupSucceeded = false;
                    console.warn('GoNavi AI inline table metadata warmup failed', error);
                }
            }

            if (needsColumns) {
                try {
                    if (!isCurrentMetadataRequest()) {
                        return false;
                    }
                    const resCols = await DBGetAllColumns(buildRpcConnectionConfig(config) as any, dbName);
                    if (!isCurrentMetadataRequest()) {
                        return false;
                    }
                    if (!resCols?.success) {
                        warmupSucceeded = false;
                    }
                    if (resCols?.success && Array.isArray(resCols.data)) {
                        const incomplete = isTableMetadataIncomplete(resCols);
                        if (incomplete) {
                            message.warning(getTableMetadataIssueDetail(resCols));
                            incompleteColumnMetadataDbsRef.current.add(normalizedDbName);
                            warmupSucceeded = false;
                        } else {
                            incompleteColumnMetadataDbsRef.current.delete(normalizedDbName);
                        }
                        const fetchedColumns = resCols.data.map((col: any) => ({
                            dbName,
                            tableName: col.tableName,
                            name: col.name,
                            type: col.type,
                            comment: normalizeCommentText(col.comment ?? col.Comment ?? col.COLUMN_COMMENT ?? col.column_comment ?? ''),
                        }));
                        if (fetchedColumns.length > 0) {
                            const nextColumnByKey = new Map(
                                allColumnsRef.current.map((column) => [
                                    buildCompletionColumnMetadataIdentityKey(
                                        metadataDialect,
                                        column.dbName,
                                        column.tableName,
                                        column.name,
                                    ),
                                    column,
                                ]),
                            );
                            fetchedColumns.forEach((column) => {
                                nextColumnByKey.set(
                                    buildCompletionColumnMetadataIdentityKey(
                                        metadataDialect,
                                        column.dbName,
                                        column.tableName,
                                        column.name,
                                    ),
                                    column,
                                );
                            });
                            allColumnsRef.current = [...nextColumnByKey.values()];
                            setSharedAllColumnsData(allColumnsRef.current);
                        }
                    }
                } catch (error) {
                    warmupSucceeded = false;
                    console.warn('GoNavi AI inline column metadata warmup failed', error);
                }
            }
            return warmupSucceeded;
        })();

        // 成功的 warmup 结果整个会话内复用，避免每次内联补全都真实查库；失败时删除缓存以便重试。
        aiContextMetadataWarmupRef.current[warmupKey] = warmupPromise;
        let warmupSucceeded = false;
        try {
            warmupSucceeded = await warmupPromise;
        } finally {
            if (!warmupSucceeded) {
                delete aiContextMetadataWarmupRef.current[warmupKey];
            }
        }
    }, [currentConnectionId, currentDb, isQueryEditorMetadataRequestCurrent, tab.connectionId, tab.dbName]);

    useEffect(() => {
        if (!isExternalSQLFileTab) return;
        persistQueryTabDraftSnapshot(draftSnapshotTab, getCurrentQuery(), {
            connectionId: currentConnectionIdRef.current,
            dbName: currentDbRef.current,
        });
        return () => {
            const tabStillExists = useStore.getState().tabs.some((item) => item.id === draftSnapshotTab.id);
            if (tabStillExists) {
                persistQueryTabDraftSnapshot(draftSnapshotTab, getCurrentQuery(), {
                    connectionId: currentConnectionIdRef.current,
                    dbName: currentDbRef.current,
                });
            } else {
                clearQueryTabDraft(draftSnapshotTab.id);
            }
        };
    }, [draftSnapshotTab, getCurrentQuery, isExternalSQLFileTab]);

    // 当此 Tab 成为活跃 Tab 时，将本实例的状态同步到模块级共享变量
    // 确保 completion provider 始终使用当前活跃 Tab 的上下文
    useEffect(() => {
        if (!isActive) return;
        const activeConnectionConfig = connections.find(
            (connection) => connection.id === currentConnectionId,
        )?.config ?? null;
        const nextSharedMetadataContextKey = `${tab.id}\u0000${currentConnectionId}\u0000${currentDb}\u0000${currentSchema}`;
        if (
            sharedQueryEditorMetadataContextKey !== nextSharedMetadataContextKey
            || sharedQueryEditorMetadataConnectionConfig !== activeConnectionConfig
        ) {
            setSharedQueryEditorMetadataGeneration(sharedQueryEditorMetadataGeneration + 1);
            setSharedQueryEditorMetadataContextKey(nextSharedMetadataContextKey);
            setSharedQueryEditorMetadataConnectionConfig(activeConnectionConfig);
        }
        setSharedCurrentDb(currentDb);
        setSharedCurrentConnectionId(currentConnectionId);
        setSharedCurrentSchema(currentSchema);
        setSharedConnections(connections);
        setSharedTablesData(tablesRef.current);
        setSharedAllColumnsData(allColumnsRef.current);
        setSharedVisibleDbs(visibleDbsRef.current);
        setSharedViewsData(viewsRef.current);
        setSharedMaterializedViewsData(materializedViewsRef.current);
        setSharedSynonymsData(synonymsRef.current);
        setSharedTriggersData(triggersRef.current);
        setSharedRoutinesData(routinesRef.current);
        setSharedSequencesData(sequencesRef.current);
        setSharedPackagesData(packagesRef.current);
        mirrorColumnsCacheIntoBoundedCache(columnsCacheRef.current);
        setSharedActiveEditorModelUri(String(editorRef.current?.getModel?.()?.uri?.toString?.() || ''));
    }, [isActive, currentDb, currentConnectionId, currentSchema, connections, tab.id]);

    useEffect(() => {
        connectionsRef.current = connections;
    }, [connections]);

    const handleDatabaseChange = useCallback((dbName: string) => {
        void switchQueryContext(currentConnectionIdRef.current, dbName);
    }, [switchQueryContext]);
    return {
        buildQueryEditorAiEditorSnapshot, buildQueryEditorAiContext,
        ensureQueryEditorAiContextMetadata, handleDatabaseChange,
    };
};

export type QueryEditorAiContextApi = ReturnType<typeof useQueryEditorAiContext>;
