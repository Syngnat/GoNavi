import React, { useRef } from 'react';
import { message } from 'antd';
import {
  CodeOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FunctionOutlined,
  HddOutlined,
  KeyOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { SavedConnection, SavedQuery, JVMCapability, JVMResourceSummary } from '../../types';
import { useStore } from '../../store';
import { t } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildRedisDbNodeLabel, getRedisDbAlias } from '../../utils/redisDbAlias';
import { buildJVMMonitoringActionDescriptors } from '../../utils/jvmSidebarActions';
import { type SidebarViewMetadataEntry } from '../../utils/sidebarMetadata';
import {
  buildQualifiedName,
  buildSidebarObjectKeyName,
  buildSidebarTableStatusSQL,
  getCaseInsensitiveValue,
  getMetadataDialect,
  getMySQLShowTablesName,
  getSidebarTableDisplayName,
  isSphinxConnection,
  loadDatabaseEvents,
  loadDatabaseTriggers,
  loadFunctions,
  loadPackages,
  loadSchemas,
  loadSequences,
  loadStarRocksMaterializedViews,
  loadViews,
  parseMetadataRowCount,
  parseMetadataTableComment,
  shouldHideSchemaPrefix,
  splitQualifiedName,
  supportsDatabaseEvents,
} from './sidebarMetadataLoaders';
import {
  buildSidebarTableChildrenForUi,
  isSidebarTablePinned,
  sortSidebarTableEntries,
  type SidebarConnectionState,
  type SidebarTreeNode as TreeNode,
} from '../sidebarV2Utils';
import { DBGetDatabases, DBGetTables, DBQuery, GetDriverStatusList, JVMProbeCapabilities } from '../../../wailsjs/go/app/App';

type DriverStatusSnapshot = {
  type: string;
  name: string;
  connectable: boolean;
  expectedRevision?: string;
  needsUpdate?: boolean;
  updateReason?: string;
  message?: string;
};

export const formatSidebarDriverAgentUpdateWarning = (
  driverName: string,
  status: Pick<DriverStatusSnapshot, 'message' | 'updateReason'>,
): string => {
  const rawMessage = String(status.message || '').trim();
  if (rawMessage) {
    return rawMessage;
  }
  const rawUpdateReason = String(status.updateReason || '').trim();
  if (rawUpdateReason) {
    return rawUpdateReason;
  }
  return t('connection.modal.driver.updateFallback', { name: driverName });
};

const buildConnectionReloadSignature = (conn?: SavedConnection | null): string => {
  if (!conn) return '';
  return JSON.stringify({
    config: conn.config || {},
    includeDatabases: conn.includeDatabases || [],
    includeRedisDatabases: conn.includeRedisDatabases || [],
  });
};

const isConnectionTreeKey = (key: React.Key, connectionId: string): boolean => {
  const text = String(key);
  return text === connectionId || text.startsWith(`${connectionId}-`);
};

const DRIVER_STATUS_CACHE_TTL_MS = 30_000;

export const normalizeDriverType = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'postgresql' || normalized === 'pg' || normalized === 'pq' || normalized === 'pgx') return 'postgres';
  if (normalized === 'doris') return 'diros';
  if (
    normalized === 'open_gauss' ||
    normalized === 'open-gauss' ||
    normalized === 'opengauss'
  ) return 'opengauss';
  if (
    normalized === 'intersystems' ||
    normalized === 'intersystemsiris' ||
    normalized === 'inter-systems' ||
    normalized === 'inter-systems-iris'
  ) return 'iris';
  return normalized;
};

const resolveSavedConnectionDriverType = (conn: SavedConnection | undefined): string => {
  const type = normalizeDriverType(conn?.config?.type || '');
  if (type !== 'custom') {
    return type;
  }
  return normalizeDriverType(conn?.config?.driver || '');
};


type UseSidebarTreeLoadersOptions = {
  savedQueries: SavedQuery[];
  tableSortPreference: Record<string, any>;
  tableAccessCount: Record<string, any>;
  pinnedSidebarTables: any[];
  isV2Ui: boolean;
  loadingNodesRef: React.MutableRefObject<Set<string>>;
  setConnectionStates: React.Dispatch<React.SetStateAction<Record<string, SidebarConnectionState>>>;
  setLoadedKeys: React.Dispatch<React.SetStateAction<React.Key[]>>;
  replaceTreeNodeChildren: (key: React.Key, children: TreeNode[] | undefined) => TreeNode[];
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  buildJVMRuntimeConfig: (conn: SavedConnection & { dbName?: string }, providerMode: string) => any;
  buildJVMDiagnosticTreeNodes: (conn: SavedConnection) => TreeNode[];
  resolveSavedQueryDisplayName: (name: string | null | undefined) => string;
  onDatabaseTreeLoaded?: (databaseKey: string) => void;
};

export const useSidebarTreeLoaders = ({
  savedQueries,
  tableSortPreference,
  tableAccessCount,
  pinnedSidebarTables,
  isV2Ui,
  loadingNodesRef,
  setConnectionStates,
  setLoadedKeys,
  replaceTreeNodeChildren,
  buildRuntimeConfig,
  buildJVMRuntimeConfig,
  buildJVMDiagnosticTreeNodes,
  resolveSavedQueryDisplayName,
  onDatabaseTreeLoaded,
}: UseSidebarTreeLoadersOptions) => {
  const driverStatusCacheRef = useRef<{
      fetchedAt: number;
      items: Record<string, DriverStatusSnapshot>;
  } | null>(null);
  const driverUpdateWarningKeysRef = useRef<Set<string>>(new Set());

	  const fetchDriverStatusMap = async (): Promise<Record<string, DriverStatusSnapshot>> => {
	      const cached = driverStatusCacheRef.current;
	      if (cached && Date.now() - cached.fetchedAt < DRIVER_STATUS_CACHE_TTL_MS) {
	          return cached.items;
	      }
	      const result: Record<string, DriverStatusSnapshot> = {};
	      const res = await GetDriverStatusList('', '');
	      if (!res?.success) {
	          return result;
	      }
	      const data = (res.data || {}) as any;
	      const drivers = Array.isArray(data.drivers) ? data.drivers : [];
	      drivers.forEach((item: any) => {
	          const type = normalizeDriverType(String(item.type || '').trim());
	          if (!type) return;
	          result[type] = {
	              type,
	              name: String(item.name || item.type || type).trim(),
	              connectable: !!item.connectable,
	              expectedRevision: String(item.expectedRevision || '').trim() || undefined,
	              needsUpdate: !!item.needsUpdate,
	              updateReason: String(item.updateReason || '').trim() || undefined,
	              message: String(item.message || '').trim() || undefined,
	          };
	      });
	      driverStatusCacheRef.current = { fetchedAt: Date.now(), items: result };
	      return result;
	  };

	  const warnIfConnectionDriverAgentNeedsUpdate = async (conn: SavedConnection) => {
	      try {
	          const driverType = resolveSavedConnectionDriverType(conn);
	          if (!driverType || driverType === 'custom') {
	              return;
	          }
	          const statusMap = await fetchDriverStatusMap();
	          const status = statusMap[driverType];
	          if (!status?.connectable || !status.needsUpdate) {
	              return;
	          }
	          const revisionKey = status.expectedRevision || status.updateReason || status.message || 'unknown';
	          const warningKey = `${conn.id}:${driverType}:${revisionKey}`;
	          if (driverUpdateWarningKeysRef.current.has(warningKey)) {
	              return;
	          }
	          driverUpdateWarningKeysRef.current.add(warningKey);
	          const driverName = status.name || driverType;
	          message.warning({
	              content: formatSidebarDriverAgentUpdateWarning(driverName, status),
	              key: `driver-agent-update-${conn.id}`,
	              duration: 10,
	          });
	      } catch (error) {
	          console.warn('检查驱动代理更新状态失败', error);
	      }
	  };
		  const loadDatabases = async (node: any) => {
		      const conn = node.dataRef as SavedConnection;
		      const loadKey = `dbs-${conn.id}`;
	      if (loadingNodesRef.current.has(loadKey)) return;
	      loadingNodesRef.current.add(loadKey);
          setConnectionStates(prev => ({ ...prev, [conn.id]: 'loading' }));
	      const config = {
	          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
	          useSSH: conn.config.useSSH || false,
	          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
	      };

          if (conn.config.type === 'jvm') {
              try {
                  const res = await JVMProbeCapabilities(buildRuntimeConfig(conn) as any);
                  if (res.success) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                      const capabilities: JVMCapability[] = Array.isArray(res.data) ? res.data as JVMCapability[] : [];
                      const modeNodes: TreeNode[] = capabilities.map((capability) => ({
                          title: capability.displayLabel || capability.mode,
                          key: `${conn.id}-jvm-mode-${capability.mode}`,
                          icon: <HddOutlined />,
                          type: 'jvm-mode',
                          dataRef: {
                              ...conn,
                              providerMode: capability.mode,
                              canBrowse: capability.canBrowse,
                              canWrite: capability.canWrite,
                              reason: capability.reason,
                              displayLabel: capability.displayLabel,
                          },
                          isLeaf: capability.canBrowse !== true,
                      }));
                      const monitoringNodes: TreeNode[] = buildJVMMonitoringActionDescriptors(conn.id, capabilities).map((item) => ({
                          title: item.title,
                          key: item.key,
                          icon: <DashboardOutlined />,
                          type: 'jvm-monitoring',
                          dataRef: {
                              ...conn,
                              providerMode: item.providerMode,
                          },
                          isLeaf: true,
                      }));
                      const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                      replaceTreeNodeChildren(node.key, [...monitoringNodes, ...modeNodes, ...diagnosticNode]);
                  } else {
                      const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                      if (diagnosticNode.length > 0) {
                          replaceTreeNodeChildren(node.key, diagnosticNode);
                          message.warning({
                              content: t('sidebar.message.jvm_provider_probe_failed_with_diagnostic', {
                                  error: res.message || t('sidebar.error.unknown'),
                              }),
                              key: `conn-${conn.id}-jvm-caps`,
                          });
                      } else {
                          setLoadedKeys(prev => prev.filter(k => k !== node.key));
                          message.error({ content: res.message, key: `conn-${conn.id}-jvm-caps` });
                      }
                  }
              } catch (e: any) {
                  const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                  setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                  if (diagnosticNode.length > 0) {
                      replaceTreeNodeChildren(node.key, diagnosticNode);
                      message.warning({
                          content: t('sidebar.message.jvm_provider_probe_exception_with_diagnostic', {
                              error: e?.message || String(e),
                          }),
                          key: `conn-${conn.id}-jvm-caps`,
                      });
                  } else {
                      setLoadedKeys(prev => prev.filter(k => k !== node.key));
                      message.error({
                          content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                          key: `conn-${conn.id}-jvm-caps`,
                      });
                  }
              } finally {
                  loadingNodesRef.current.delete(loadKey);
              }
              return;
          }

          // Handle Redis connections differently
          if (conn.config.type === 'redis') {
              try {
                  const res = await (window as any).go.app.App.RedisGetDatabases(buildRpcConnectionConfig(config));
                  if (res.success) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                      const redisRows: any[] = Array.isArray(res.data) ? res.data : [];
                      const redisDbAliases = useStore.getState().appearance.redisDbAliases;
                      let dbs = redisRows.map((db: any) => {
                          const keyCount = Number(db.keys) > 0 ? Number(db.keys) : 0;
                          const alias = getRedisDbAlias(redisDbAliases, conn.id, db.index);
                          return {
                              title: buildRedisDbNodeLabel(
                                  db.index,
                                  alias,
                              ),
                              key: `${conn.id}-db${db.index}`,
                              icon: <DatabaseOutlined style={{ color: '#DC382D' }} />,
                              type: 'redis-db' as const,
                              dataRef: { ...conn, redisDB: db.index, redisKeyCount: keyCount, redisDbAlias: alias },
                              isLeaf: true,
                              dbIndex: db.index,
                          };
                      });
                      // Filter Redis databases if configured
                      if (conn.includeRedisDatabases && conn.includeRedisDatabases.length > 0) {
                          dbs = dbs.filter(db => conn.includeRedisDatabases!.includes(db.dbIndex));
                      }
                      replaceTreeNodeChildren(node.key, dbs);
                  } else {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                      message.error({ content: res.message, key: `conn-${conn.id}-dbs` });
                  }
              } catch (e: any) {
                  setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                  message.error({
                      content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                      key: `conn-${conn.id}-dbs`,
                  });
              } finally {
                  loadingNodesRef.current.delete(loadKey);
              }
              return;
          }

	      try {
	          const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
	          if (res.success) {
	            setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
	            let dbs = dbRows.map((row: any) => ({
	              title: row.Database || row.database,
              key: `${conn.id}-${row.Database || row.database}`,
              icon: <DatabaseOutlined />,
              type: 'database' as const,
              dataRef: { ...conn, dbName: row.Database || row.database },
              isLeaf: false,
            }));

            // Filter databases if configured
            if (conn.includeDatabases && conn.includeDatabases.length > 0) {
                dbs = dbs.filter(db => conn.includeDatabases!.includes(db.title));
            }

            if (dbs.length > 0) {
                replaceTreeNodeChildren(node.key, dbs);
            } else {
                // 空列表：清理 loadedKeys 以允许重新加载，不设置 children = []
                setLoadedKeys(prev => prev.filter(k => k !== node.key));
                message.warning({ content: t('sidebar.message.no_visible_databases'), key: `conn-${conn.id}-dbs` });
            }
	          } else {
	            setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
	            setLoadedKeys(prev => prev.filter(k => k !== node.key));
	            message.error({ content: res.message, key: `conn-${conn.id}-dbs` });
	          }
	      } catch (e: any) {
	          setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
	          setLoadedKeys(prev => prev.filter(k => k !== node.key));
	          message.error({
                content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                key: `conn-${conn.id}-dbs`,
            });
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
	      }
  };

  const loadJVMResources = async (node: any) => {
      const conn = node.dataRef as SavedConnection & { providerMode?: string; resourcePath?: string };
      const providerMode = String(conn.providerMode || '').trim().toLowerCase();
      const parentPath = String(conn.resourcePath || '').trim();
      const loadKey = `jvm-resources-${conn.id}-${providerMode}-${parentPath}`;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);

      try {
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.JVMListResources !== 'function') {
              throw new Error(t('sidebar.message.jvm_resources_backend_unavailable'));
          }

          const res = await backendApp.JVMListResources(buildJVMRuntimeConfig(conn, providerMode), parentPath);
          if (res.success) {
              const resourceRows: JVMResourceSummary[] = Array.isArray(res.data) ? res.data as JVMResourceSummary[] : [];
              const resourceNodes: TreeNode[] = resourceRows.map((item) => ({
                  title: item.name || item.path || item.id,
                  key: `${conn.id}-jvm-resource-${providerMode}-${item.path}`,
                  icon: item.hasChildren ? <FolderOpenOutlined /> : <HddOutlined />,
                  type: 'jvm-resource',
                  dataRef: {
                      ...conn,
                      providerMode: item.providerMode || providerMode,
                      resourcePath: item.path,
                      resourceKind: item.kind,
                      canRead: item.canRead,
                      canWrite: item.canWrite,
                      hasChildren: item.hasChildren,
                      sensitive: item.sensitive,
                  },
                  isLeaf: item.hasChildren !== true,
              }));
              replaceTreeNodeChildren(node.key, resourceNodes);
          } else {
              setLoadedKeys(prev => prev.filter(k => k !== node.key));
              message.error({ content: res.message, key: `jvm-resource-${node.key}` });
          }
      } catch (e: any) {
          setLoadedKeys(prev => prev.filter(k => k !== node.key));
          message.error({
              content: t('sidebar.message.load_jvm_resources_failed', { error: e?.message || String(e) }),
              key: `jvm-resource-${node.key}`,
          });
      } finally {
          loadingNodesRef.current.delete(loadKey);
      }
  };

	  const loadTables = async (node: any) => {
	      const conn = node.dataRef; // has dbName
	      const dbName = conn.dbName;
      const key = node.key;
      const loadKey = `tables-${conn.id}-${dbName}`;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);
      
      const dbQueries = savedQueries.filter(q => q.connectionId === conn.id && q.dbName === dbName);
      const queriesNode: TreeNode = {
          title: t('sidebar.tree.saved_queries'),
          key: `${key}-queries`,
          icon: <FolderOpenOutlined />,
          type: 'queries-folder',
          isLeaf: dbQueries.length === 0,
          children: dbQueries.map(q => ({
              title: resolveSavedQueryDisplayName(q.name),
              key: q.id,
              icon: <FileTextOutlined />,
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
	          const res = await DBGetTables(buildRpcConnectionConfig(config) as any, conn.dbName);
	          if (res.success) {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));

                const tableRows: any[] = Array.isArray(res.data) ? res.data : [];
                const tableStatusSql = buildSidebarTableStatusSQL(conn as SavedConnection, conn.dbName);
                const tableStatsResult = tableStatusSql
                    ? await DBQuery(buildRpcConnectionConfig(config) as any, conn.dbName, tableStatusSql).catch(() => ({ success: false, data: [] as any[] }))
                    : { success: false, data: [] as any[] };
                const tableRowCountMap = new Map<string, number>();
                const tableCommentMap = new Map<string, string>();
                if (tableStatsResult?.success && Array.isArray(tableStatsResult.data)) {
                    tableStatsResult.data.forEach((row: Record<string, any>) => {
                        const rawTableName = String(
                            getCaseInsensitiveValue(row, ['table_name', 'TABLE_NAME', 'Name', 'name'])
                            || getMySQLShowTablesName(row)
                            || ''
                        ).trim();
                        if (!rawTableName) return;
                        const tableComment = parseMetadataTableComment(row);
                        if (tableComment) {
                            tableCommentMap.set(rawTableName.toLowerCase(), tableComment);
                        }
                        const rowCount = parseMetadataRowCount(row);
                        if (rowCount === undefined) return;
                        tableRowCountMap.set(rawTableName.toLowerCase(), rowCount);
                    });
                }
	            const tableEntries = tableRows.map((row: any) => {
	                const tableName = Object.values(row)[0] as string;
	                const parsed = splitQualifiedName(tableName);
	                return {
	                    tableName,
	                    schemaName: parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, tableName),
                        rowCount: tableRowCountMap.get(String(tableName || '').trim().toLowerCase()),
                        comment: tableCommentMap.get(String(tableName || '').trim().toLowerCase()),
	                };
	            });

	            const [schemasResult, viewsResult, materializedViewsResult, triggersResult, routinesResult, sequencesResult, packagesResult, eventsResult] = await Promise.all([
	                loadSchemas(conn, conn.dbName),
	                loadViews(conn, conn.dbName),
	                loadStarRocksMaterializedViews(conn, conn.dbName),
	                loadDatabaseTriggers(conn, conn.dbName),
	                loadFunctions(conn, conn.dbName),
	                loadSequences(conn, conn.dbName),
	                loadPackages(conn, conn.dbName),
	                loadDatabaseEvents(conn, conn.dbName),
	            ]);
            const viewRows: SidebarViewMetadataEntry[] = Array.isArray(viewsResult.views) ? viewsResult.views : [];
            const materializedViewRows: SidebarViewMetadataEntry[] = Array.isArray(materializedViewsResult.views) ? materializedViewsResult.views : [];
            const triggerRows: any[] = Array.isArray(triggersResult.triggers) ? triggersResult.triggers : [];
            const routineRows: any[] = Array.isArray(routinesResult.routines) ? routinesResult.routines : [];
            const sequenceRows: any[] = Array.isArray(sequencesResult.sequences) ? sequencesResult.sequences : [];
            const packageRows: any[] = Array.isArray(packagesResult.packages) ? packagesResult.packages : [];
            const eventRows: any[] = Array.isArray(eventsResult.events) ? eventsResult.events : [];
            const schemaRows: string[] = Array.isArray(schemasResult.schemas) ? schemasResult.schemas : [];

            const viewEntries = viewRows.map((entry: SidebarViewMetadataEntry) => {
                const parsed = splitQualifiedName(entry.viewName);
                return {
                    viewName: entry.viewName,
	                    schemaName: entry.schemaName || parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, entry.viewName),
	                };
	            });

            const materializedViewEntries = materializedViewRows.map((entry: SidebarViewMetadataEntry) => {
                const parsed = splitQualifiedName(entry.viewName);
                return {
                    viewName: entry.viewName,
                    schemaName: entry.schemaName || parsed.schemaName,
                    displayName: getSidebarTableDisplayName(conn, entry.viewName),
                };
            });

            const triggerEntries = (() => {
                const deduped: Array<{ displayName: string; triggerName: string; tableName: string; schemaName: string }> = [];
                const triggerSeen = new Set<string>();
                const metadataDialect = getMetadataDialect(conn as SavedConnection);

                triggerRows.forEach((trigger: any) => {
                    const triggerParsed = splitQualifiedName(trigger.triggerName);
                    const tableParsed = splitQualifiedName(trigger.tableName);
                    const schemaName = tableParsed.schemaName || triggerParsed.schemaName || String(conn.dbName || '').trim();
                    const triggerObjectName = (triggerParsed.objectName || trigger.triggerName).trim();
                    const tableObjectName = (tableParsed.objectName || trigger.tableName).trim();
                    const displayName = tableObjectName ? `${triggerObjectName} (${tableObjectName})` : triggerObjectName;
                    const dedupeKey = metadataDialect === 'mysql'
                        ? `${schemaName.toLowerCase()}@@${triggerObjectName.toLowerCase()}`
                        : `${schemaName.toLowerCase()}@@${triggerObjectName.toLowerCase()}@@${tableObjectName.toLowerCase()}`;

                    if (triggerSeen.has(dedupeKey)) return;
                    triggerSeen.add(dedupeKey);
                    deduped.push({
                        ...trigger,
                        schemaName,
                        triggerName: triggerObjectName,
                        tableName: buildQualifiedName(schemaName, tableObjectName) || tableObjectName,
                        displayName,
                    });
                });

                return deduped;
            })();

            const routineEntries = routineRows.map((routine: any) => {
                const parsed = splitQualifiedName(routine.routineName);
                const typeLabel = routine.routineType === 'PROCEDURE' ? 'P' : 'F';
                return {
	                    ...routine,
	                    schemaName: parsed.schemaName,
                    displayName: `${parsed.objectName || routine.routineName} [${typeLabel}]`,
                };
            });

            const sequenceEntries = sequenceRows.map((sequence: any) => {
                const parsed = splitQualifiedName(sequence.sequenceName);
                return {
                    ...sequence,
                    schemaName: sequence.schemaName || parsed.schemaName,
                    displayName: parsed.objectName || sequence.sequenceName,
                };
            });

            const packageEntries = packageRows.map((packageEntry: any) => {
                const parsed = splitQualifiedName(packageEntry.packageName);
                return {
                    ...packageEntry,
                    schemaName: packageEntry.schemaName || parsed.schemaName,
                    displayName: parsed.objectName || packageEntry.packageName,
                };
            });

            const eventEntries = eventRows.map((event: any) => ({
                ...event,
                schemaName: String(event.schemaName || conn.dbName || '').trim(),
                displayName: String(event.displayName || event.eventName || '').trim(),
            })).filter((event: any) => event.eventName && event.displayName);

            if (isSphinxConnection(conn as SavedConnection)) {
                const unsupportedObjects: string[] = [];
                if (!viewsResult.supported) unsupportedObjects.push(t('sidebar.object_group.views'));
                if (!routinesResult.supported) unsupportedObjects.push(t('sidebar.object_group.routines'));
                if (!triggersResult.supported) unsupportedObjects.push(t('sidebar.object_group.triggers'));
                if (unsupportedObjects.length > 0) {
                    message.info({
                        key: `sphinx-capability-${conn.id}-${conn.dbName}`,
                        content: t('sidebar.message.sphinx_unsupported_objects', {
                            objects: unsupportedObjects.join(t('sidebar.punctuation.list_separator')),
                        }),
                    });
                }
            }

	            const currentStoreState = useStore.getState();
	            const currentTableSortPreference = currentStoreState.tableSortPreference || tableSortPreference;
	            const currentTableAccessCount = currentStoreState.tableAccessCount || tableAccessCount;
	            const currentPinnedSidebarTables = currentStoreState.pinnedSidebarTables || pinnedSidebarTables;

	            // 获取当前数据库的排序偏好
	            const sortPreferenceKey = `${conn.id}-${conn.dbName}`;
	            const sortBy = currentTableSortPreference[sortPreferenceKey] || 'name';

	            const sortedTableEntries = sortSidebarTableEntries(tableEntries, {
	                connectionId: conn.id,
	                dbName: conn.dbName,
	                sortBy,
	                tableAccessCount: currentTableAccessCount,
	                pinnedSidebarTables: isV2Ui ? currentPinnedSidebarTables : [],
	            });

	            // Sort views by name (case-insensitive)
	            viewEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            materializedViewEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            // Sort triggers by display name (case-insensitive)
	            triggerEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            // Sort routines by display name (case-insensitive)
	            routineEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            sequenceEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            packageEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            eventEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            const buildTableNode = (entry: { tableName: string; schemaName: string; displayName: string; rowCount?: number; comment?: string }): TreeNode => {
	                const isPinned = isV2Ui && isSidebarTablePinned(
	                    currentPinnedSidebarTables,
	                    conn.id,
	                    conn.dbName,
	                    entry.tableName,
	                    entry.schemaName,
	                );
	                return {
	                    title: entry.displayName,
	                    key: `${conn.id}-${conn.dbName}-${entry.tableName}`,
	                    icon: <TableOutlined />,
	                    type: 'table',
	                    dataRef: {
	                        ...conn,
	                        tableName: entry.tableName,
	                        schemaName: entry.schemaName,
	                        rowCount: entry.rowCount,
	                        comment: entry.comment,
	                        ...(isPinned ? { pinnedSidebarTable: true } : {}),
	                    },
	                    isLeaf: false,
	                };
	            };

	            const buildViewNode = (entry: { viewName: string; schemaName: string; displayName: string }): TreeNode => {
	                const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.viewName);
	                return {
	                    title: entry.displayName,
	                    key: `${conn.id}-${conn.dbName}-view-${keyName}`,
	                    icon: <EyeOutlined />,
	                    type: 'view',
	                    dataRef: { ...conn, viewName: entry.viewName, tableName: entry.viewName, schemaName: entry.schemaName },
	                    isLeaf: true,
	                };
	            };

	            const buildMaterializedViewNode = (entry: { viewName: string; schemaName: string; displayName: string }): TreeNode => {
	                const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.viewName);
	                return {
	                    title: entry.displayName,
	                    key: `${conn.id}-${conn.dbName}-materialized-view-${keyName}`,
	                    icon: <ThunderboltOutlined />,
	                    type: 'materialized-view',
	                    dataRef: { ...conn, viewName: entry.viewName, tableName: entry.viewName, schemaName: entry.schemaName, objectKind: 'materialized-view' },
	                    isLeaf: true,
	                };
	            };

	            const buildTriggerNode = (entry: { triggerName: string; tableName: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-trigger-${entry.triggerName}-${entry.tableName}`,
	                icon: <FunctionOutlined />,
	                type: 'db-trigger',
	                dataRef: { ...conn, triggerName: entry.triggerName, triggerTableName: entry.tableName, tableName: entry.tableName, schemaName: entry.schemaName },
	                isLeaf: true,
	            });

	            const buildRoutineNode = (entry: { routineName: string; routineType: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-routine-${entry.routineName}`,
	                icon: <CodeOutlined />,
	                type: 'routine',
	                dataRef: { ...conn, routineName: entry.routineName, routineType: entry.routineType, schemaName: entry.schemaName },
	                isLeaf: true,
	            });

	            const buildSequenceNode = (entry: { sequenceName: string; schemaName: string; displayName: string }): TreeNode => {
	                const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.sequenceName);
	                return {
	                    title: entry.displayName,
	                    key: `${conn.id}-${conn.dbName}-sequence-${keyName}`,
	                    icon: <KeyOutlined />,
	                    type: 'sequence',
	                    dataRef: { ...conn, sequenceName: entry.sequenceName, schemaName: entry.schemaName },
	                    isLeaf: true,
	                };
	            };

	            const buildPackageNode = (entry: { packageName: string; schemaName: string; displayName: string }): TreeNode => {
	                const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.packageName);
	                return {
	                    title: entry.displayName,
	                    key: `${conn.id}-${conn.dbName}-package-${keyName}`,
	                    icon: <CodeOutlined />,
	                    type: 'package',
	                    dataRef: { ...conn, packageName: entry.packageName, schemaName: entry.schemaName },
	                    isLeaf: true,
	                };
	            };

	            const buildEventNode = (entry: { eventName: string; schemaName: string; displayName: string; eventType?: string; status?: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-event-${entry.schemaName}-${entry.eventName}`,
	                icon: <ClockCircleOutlined />,
	                type: 'db-event',
	                dataRef: { ...conn, eventName: entry.eventName, schemaName: entry.schemaName, eventType: entry.eventType, eventStatus: entry.status },
	                isLeaf: true,
	            });

	            const buildObjectGroup = (
	                parentKey: string,
	                groupKey: string,
	                groupTitle: string,
	                groupIcon: React.ReactNode,
	                children: TreeNode[],
	                extraData: Record<string, any> = {}
	            ): TreeNode => {
	                const groupNodeKey = `${parentKey}-${groupKey}`;
	                const groupedChildren = groupKey === 'tables'
	                    ? buildSidebarTableChildrenForUi(groupNodeKey, children, isV2Ui)
	                    : children;
	                return {
	                    title: groupTitle,
	                    key: groupNodeKey,
	                    icon: groupIcon,
	                    type: 'object-group',
	                    isLeaf: children.length === 0,
	                    children: groupedChildren.length > 0 ? groupedChildren : undefined,
	                    dataRef: { ...conn, dbName: conn.dbName, groupKey, ...extraData }
	                };
	            };

	            const shouldGroupBySchema = shouldHideSchemaPrefix(conn as SavedConnection);
	            if (shouldGroupBySchema) {
	                type SchemaBucket = {
	                    schemaName: string;
	                    tables: TreeNode[];
	                    views: TreeNode[];
	                    materializedViews: TreeNode[];
	                    routines: TreeNode[];
	                    sequences: TreeNode[];
	                    packages: TreeNode[];
	                    triggers: TreeNode[];
	                    events: TreeNode[];
	                };

	                const schemaMap = new Map<string, SchemaBucket>();
	                const getSchemaBucket = (rawSchemaName: string): SchemaBucket => {
	                    const schemaName = String(rawSchemaName || '').trim();
	                    const schemaKey = schemaName || '__default__';
	                    let bucket = schemaMap.get(schemaKey);
	                    if (!bucket) {
	                        bucket = {
	                            schemaName,
	                            tables: [],
	                            views: [],
	                            materializedViews: [],
	                            routines: [],
	                            sequences: [],
	                            packages: [],
	                            triggers: [],
	                            events: [],
	                        };
	                        schemaMap.set(schemaKey, bucket);
	                    }
	                    return bucket;
	                };

	                schemaRows.forEach((schemaName) => getSchemaBucket(schemaName));
	                sortedTableEntries.forEach((entry) => getSchemaBucket(entry.schemaName).tables.push(buildTableNode(entry)));
	                viewEntries.forEach((entry) => getSchemaBucket(entry.schemaName).views.push(buildViewNode(entry)));
	                materializedViewEntries.forEach((entry) => getSchemaBucket(entry.schemaName).materializedViews.push(buildMaterializedViewNode(entry)));
	                routineEntries.forEach((entry) => getSchemaBucket(entry.schemaName).routines.push(buildRoutineNode(entry)));
	                sequenceEntries.forEach((entry) => getSchemaBucket(entry.schemaName).sequences.push(buildSequenceNode(entry)));
	                packageEntries.forEach((entry) => getSchemaBucket(entry.schemaName).packages.push(buildPackageNode(entry)));
	                triggerEntries.forEach((entry) => getSchemaBucket(entry.schemaName).triggers.push(buildTriggerNode(entry)));
	                eventEntries.forEach((entry) => getSchemaBucket(entry.schemaName).events.push(buildEventNode(entry)));

	                const dialect = getMetadataDialect(conn as SavedConnection);
	                const isOracleLike = (dialect === 'oracle' || dialect === 'dm');
	                const includeMaterializedViews = dialect === 'starrocks';
	                const includeOracleObjects = isOracleLike;
	                const includeEvents = supportsDatabaseEvents(conn as SavedConnection);

	                const schemaNodes: TreeNode[] = Array.from(schemaMap.values())
	                    .filter((bucket) => !(isOracleLike && !bucket.schemaName))
	                    .sort((a, b) => {
	                        if (!a.schemaName && !b.schemaName) return 0;
	                        if (!a.schemaName) return -1;
	                        if (!b.schemaName) return 1;
	                        return a.schemaName.toLowerCase().localeCompare(b.schemaName.toLowerCase());
	                    })
	                    .map((bucket) => {
	                    const schemaNodeKey = `${key}-schema-${bucket.schemaName || 'default'}`;
	                    const schemaTitle = bucket.schemaName || t('sidebar.tree.default_schema');
	                        const groupedNodes: TreeNode[] = [
	                            buildObjectGroup(schemaNodeKey, 'tables', t('sidebar.object_group.tables'), <TableOutlined />, bucket.tables, { schemaName: bucket.schemaName }),
	                            buildObjectGroup(schemaNodeKey, 'views', t('sidebar.object_group.views'), <EyeOutlined />, bucket.views, { schemaName: bucket.schemaName }),
	                            ...(includeMaterializedViews ? [buildObjectGroup(schemaNodeKey, 'materializedViews', t('sidebar.object_group.materialized_views'), <ThunderboltOutlined />, bucket.materializedViews, { schemaName: bucket.schemaName })] : []),
	                            ...(includeOracleObjects ? [buildObjectGroup(schemaNodeKey, 'sequences', t('sidebar.object_group.sequences'), <KeyOutlined />, bucket.sequences, { schemaName: bucket.schemaName })] : []),
	                            buildObjectGroup(schemaNodeKey, 'routines', t('sidebar.object_group.routines'), <CodeOutlined />, bucket.routines, { schemaName: bucket.schemaName }),
	                            ...(includeOracleObjects ? [buildObjectGroup(schemaNodeKey, 'packages', t('sidebar.object_group.packages'), <CodeOutlined />, bucket.packages, { schemaName: bucket.schemaName })] : []),
	                            buildObjectGroup(schemaNodeKey, 'triggers', t('sidebar.object_group.triggers'), <FunctionOutlined />, bucket.triggers, { schemaName: bucket.schemaName }),
	                            ...(includeEvents ? [buildObjectGroup(schemaNodeKey, 'events', t('sidebar.object_group.events'), <ClockCircleOutlined />, bucket.events, { schemaName: bucket.schemaName })] : []),
	                        ];

	                        return {
	                            title: schemaTitle,
	                            key: schemaNodeKey,
	                            icon: <FolderOpenOutlined />,
	                            type: 'object-group' as const,
	                            isLeaf: groupedNodes.length === 0,
	                            children: groupedNodes,
	                            dataRef: { ...conn, dbName: conn.dbName, groupKey: 'schema', schemaName: bucket.schemaName }
	                        };
	                    });

	                replaceTreeNodeChildren(key, [queriesNode, ...schemaNodes]);
	            } else {
	                const dialect = getMetadataDialect(conn as SavedConnection);
	                const includeMaterializedViews = dialect === 'starrocks';
	                const includeOracleObjects = dialect === 'oracle' || dialect === 'dm';
	                const includeEvents = supportsDatabaseEvents(conn as SavedConnection);
	                const groupedNodes: TreeNode[] = [
	                    buildObjectGroup(key as string, 'tables', t('sidebar.object_group.tables'), <TableOutlined />, sortedTableEntries.map(buildTableNode)),
	                    buildObjectGroup(key as string, 'views', t('sidebar.object_group.views'), <EyeOutlined />, viewEntries.map(buildViewNode)),
	                    ...(includeMaterializedViews ? [buildObjectGroup(key as string, 'materializedViews', t('sidebar.object_group.materialized_views'), <ThunderboltOutlined />, materializedViewEntries.map(buildMaterializedViewNode))] : []),
	                    ...(includeOracleObjects ? [buildObjectGroup(key as string, 'sequences', t('sidebar.object_group.sequences'), <KeyOutlined />, sequenceEntries.map(buildSequenceNode))] : []),
	                    buildObjectGroup(key as string, 'routines', t('sidebar.object_group.routines'), <CodeOutlined />, routineEntries.map(buildRoutineNode)),
	                    ...(includeOracleObjects ? [buildObjectGroup(key as string, 'packages', t('sidebar.object_group.packages'), <CodeOutlined />, packageEntries.map(buildPackageNode))] : []),
	                    buildObjectGroup(key as string, 'triggers', t('sidebar.object_group.triggers'), <FunctionOutlined />, triggerEntries.map(buildTriggerNode)),
	                    ...(includeEvents ? [buildObjectGroup(key as string, 'events', t('sidebar.object_group.events'), <ClockCircleOutlined />, eventEntries.map(buildEventNode))] : []),
	                ];

	                replaceTreeNodeChildren(key, [queriesNode, ...groupedNodes]);
	            }
                onDatabaseTreeLoaded?.(String(key));
	          } else {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
	            message.error({ content: res.message, key: `db-${key}-tables` });
          }
	      } catch (e: any) {
	          setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
	          message.error({
	              content: t('sidebar.message.load_table_list_failed', { error: e?.message || String(e) }),
	              key: `db-${key}-tables`,
	          });
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
	      }
  };


  return {
      loadDatabases,
      loadJVMResources,
      loadTables,
  };
};
