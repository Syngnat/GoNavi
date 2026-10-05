import { t } from '../../i18n';
import { message, Button } from 'antd';
import { resolveSidebarMessageQueueProfile } from './sidebarMessageProfiles';
import { type SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import {
  GnFolderOpenIcon,
  GnSqlDocIcon,
} from '../icons/gnIcons';
import {
  DBGetObjects,
  DBQuery,
  DBGetTables,
  DBRefreshTableStats,
} from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { ensureTableStatsServerVersion } from './sidebarTableStatsVersion';
import { needsServerVersionForTableStats } from '../../utils/dataSourceRegistry/tableStats';
import { useStore } from '../../store';
import {
  buildSidebarMessageObjectNodes,
  type SidebarLoadedTableMetadata,
  type SidebarLoadedTableEntry,
  SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS,
  applyRefreshedSQLiteStatsToTree,
  type SidebarTreeLoadOptions,
  scheduleSidebarLoad,
} from './sidebarTreeLoaderHelpers';
import {
  buildSidebarTableStatusSQL,
  loadSchemas,
  getMetadataDialect,
  splitQualifiedName,
  buildQualifiedName,
  getCaseInsensitiveValue,
  getSidebarTableName,
  parseSidebarTableRowCount,
  loadViews,
  loadStarRocksMaterializedViews,
  loadDatabaseTriggers,
  loadFunctions,
  loadSequences,
  loadPackages,
  loadDatabaseEvents,
  getMySQLShowTablesName,
  getSidebarTableDisplayName,
} from './sidebarMetadataLoaders';
import type { SavedConnection } from '../../types';
import { isPostgresSchemaDialect } from '../sidebarCoreUtils';
import {
  getSidebarTableEntryIdentity,
  getSidebarTableObjectIdentity,
} from './sidebarPartitions';
import { loadOracleDatabaseLinks } from './sidebarOracleDatabaseLinks';
import type { SidebarTreeLoadStateApi } from './useSidebarTreeLoadState';
import type { UseSidebarTreeLoadersOptions } from './useSidebarTreeLoaders';
import { createSidebarDatabaseChildrenBuilder } from './sidebarDatabaseChildren';

export interface UseSidebarTableLoaderInput {
  loadingNodesRef: UseSidebarTreeLoadersOptions['loadingNodesRef'];
  setConnectionStates: UseSidebarTreeLoadersOptions['setConnectionStates'];
  setLoadedKeys: UseSidebarTreeLoadersOptions['setLoadedKeys'];
  savedQueries: UseSidebarTreeLoadersOptions['savedQueries'];
  resolveSavedQueryDisplayName: UseSidebarTreeLoadersOptions['resolveSavedQueryDisplayName'];
  replaceTreeNodeChildren: UseSidebarTreeLoadersOptions['replaceTreeNodeChildren'];
  onDatabaseTreeLoaded: UseSidebarTreeLoadersOptions['onDatabaseTreeLoaded'];
  tableSortPreference: UseSidebarTreeLoadersOptions['tableSortPreference'];
  tableAccessCount: UseSidebarTreeLoadersOptions['tableAccessCount'];
  pinnedSidebarTables: UseSidebarTreeLoadersOptions['pinnedSidebarTables'];
  getConnectionLoadEpoch: SidebarTreeLoadStateApi['getConnectionLoadEpoch'];
  isCurrentConnectionLoadEpoch: SidebarTreeLoadStateApi['isCurrentConnectionLoadEpoch'];
  beginLoadGeneration: SidebarTreeLoadStateApi['beginLoadGeneration'];
  isCurrentLoadGeneration: SidebarTreeLoadStateApi['isCurrentLoadGeneration'];
  tableLoadsRef: SidebarTreeLoadStateApi['tableLoadsRef'];
}

export type SidebarDatabaseObjectLoadResults = {
    viewsResult: Awaited<ReturnType<typeof loadViews>>;
    materializedViewsResult: Awaited<ReturnType<typeof loadStarRocksMaterializedViews>>;
    triggersResult: Awaited<ReturnType<typeof loadDatabaseTriggers>>;
    routinesResult: Awaited<ReturnType<typeof loadFunctions>>;
    sequencesResult: Awaited<ReturnType<typeof loadSequences>>;
    packagesResult: Awaited<ReturnType<typeof loadPackages>>;
    eventsResult: Awaited<ReturnType<typeof loadDatabaseEvents>>;
    databaseLinksResult: Awaited<ReturnType<typeof loadOracleDatabaseLinks>>;
};

export const useSidebarTableLoader = ({
  loadingNodesRef, setConnectionStates, setLoadedKeys, savedQueries, resolveSavedQueryDisplayName,
  replaceTreeNodeChildren, onDatabaseTreeLoaded, tableSortPreference, tableAccessCount,
  pinnedSidebarTables, getConnectionLoadEpoch, isCurrentConnectionLoadEpoch, beginLoadGeneration,
  isCurrentLoadGeneration, tableLoadsRef,
}: UseSidebarTableLoaderInput) => {
  	  const runLoadTables = async (
        node: any,
        expectedConnectionEpoch = getConnectionLoadEpoch(String(node?.dataRef?.id || '')),
    ) => {
  		      const conn = node.dataRef; // has dbName
  		      const dbName = conn.dbName;
        const key = node.key;
        const loadKey = `tables-${conn.id}-${dbName}`;
        if (!isCurrentConnectionLoadEpoch(conn.id, expectedConnectionEpoch)) return;
        if (loadingNodesRef.current.has(loadKey)) return;
        const loadGeneration = beginLoadGeneration(loadKey);
        const isCurrentLoad = () => (
            isCurrentConnectionLoadEpoch(conn.id, expectedConnectionEpoch)
            && isCurrentLoadGeneration(loadKey, loadGeneration)
        );
        loadingNodesRef.current.add(loadKey);
        if (!isCurrentLoad()) return;
        setConnectionStates(prev => ({ ...prev, [key as string]: 'loading' }));
        let shouldMarkDatabaseSuccess = false;
        const showTableLoadFailure = (error: unknown) => {
            if (!isCurrentLoad()) return;
            const errorMessage = String(error || t('sidebar.message.load_table_list_failed', { error: 'unknown error' }));
            setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
            setLoadedKeys(prev => prev.filter(loadedKey => loadedKey !== node.key));
            message.error({
                key: `db-${key}-tables`,
                duration: 10,
                content: (
                    <span>
                        {errorMessage}
                        <Button
                            type="link"
                            size="small"
                            onClick={() => void loadTables(node, { ensureFresh: true })}
                        >
                            {t('common.retry')}
                        </Button>
                    </span>
                ),
            });
        };
  
        const dbQueries = savedQueries.filter(q => q.connectionId === conn.id && q.dbName === dbName);
        const messageQueueProfile = resolveSidebarMessageQueueProfile(conn.config);
        const queriesNode: TreeNode = {
            title: t('sidebar.tree.saved_queries'),
            key: `${key}-queries`,
            icon: <GnFolderOpenIcon />,
            type: 'queries-folder',
            isLeaf: dbQueries.length === 0,
            children: dbQueries.map(q => ({
                title: resolveSavedQueryDisplayName(q.name),
                key: q.id,
                icon: <GnSqlDocIcon />,
                type: 'saved-query',
                dataRef: q,
                isLeaf: true
            }))
        };
  
        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
  	          useSSH: conn.config.useSSH || false,
  	          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
  	      };
  	      try {
  	          if (messageQueueProfile) {
                const objectsResult = await DBGetObjects(
                    buildRpcConnectionConfig(config) as any,
                    conn.dbName,
                );
                if (!isCurrentLoad()) return;
                if (!objectsResult.success) {
  	                  showTableLoadFailure(objectsResult.message);
  	                  return;
  	              }
  
  	              const objectRows: Record<string, any>[] = Array.isArray(objectsResult.data)
  	                  ? objectsResult.data as Record<string, any>[]
  	                  : [];
  	              const latestConnection = useStore.getState().connections.find(
  	                  (candidate) => candidate.id === conn.id,
  	              ) || conn;
  	              const latestDatabaseConnection = { ...latestConnection, dbName };
  	              const objectNodes = buildSidebarMessageObjectNodes(
  	                  messageQueueProfile,
  	                  latestDatabaseConnection,
  	                  String(key),
  	                  objectRows,
  	              );
  	              replaceTreeNodeChildren(
  	                  key,
  	                  objectNodes,
  	                  latestDatabaseConnection,
  	              );
  	              onDatabaseTreeLoaded?.(String(key));
  	              shouldMarkDatabaseSuccess = true;
  
  	              if (objectsResult.partial || objectsResult.truncated) {
  	                  const warningDetail = String(
  	                      objectsResult.message
  	                      || (Array.isArray(objectsResult.warnings)
  	                          ? objectsResult.warnings.join('; ')
  	                          : '')
  	                      || t('sidebar.message.load_table_list_failed', {
  	                          error: 'message object metadata was incomplete',
  	                      }),
  	                  );
  	                  message.warning({
  	                      key: `db-${key}-message-objects-partial`,
  	                      duration: 10,
  	                      content: warningDetail,
  	                  });
  	              }
  	              return;
  	          }
  
  	          // Table stats and the schema list only depend on the database, so they leave
  	          // together with the table list instead of after it (one round trip less on
  	          // remote links; on the serial driver-agent transport they simply queue behind).
  	          // 只有表统计表达式按版本区分的数据源（TimescaleDB）才先取版本，其余类型不多等一个微任务。
  	          const statsVersion = needsServerVersionForTableStats(conn?.config?.type) ? await ensureTableStatsServerVersion(conn) : '';
  	          const tableStatusSql = buildSidebarTableStatusSQL(conn as SavedConnection, conn.dbName, statsVersion);
  	          const tableStatsPromise = tableStatusSql
  	              ? DBQuery(buildRpcConnectionConfig(config) as any, conn.dbName, tableStatusSql).catch(() => ({ success: false, data: [] as any[] }))
  	              : Promise.resolve({ success: false, data: [] as any[] });
  	          const schemasPromise = loadSchemas(conn, conn.dbName);
  	          const res = await DBGetTables(buildRpcConnectionConfig(config) as any, conn.dbName);
            if (!isCurrentLoad()) return;
  	          if (res.success) {
                  const tableRows: any[] = Array.isArray(res.data) ? res.data : [];
                  if (res.partial || res.truncated) {
                      const warningDetail = String(
                          res.message
                          || (Array.isArray(res.warnings) ? res.warnings.join('; ') : '')
                          || t('sidebar.message.load_table_list_failed', { error: 'metadata scan was truncated' }),
                      );
                      message.warning({
                          key: `db-${key}-tables-partial`,
                          duration: 10,
                          content: (
                              <span>
                                  {warningDetail}
                                  <Button
                                      type="link"
                                      size="small"
                                      onClick={() => void loadTables(node, { ensureFresh: true })}
                                  >
                                      {t('common.retry')}
                                  </Button>
                              </span>
                          ),
                      });
                  }
                  const tableMetadataMap = new Map<string, SidebarLoadedTableMetadata>();
                  const metadataObjectKeyIdentities = new Map<string, Set<string>>();
                  const ambiguousMetadataObjectKeys = new Set<string>();
                  const metadataDialect = getMetadataDialect(conn as SavedConnection);
                  const buildTableMetadataKeys = (rawTableName: string, rawSchemaName = ''): string[] => {
                      const tableName = String(rawTableName || '').trim();
                      if (!tableName) return [];
                      if (isPostgresSchemaDialect(metadataDialect)) {
                          const identity = getSidebarTableEntryIdentity({
                              tableName,
                              schemaName: String(rawSchemaName || '').trim(),
                          });
                          const objectName = getSidebarTableObjectIdentity(tableName);
                          const keys = new Set<string>();
                          if (identity) keys.add(`pg-exact:${identity}`);
                          // Catalog/status queries can disagree on whether the schema is
                          // included in table_name. Keep an object-only fallback, while
                          // preferring the schema-qualified identity above whenever both
                          // forms are present. An ambiguous object name is discarded below
                          // instead of being applied across schemas.
                          if (objectName) keys.add(`pg-object:${objectName}`);
                          return Array.from(keys);
                      }
                      const parsed = splitQualifiedName(tableName);
                      const schemaName = String(rawSchemaName || parsed.schemaName || '').trim();
                      const objectName = String(parsed.objectName || tableName).trim();
                      const keys = new Set<string>([tableName.toLowerCase()]);
                      if (objectName) keys.add(objectName.toLowerCase());
                      const qualifiedName = buildQualifiedName(schemaName, objectName || tableName);
                      if (qualifiedName) keys.add(qualifiedName.toLowerCase());
                      return Array.from(keys);
                  };
                  const readNumericMetadataValue = (row: Record<string, any>, keys: string[]): number | undefined => {
                      const rawValue = getCaseInsensitiveValue(row, keys);
                      if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
                      const numericValue = Number(String(rawValue).replace(/,/g, ''));
                      return Number.isFinite(numericValue) ? numericValue : undefined;
                  };
                  const normalizeMetadataTimestamp = (rawValue: unknown): string | undefined => {
                      if (rawValue === undefined || rawValue === null) return undefined;
                      const normalized = String(rawValue).trim();
                      return normalized ? normalized : undefined;
                  };
                  const mergeTableMetadata = (
                      rawTableName: string,
                      patch: SidebarLoadedTableMetadata,
                      rawSchemaName = '',
                  ) => {
                      const metadataKeys = buildTableMetadataKeys(rawTableName, rawSchemaName);
                      const exactIdentity = metadataKeys.find((metadataKey) => metadataKey.startsWith('pg-exact:')) || '';
                      metadataKeys.forEach((metadataKey) => {
                          if (isPostgresSchemaDialect(metadataDialect) && metadataKey.startsWith('pg-object:')) {
                              if (ambiguousMetadataObjectKeys.has(metadataKey)) return;
                              const identities = metadataObjectKeyIdentities.get(metadataKey) || new Set<string>();
                              identities.add(exactIdentity || metadataKey);
                              metadataObjectKeyIdentities.set(metadataKey, identities);
                              if (identities.size > 1) {
                                  ambiguousMetadataObjectKeys.add(metadataKey);
                                  tableMetadataMap.delete(metadataKey);
                                  return;
                              }
                          }
                          const current = tableMetadataMap.get(metadataKey) || {};
                          tableMetadataMap.set(metadataKey, {
                              ...current,
                              ...(patch.schemaName ? { schemaName: patch.schemaName } : {}),
                              ...(patch.partitionParentTableName ? { partitionParentTableName: patch.partitionParentTableName } : {}),
                              ...(patch.tableComment ? { tableComment: patch.tableComment } : {}),
                              ...(patch.rowCount !== undefined ? { rowCount: patch.rowCount } : {}),
                              ...(patch.tableSize !== undefined ? { tableSize: patch.tableSize } : {}),
                              ...(patch.createdAt ? { createdAt: patch.createdAt } : {}),
                              ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
                          });
                      });
                  };
                  tableRows.forEach((row: Record<string, any>) => {
                      const tableName = getSidebarTableName(row);
                      const rawSchemaName = getCaseInsensitiveValue(row, ['schema_name', 'SCHEMA_NAME', 'owner', 'OWNER']);
                      const rowCount = parseSidebarTableRowCount(row, conn as SavedConnection);
                      const tableSize = readNumericMetadataValue(row, [
                          'Data_length',
                          'data_length',
                          'DATA_LENGTH',
                      ]);
                      if (tableName && (rowCount !== undefined || tableSize !== undefined)) {
                          mergeTableMetadata(tableName, {
                              ...(rowCount !== undefined ? { rowCount } : {}),
                              ...(tableSize !== undefined ? { tableSize } : {}),
                          }, rawSchemaName ? String(rawSchemaName).trim() : '');
                      }
                  });
  
  	            // Tables and schemas first: they are all the tree needs to render the table
  	            // groups. The remaining object kinds are requested only after that, because the
  	            // optional driver-agent transport is strictly serial and would otherwise let a
  	            // slow view/routine query jump ahead of the schema list.
  	            const [tableStatsResult, schemasResult] = await Promise.all([
  	                tableStatsPromise,
  	                schemasPromise,
  	            ]);
              if (!isCurrentLoad()) return;
  	            let objectLoadsSettled = false;
  	            const objectLoadsPromise = Promise.all([
  	                loadViews(conn, conn.dbName),
  	                loadStarRocksMaterializedViews(conn, conn.dbName),
  	                loadDatabaseTriggers(conn, conn.dbName),
  	                loadFunctions(conn, conn.dbName),
  	                loadSequences(conn, conn.dbName),
  	                loadPackages(conn, conn.dbName),
  	                loadDatabaseEvents(conn, conn.dbName),
  	                loadOracleDatabaseLinks(conn as SavedConnection, conn.dbName),
  	            ]).then(
  	                (results) => {
  	                    objectLoadsSettled = true;
  	                    return { ok: true as const, results };
  	                },
  	                (error: unknown) => {
  	                    objectLoadsSettled = true;
  	                    return { ok: false as const, error };
  	                },
  	            );
                  if (tableStatsResult?.success && Array.isArray(tableStatsResult.data)) {
                      tableStatsResult.data.forEach((row: Record<string, any>) => {
                          const rawTableName = String(
                              getCaseInsensitiveValue(row, ['table_name', 'TABLE_NAME', 'Name', 'name'])
                              || getMySQLShowTablesName(row)
                              || ''
                          ).trim();
                          if (!rawTableName) return;
                          const rawSchemaName = getCaseInsensitiveValue(row, ['schema_name', 'SCHEMA_NAME', 'owner', 'OWNER']);
                          const partitionParentTableName = String(getCaseInsensitiveValue(row, [
                              'partition_parent_table',
                              'PARTITION_PARENT_TABLE',
                          ]) || '').trim();
                          const tableComment = String(getCaseInsensitiveValue(row, [
                              'table_comment',
                              'TABLE_COMMENT',
                              'comment',
                              'Comment',
                              'comments',
                              'COMMENTS',
                              'MS_Description',
                          ]) || '').trim();
                          const rowCount = parseSidebarTableRowCount(row, conn as SavedConnection);
                          const tableSize = readNumericMetadataValue(row, [
                              'table_size',
                              'TABLE_SIZE',
                              'data_length',
                              'DATA_LENGTH',
                              'total_bytes',
                              'TOTAL_BYTES',
                          ]);
                          const createdAt = normalizeMetadataTimestamp(getCaseInsensitiveValue(row, [
                              'create_time',
                              'CREATE_TIME',
                              'created_at',
                              'CREATED_AT',
                              'create_date',
                              'CREATE_DATE',
                          ]));
                          const updatedAt = normalizeMetadataTimestamp(getCaseInsensitiveValue(row, [
                              'update_time',
                              'UPDATE_TIME',
                              'updated_at',
                              'UPDATED_AT',
                              'modify_date',
                              'MODIFY_DATE',
                              'last_ddl_time',
                              'LAST_DDL_TIME',
                          ]));
                          mergeTableMetadata(rawTableName, {
                              schemaName: rawSchemaName ? String(rawSchemaName).trim() : undefined,
                              ...(partitionParentTableName ? { partitionParentTableName } : {}),
                              ...(tableComment ? { tableComment } : {}),
                              ...(rowCount !== undefined ? { rowCount } : {}),
                              ...(tableSize !== undefined ? { tableSize } : {}),
                              ...(createdAt ? { createdAt } : {}),
                              ...(updatedAt ? { updatedAt } : {}),
                          }, rawSchemaName);
                      });
                  }
                  const tableEntries = tableRows.map((row: any) => {
                      const tableName = getSidebarTableName(row as Record<string, any>);
                      const parsed = splitQualifiedName(tableName);
                      const rowSchemaName = getCaseInsensitiveValue(row, ['schema_name', 'SCHEMA_NAME', 'owner', 'OWNER']);
                      const metadataKeys = buildTableMetadataKeys(
                          tableName,
                          rowSchemaName ? String(rowSchemaName).trim() : '',
                      );
                      const resolvedMetadata = metadataKeys
                          .map((metadataKey) => tableMetadataMap.get(metadataKey))
                          .find((value): value is SidebarLoadedTableMetadata => !!value);
                      const mappedSchemaName = rowSchemaName
                          || resolvedMetadata?.schemaName
                          || parsed.schemaName;
                      const rowComment = getCaseInsensitiveValue(row, [
                          'table_comment',
                          'TABLE_COMMENT',
                          'comment',
                          'Comment',
                          'comments',
                          'COMMENTS',
                      ]);
                      return {
                          tableName,
                          schemaName: String(mappedSchemaName || '').trim(),
                          displayName: getSidebarTableDisplayName(conn, tableName),
                          rowCount: parseSidebarTableRowCount(row, conn as SavedConnection) ?? resolvedMetadata?.rowCount,
                          tableSize: resolvedMetadata?.tableSize,
                          createdAt: resolvedMetadata?.createdAt,
                          updatedAt: resolvedMetadata?.updatedAt,
                          tableComment: rowComment
                              || resolvedMetadata?.tableComment
                              || '',
                          partitionParentTableName: resolvedMetadata?.partitionParentTableName,
                      };
                  }) as SidebarLoadedTableEntry[];

  	            const { buildRenderedDatabaseChildren } = createSidebarDatabaseChildrenBuilder({
  	              schemasResult, tableEntries, conn, key, loadTables, node, tableSortPreference,
  	              tableAccessCount, pinnedSidebarTables, dbName, queriesNode,
  	            });
  
  	            const emptyObjectLoadResults: SidebarDatabaseObjectLoadResults = {
  	                viewsResult: { views: [], supported: true },
  	                materializedViewsResult: { views: [], supported: true },
  	                triggersResult: { triggers: [], supported: true },
  	                routinesResult: { routines: [], supported: true },
  	                sequencesResult: { sequences: [], supported: true },
  	                packagesResult: { packages: [], supported: true },
  	                eventsResult: { events: [], supported: true },
  	                databaseLinksResult: { databaseLinks: [], supported: true },
  	            };
  	            let renderedDatabaseChildren: TreeNode[] = [];
  	            let latestDatabaseConnection: SavedConnection = conn as SavedConnection;
  	            // Give the object kinds a short grace period: fast local databases finish within
  	            // it and get a single commit, while slow or serialized remote links show the
  	            // table groups right away and fill in the rest with a second commit.
  	            if (!objectLoadsSettled) {
  	                await Promise.race([
  	                    objectLoadsPromise,
  	                    new Promise<void>((resolve) => {
  	                        setTimeout(resolve, SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS);
  	                    }),
  	                ]);
  	                if (!isCurrentLoad()) return;
  	            }
  	            if (!objectLoadsSettled) {
  	                const firstPass = buildRenderedDatabaseChildren(emptyObjectLoadResults, false);
  	                renderedDatabaseChildren = firstPass.renderedDatabaseChildren;
  	                latestDatabaseConnection = firstPass.latestDatabaseConnection;
              if (!isCurrentLoad()) return;
              replaceTreeNodeChildren(key, renderedDatabaseChildren, latestDatabaseConnection);
                  onDatabaseTreeLoaded?.(String(key));
                  shouldMarkDatabaseSuccess = true;
  	            }
  
  	            const objectLoads = await objectLoadsPromise;
              if (!isCurrentLoad()) return;
  	            if (!objectLoads.ok) throw objectLoads.error;
  	            const [viewsResult, materializedViewsResult, triggersResult, routinesResult, sequencesResult, packagesResult, eventsResult, databaseLinksResult] = objectLoads.results;
  	            const secondPass = buildRenderedDatabaseChildren({
  	                viewsResult,
  	                materializedViewsResult,
  	                triggersResult,
  	                routinesResult,
  	                sequencesResult,
  	                packagesResult,
  	                eventsResult,
  	                databaseLinksResult,
  	            }, true);
  	            renderedDatabaseChildren = secondPass.renderedDatabaseChildren;
  	            latestDatabaseConnection = secondPass.latestDatabaseConnection;
              replaceTreeNodeChildren(key, renderedDatabaseChildren, latestDatabaseConnection);
                  onDatabaseTreeLoaded?.(String(key));
                  shouldMarkDatabaseSuccess = true;
  
  	            if (getMetadataDialect(conn as SavedConnection) === 'sqlite') {
  	                const tableNames = tableRows
  	                    .map((row) => getSidebarTableName(row as Record<string, any>))
  	                    .filter((tableName) => String(tableName || '').trim() !== '');
                  const refreshed = await DBRefreshTableStats(
                      buildRpcConnectionConfig(config) as any,
                      conn.dbName,
                      tableNames,
                  ).catch(() => null);
                  if (!isCurrentLoad()) return;
                  if (refreshed?.success && Array.isArray(refreshed.data)) {
  	                    renderedDatabaseChildren = applyRefreshedSQLiteStatsToTree(
  	                        renderedDatabaseChildren,
  	                        refreshed.data as Record<string, any>[],
  	                    );
  	                    replaceTreeNodeChildren(key, renderedDatabaseChildren, latestDatabaseConnection);
  	                }
  	            }
  	          } else {
  	            showTableLoadFailure(res.message);
            }
  	      } catch (e: any) {
                if (isCurrentLoad()) {
                    showTableLoadFailure(t('sidebar.message.load_table_list_failed', { error: e?.message || String(e) }));
                }
  	      } finally {
            if (isCurrentLoad()) {
                loadingNodesRef.current.delete(loadKey);
                if (shouldMarkDatabaseSuccess) {
                    setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));
                }
            }
  	      }
    };
  
    const loadTables = (
        node: any,
        options: SidebarTreeLoadOptions = {},
    ): Promise<void> => {
        const conn = node.dataRef;
        const loadKey = `tables-${conn.id}-${conn.dbName}`;
        const connectionEpoch = getConnectionLoadEpoch(conn.id);
        return scheduleSidebarLoad(
            tableLoadsRef.current,
            loadKey,
            () => runLoadTables(node, connectionEpoch),
            options,
        );
    };
  return { loadTables };
};

export type SidebarTableLoaderApi = ReturnType<typeof useSidebarTableLoader>;
