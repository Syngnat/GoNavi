import {
    sharedCurrentConnectionId, sharedConnections, sharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataContextKey, sharedLazyTablesInFlight, sharedTablesData,
    setSharedTablesData, sharedAllColumnsData, setSharedAllColumnsData, sharedSynonymsData,
} from '../queryEditorCompletionState';
import {
    isConnectionScopedQueryEditorMetadata, buildSharedLazyTablesCacheKey,
    getSharedLazyTablesRevision, isSqlCompletionRequestCancelled,
} from '../queryEditorLazyTablesCache';
import {
    type CompletionTableMeta, normalizeMetadataDialect, type CompletionColumnMeta,
    type CompletionSynonymMeta,
} from '../QueryEditorHelpers';
import {
    queryEditorLazyTablesCache as boundedLazyTablesCache, buildQueryEditorMetadataCacheScope,
    queryEditorColumnsCache as boundedColumnsCache,
} from '../queryEditorMetadataCaches';
import {
    type QueryEditorMetadataRequestSnapshot, isSharedQueryEditorMetadataRequestCurrent,
    normalizeQueryEditorTableTargetName,
} from '../queryEditorHoverDdl';
import {
    fetchCompletionTableCommentMap, buildCompletionTableMeta,
    buildCompletionTableMetadataIdentityKey, buildQueryEditorMetadataIdentityKey,
} from '../queryEditorCompletionTables';
import { DBGetTables, DBGetColumns } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { buildMetadataIdentityKey } from '../../../utils/metadataIdentity';
import type { ColumnDefinition } from '../../../types';
import {
    dedupeCompletionColumnsByName, findSharedPreloadedColumns,
    buildCompletionColumnMetadataIdentityKey,
} from '../queryEditorCompletionColumns';
import {
    getColumnDefinitionName, getColumnDefinitionType, getColumnDefinitionComment,
} from '../../../utils/columnDefinition';
import type { createSqlCompletionSuggestionBuilders } from './sqlCompletionSuggestionBuilders';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';

export interface CreateSqlCompletionMetadataLookupsInput {
    buildConnConfig: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildConnConfig'];
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    splitSchemaAndTable: ReturnType<typeof createSqlCompletionDialectContext>['splitSchemaAndTable'];
    oracleLoginOwner: ReturnType<typeof createSqlCompletionDialectContext>['oracleLoginOwner'];
    activeConnectionHasScopedMetadata: ReturnType<typeof createSqlCompletionDialectContext>['activeConnectionHasScopedMetadata'];
    token: { isCancellationRequested?: boolean; } | undefined;
}

export const createSqlCompletionMetadataLookups = ({
    buildConnConfig, activeDialect, splitSchemaAndTable, oracleLoginOwner,
    activeConnectionHasScopedMetadata, token,
}: CreateSqlCompletionMetadataLookupsInput) => {
    const getLazyTablesByDB = async (dbName: string) => {
        const connId = sharedCurrentConnectionId;
        const conn = sharedConnections.find(c => c.id === connId);
        if (!connId || !conn || (!dbName && !isConnectionScopedQueryEditorMetadata(conn))) {
            return [] as CompletionTableMeta[];
        }
        const metadataDialect = normalizeMetadataDialect(conn);
        const cacheKey = buildSharedLazyTablesCacheKey(
            connId,
            dbName,
            metadataDialect,
        );
        const boundedCachedTables = boundedLazyTablesCache.get(cacheKey);
        if (boundedCachedTables) {
            return boundedCachedTables;
        }
        const cacheRevision = getSharedLazyTablesRevision(cacheKey);
            const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                generation: sharedQueryEditorMetadataGeneration,
                connectionId: connId,
                connectionConfig: conn.config,
            };
            const metadataContextKey = sharedQueryEditorMetadataContextKey;
            const inFlightKey = `${cacheKey}|${metadataSnapshot.generation}`;
            if (sharedLazyTablesInFlight[inFlightKey]) {
                return sharedLazyTablesInFlight[inFlightKey];
            }

            const config = buildConnConfig();
            if (!config) return [] as CompletionTableMeta[];

            const request = Promise.all([
                fetchCompletionTableCommentMap(config, dbName, metadataDialect),
                DBGetTables(buildRpcConnectionConfig(config) as any, dbName),
            ])
                .then(([tableComments, res]) => {
                    if (
                        !isSharedQueryEditorMetadataRequestCurrent(metadataSnapshot, metadataContextKey)
                        || getSharedLazyTablesRevision(cacheKey) !== cacheRevision
                    ) {
                        return [];
                    }
                    // Do not memoize a failed metadata request as an
                    // empty catalog. A transient SSH/driver failure must
                    // remain retryable on the next completion request;
                    // only a confirmed successful empty result is safe to
                    // cache.
                    if (!res?.success || !Array.isArray(res.data)) {
                        return [];
                    }
                    const tables = res.data
                        .map((row: any) => buildCompletionTableMeta(
                            dbName,
                            row,
                            tableComments,
                            metadataDialect,
                        ))
                        .filter((table): table is CompletionTableMeta => !!table);
                    boundedLazyTablesCache.set(
                        cacheKey,
                        buildQueryEditorMetadataCacheScope(
                            connId,
                            buildMetadataIdentityKey(metadataDialect, dbName),
                        ),
                        tables,
                    );
                    if (tables.length > 0) {
                        const lazyTableByKey = new Map(tables.map((table) => [
                            buildCompletionTableMetadataIdentityKey(
                                metadataDialect,
                                table.dbName,
                                table.tableName,
                            ),
                            table,
                        ]));
                        const existingKeys = new Set<string>();
                        let changed = false;
                        const nextSharedTables = sharedTablesData.map((table) => {
                            const tableKey = buildCompletionTableMetadataIdentityKey(
                                metadataDialect,
                                table.dbName,
                                table.tableName,
                            );
                            existingKeys.add(tableKey);
                            const lazyTable = lazyTableByKey.get(tableKey);
                            if (lazyTable?.comment && lazyTable.comment !== table.comment) {
                                changed = true;
                                return { ...table, comment: lazyTable.comment };
                            }
                            return table;
                        });
                        const missingTables = tables.filter((table) => !existingKeys.has(
                            buildCompletionTableMetadataIdentityKey(
                                metadataDialect,
                                table.dbName,
                                table.tableName,
                            ),
                        ));
                        if (missingTables.length > 0) {
                            changed = true;
                            nextSharedTables.push(...missingTables);
                        }
                        if (changed) {
                            setSharedTablesData(nextSharedTables);
                        }
                    }
                    return tables;
                })
                .catch(() => [])
                .finally(() => {
                    if (sharedLazyTablesInFlight[inFlightKey] === request) {
                        delete sharedLazyTablesInFlight[inFlightKey];
                    }
                });
            sharedLazyTablesInFlight[inFlightKey] = request;
            return request;
        };

        const toCompletionColumns = (
            columns: ColumnDefinition[],
            dbName: string,
            tableName: string,
        ): CompletionColumnMeta[] => dedupeCompletionColumnsByName(columns
            .map((column) => ({
                dbName,
                tableName,
                name: getColumnDefinitionName(column),
                type: getColumnDefinitionType(column),
                comment: getColumnDefinitionComment(column),
            }))
            .filter((column) => !!column.name), activeDialect);

        const findPreloadedColumns = (dbName: string, tableName: string) =>
            findSharedPreloadedColumns(activeDialect, dbName, tableName);

        const mergeSharedCompletionColumns = (columns: CompletionColumnMeta[]) => {
            if (columns.length === 0) return;
            const existingKeys = new Set(sharedAllColumnsData.map((column) => (
                buildCompletionColumnMetadataIdentityKey(
                    activeDialect,
                    column.dbName,
                    column.tableName,
                    column.name,
                )
            )));
            const missing = columns.filter((column) => {
                const key = buildCompletionColumnMetadataIdentityKey(
                    activeDialect,
                    column.dbName,
                    column.tableName,
                    column.name,
                );
                if (existingKeys.has(key)) return false;
                existingKeys.add(key);
                return true;
            });
            if (missing.length > 0) {
                setSharedAllColumnsData([...sharedAllColumnsData, ...missing]);
            }
        };

        const findCompletionSynonym = (
            tableIdent: string,
            explicitOwnerName = '',
        ): CompletionSynonymMeta | undefined => {
            const parsed = splitSchemaAndTable(tableIdent);
            const synonymName = String(parsed.table || tableIdent).trim().toLowerCase();
            if (!synonymName) return undefined;
            const matches = sharedSynonymsData.filter((synonym) => (
                String(synonym.synonymName || '').trim().toLowerCase() === synonymName
            ));
            if (matches.length === 0) return undefined;

            const explicitOwner = String(explicitOwnerName || parsed.schema || '').trim().toLowerCase();
            if (explicitOwner) {
                return matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === explicitOwner);
            }

            const loginOwner = oracleLoginOwner.trim().toLowerCase();
            return matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === loginOwner)
                || matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === 'public');
        };

        const getCompletionColumnsByTable = async (
            dbName: string,
            tableIdent: string,
            explicitOwnerName = '',
        ) => {
            const connId = sharedCurrentConnectionId;
            const conn = sharedConnections.find(c => c.id === connId);
            const targetDb = String(dbName || '').trim();
            const targetTable = String(tableIdent || '').trim();
            const connectionScopedMetadata = isConnectionScopedQueryEditorMetadata(conn);
            if (!connId || !conn || (!targetDb && !connectionScopedMetadata) || !targetTable) {
                return [] as CompletionColumnMeta[];
            }

            const synonym = findCompletionSynonym(targetTable, explicitOwnerName);
            const lookupDbName = String(synonym?.ownerName || targetDb).trim();
            const lookupTableName = String(synonym?.synonymName || targetTable).trim();
            const preloaded = synonym ? [] : findPreloadedColumns(targetDb, targetTable);
            if (preloaded.length > 0) {
                return preloaded;
            }

            const key = [
                connId,
                buildQueryEditorMetadataIdentityKey(activeDialect, lookupDbName),
                normalizeQueryEditorTableTargetName(lookupTableName, activeDialect),
            ].join('|');
            const cached = boundedColumnsCache.get(key) as ColumnDefinition[] | undefined;
            if (cached) {
                const cachedColumns = toCompletionColumns(cached, targetDb, targetTable);
                mergeSharedCompletionColumns(cachedColumns);
                return cachedColumns;
            }

            const config = buildConnConfig();
            if (!config) return [] as CompletionColumnMeta[];
            const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                generation: sharedQueryEditorMetadataGeneration,
                connectionId: connId,
                connectionConfig: conn.config,
            };
            const metadataContextKey = sharedQueryEditorMetadataContextKey;

            const res = await DBGetColumns(buildRpcConnectionConfig(config) as any, lookupDbName, lookupTableName);
            if (!isSharedQueryEditorMetadataRequestCurrent(metadataSnapshot, metadataContextKey)) {
                return [] as CompletionColumnMeta[];
            }
            if (res?.success && Array.isArray(res.data)) {
                const cols = res.data as ColumnDefinition[];
                boundedColumnsCache.set(
                    key,
                    buildQueryEditorMetadataCacheScope(sharedCurrentConnectionId, ''),
                    cols,
                );
                const completionColumns = toCompletionColumns(cols, targetDb, targetTable);
                mergeSharedCompletionColumns(completionColumns);
                return completionColumns;
            }
            return [] as CompletionColumnMeta[];
        };

        const getCompletionColumnsForAlias = async (
            tableInfo: { dbName: string; tableName: string; explicitOwnerName?: string },
            currentDatabase: string,
        ): Promise<CompletionColumnMeta[]> => {
            const explicitOwner = String(tableInfo.explicitOwnerName || '').trim();
            const explicitDatabaseTarget = {
                dbName: String(tableInfo.dbName || ''),
                tableName: String(tableInfo.tableName || ''),
                explicitOwnerName: explicitOwner,
            };
            const currentSchemaTarget = {
                dbName: currentDatabase,
                tableName: `${explicitOwner}.${tableInfo.tableName}`,
                explicitOwnerName: explicitOwner,
            };
            const schemaQualifiedAliasDialect = [
                'postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb',
                'sqlserver', 'sqlite', 'duckdb', 'iris', 'trino',
            ].includes(activeDialect);
            const targets = schemaQualifiedAliasDialect
                && explicitOwner
                && (currentDatabase || activeConnectionHasScopedMetadata)
                ? [currentSchemaTarget]
                : [explicitDatabaseTarget];
            if (
                explicitOwner
                && String(tableInfo.dbName || '').trim().toLowerCase() !== currentDatabase.toLowerCase()
                && currentDatabase
                && (!activeDialect || activeDialect === 'unknown')
            ) {
                targets.push(currentSchemaTarget);
            }

            for (const target of targets) {
                const columns = await getCompletionColumnsByTable(
                    target.dbName,
                    target.tableName,
                    target.explicitOwnerName,
                );
                if (isSqlCompletionRequestCancelled(token)) return [];
                if (columns.length > 0) return columns;
            }
            return [];
        };
    return {
        getLazyTablesByDB, getCompletionColumnsByTable, getCompletionColumnsForAlias,
    };
};
