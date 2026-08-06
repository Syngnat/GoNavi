import React, { useRef } from 'react';
import { message } from 'antd';
import {
  AppstoreOutlined,
  CloudOutlined,
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
  LinkOutlined,
  TableOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { SavedConnection, SavedQuery, JVMCapability, JVMResourceSummary } from '../../types';
import { useStore } from '../../store';
import { t } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { filterVisibleDatabaseNames } from '../../utils/databaseVisibility';
import { buildRedisDbNodeLabel, getRedisDbAlias } from '../../utils/redisDbAlias';
import { buildJVMMonitoringActionDescriptors } from '../../utils/jvmSidebarActions';
import { getSchemaVisibilityRule, isSchemaVisible } from '../../utils/schemaVisibility';
import { type SidebarViewMetadataEntry } from '../../utils/sidebarMetadata';
import { resolveNacosConnectionScope } from '../../utils/nacosConnectionScope';
import {
  buildQualifiedName,
  buildSidebarObjectKeyName,
  buildSidebarTableStatusSQL,
  getCaseInsensitiveValue,
  getMetadataDialect,
  getMySQLShowTablesName,
  getSidebarTableName,
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
  shouldHideSchemaPrefix,
  splitQualifiedName,
  supportsDatabaseEvents,
  supportsDatabaseSequences,
} from './sidebarMetadataLoaders';
import {
  applySidebarDatabasePinning,
  buildSidebarTableChildrenForUi,
  buildV2SidebarDatabaseSectionedChildren,
  isSidebarTablePinned,
  sortSidebarTableEntries,
  type SidebarConnectionState,
  type SidebarTreeNode as TreeNode,
} from '../sidebarV2Utils';
import {
  groupSidebarPartitionTableEntries,
} from './sidebarPartitions';
import { DBGetDatabases, DBGetTables, DBQuery, GetDriverStatusList, JVMProbeCapabilities } from '../../../wailsjs/go/app/App';
import type { SidebarTableMetadataSnapshot } from '../../utils/sidebarTableMetadata';
import { collectNacosServiceGroupsByPage } from '../nacosServiceName';

type DriverStatusSnapshot = {
  type: string;
  name: string;
  connectable: boolean;
  expectedRevision?: string;
  needsUpdate?: boolean;
  updateReason?: string;
  message?: string;
};

type SidebarLoadedTableMetadata = SidebarTableMetadataSnapshot & {
  schemaName?: string;
  partitionParentTableName?: string;
};

type SidebarLoadedTableEntry = {
  tableName: string;
  schemaName: string;
  displayName: string;
  rowCount?: number;
  tableSize?: number;
  createdAt?: string;
  updatedAt?: string;
  tableComment?: string;
  partitionParentTableName?: string;
  partitionTables?: SidebarLoadedTableEntry[];
};

export type SidebarTreeLoadOptions = {
  ensureFresh?: boolean;
};

type TrackedSidebarLoad = {
  promise: Promise<void>;
  signature?: string;
};

const scheduleSidebarLoad = (
  activeLoads: Map<string, TrackedSidebarLoad>,
  loadKey: string,
  run: () => Promise<void>,
  options: SidebarTreeLoadOptions,
  signature?: string,
): Promise<void> => {
  const activeLoad = activeLoads.get(loadKey);
  const hasDifferentSignature =
    signature !== undefined
    && activeLoad?.signature !== undefined
    && activeLoad.signature !== signature;
  const shouldStartConcurrent = hasDifferentSignature && !options.ensureFresh;

  if (activeLoad && !shouldStartConcurrent) {
    if (!options.ensureFresh) {
      return Promise.resolve();
    }

    let queuedLoad!: Promise<void>;
    queuedLoad = activeLoad.promise
      .catch(() => undefined)
      .then(run)
      .finally(() => {
        if (activeLoads.get(loadKey)?.promise === queuedLoad) {
          activeLoads.delete(loadKey);
        }
      });
    activeLoads.set(loadKey, { promise: queuedLoad, signature });
    return queuedLoad;
  }

  let currentLoad!: Promise<void>;
  currentLoad = run().finally(() => {
    if (activeLoads.get(loadKey)?.promise === currentLoad) {
      activeLoads.delete(loadKey);
    }
  });
  activeLoads.set(loadKey, { promise: currentLoad, signature });
  return currentLoad;
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
    includeDatabasePatterns: conn.includeDatabasePatterns || [],
    excludeDatabasePatterns: conn.excludeDatabasePatterns || [],
    includeRedisDatabases: conn.includeRedisDatabases || [],
    schemaVisibilityByDatabase: conn.schemaVisibilityByDatabase || {},
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
  pinnedSidebarDatabases: string[];
  isV2Ui: boolean;
  loadingNodesRef: React.MutableRefObject<Set<string>>;
  setConnectionStates: React.Dispatch<React.SetStateAction<Record<string, SidebarConnectionState>>>;
  setLoadedKeys: React.Dispatch<React.SetStateAction<React.Key[]>>;
  replaceTreeNodeChildren: (key: React.Key, children: TreeNode[] | undefined, dataRef?: unknown) => TreeNode[];
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
  pinnedSidebarDatabases,
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
  const databaseRequestIdsRef = useRef<Record<string, number>>({});
  const nacosServiceGroupRequestIdsRef = useRef<Record<string, number>>({});
  const nacosNamespaceRequestIdsRef = useRef<Record<string, number>>({});
  const nacosNamespaceActiveRequestsRef = useRef<
      Record<string, { requestId: number; signature: string }>
  >({});
  const databaseLoadsRef = useRef<Map<string, TrackedSidebarLoad>>(new Map());
  const tableLoadsRef = useRef<Map<string, TrackedSidebarLoad>>(new Map());

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
	  const runLoadDatabases = async (node: any) => {
		      const conn = node.dataRef as SavedConnection;
		      const loadKey = `dbs-${conn.id}`;
          let nacosNamespaceRequest:
              | { requestId: number; signature: string }
              | undefined;
          if (conn.config.type === 'nacos') {
              const signature = buildConnectionReloadSignature(conn);
              const activeRequest =
                  nacosNamespaceActiveRequestsRef.current[conn.id];
              if (activeRequest?.signature === signature) {
                  return;
              }
              const requestId =
                  (nacosNamespaceRequestIdsRef.current[conn.id] || 0) + 1;
              nacosNamespaceRequestIdsRef.current[conn.id] = requestId;
              nacosNamespaceRequest = { requestId, signature };
              nacosNamespaceActiveRequestsRef.current[conn.id] =
                  nacosNamespaceRequest;
              loadingNodesRef.current.add(loadKey);
          } else {
              if (loadingNodesRef.current.has(loadKey)) return;
              loadingNodesRef.current.add(loadKey);
          }
          setConnectionStates(prev => ({ ...prev, [conn.id]: 'loading' }));
          let shouldMarkConnectionSuccess = false;
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
                      shouldMarkConnectionSuccess = true;
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
                  if (shouldMarkConnectionSuccess) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                  }
              }
              return;
          }

          // Handle Redis connections differently
          if (conn.config.type === 'redis') {
              try {
                  const res = await (window as any).go.app.App.RedisGetDatabases(buildRpcConnectionConfig(config));
                  if (res.success) {
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
                      replaceTreeNodeChildren(node.key, dbs, conn);
                      shouldMarkConnectionSuccess = true;
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
                  if (shouldMarkConnectionSuccess) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                  }
              }
              return;
          }

          // Handle Nacos connections: expand namespaces
          if (conn.config.type === 'nacos') {
              const { requestId, signature: requestSignature } =
                  nacosNamespaceRequest!;
              const isLatestNamespaceRequest = () =>
                  nacosNamespaceRequestIdsRef.current[conn.id] === requestId;
              const resolveCurrentRequestConnection = (): SavedConnection | null => {
                  if (!isLatestNamespaceRequest()) {
                      return null;
                  }
                  const currentConnection = useStore.getState().connections.find(
                      (candidate) => candidate.id === conn.id,
                  );
                  if (
                      !currentConnection ||
                      buildConnectionReloadSignature(currentConnection) !== requestSignature
                  ) {
                      return null;
                  }
                  return currentConnection;
              };
              type NacosNamespaceDiscoveryMode = 'listed' | 'configured';
              const buildNamespaceNode = (
                  sourceConnection: SavedConnection,
                  namespaceId: string,
                  showName: string,
                  configCount: number,
                  discoveryMode: NacosNamespaceDiscoveryMode,
              ): TreeNode => {
                  const nodeKeyId = namespaceId || 'public';
                  const nsDataRef = {
                      ...sourceConnection,
                      nacosNamespaceId: namespaceId,
                      nacosNamespaceName: showName,
                      nacosConfigCount: Number.isFinite(configCount) ? configCount : 0,
                      nacosNamespaceDiscoveryMode: discoveryMode,
                  };
                  return {
                      title: showName,
                      key: `${conn.id}-nacos-ns-${nodeKeyId}`,
                      icon: <DatabaseOutlined style={{ color: '#2E6BE6' }} />,
                      type: 'nacos-namespace',
                      dataRef: nsDataRef,
                      isLeaf: false,
                      children: [
                          {
                              title: t('nacos_viewer.title.config_explorer'),
                              key: `${conn.id}-nacos-ns-${nodeKeyId}-config`,
                              icon: <DatabaseOutlined style={{ color: '#2E6BE6' }} />,
                              type: 'nacos-config-entry',
                              dataRef: nsDataRef,
                              // Expand to load Group list.
                              isLeaf: false,
                          },
                          {
                              title: t('nacos_service.title.service_explorer'),
                              key: `${conn.id}-nacos-ns-${nodeKeyId}-services`,
                              icon: <CloudOutlined style={{ color: '#13C2C2' }} />,
                              type: 'nacos-services-entry',
                              dataRef: nsDataRef,
                              isLeaf: false,
                          },
                      ],
                  };
              };
              try {
                  const res = await (window as any).go.app.App.NacosListNamespaces(buildRpcConnectionConfig(config));
                  const currentConnection = resolveCurrentRequestConnection();
                  if (!currentConnection) {
                      return;
                  }
                  if (res.success) {
                      const rows: any[] = Array.isArray(res.data) ? res.data : [];
                      const namespaces = rows.map((ns: any) => {
                          const namespaceId = String(ns.id ?? ns.ID ?? '');
                          const showName = String(ns.showName || ns.ShowName || (namespaceId || 'public'));
                          const configCount = Number(ns.configCount ?? ns.ConfigCount ?? 0);
                          return buildNamespaceNode(
                              currentConnection,
                              namespaceId,
                              showName,
                              configCount,
                              'listed',
                          );
                      });
                      replaceTreeNodeChildren(node.key, namespaces, {
                          ...currentConnection,
                          nacosNamespaceDiscoveryMode: 'listed',
                      });
                      shouldMarkConnectionSuccess = true;
                  } else {
                      const errorCode = String(res?.data?.errorCode || '');
                      const scope = resolveNacosConnectionScope(
                          currentConnection.config.connectionParams,
                      );
                      if (
                          errorCode === 'nacos_namespace_list_forbidden' &&
                          scope.configured
                      ) {
                          const namespace = buildNamespaceNode(
                              currentConnection,
                              scope.requestNamespaceId,
                              scope.namespaceId,
                              0,
                              'configured',
                          );
                          replaceTreeNodeChildren(node.key, [namespace], {
                              ...currentConnection,
                              nacosNamespaceDiscoveryMode: 'configured',
                          });
                          shouldMarkConnectionSuccess = true;
                          message.warning({
                              content: t('nacos.namespace.message.scoped_fallback', {
                                  id: scope.namespaceId,
                              }),
                              key: `conn-${currentConnection.id}-nacos-ns`,
                          });
                      } else {
                          setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
                          setLoadedKeys(prev => prev.filter(k => k !== node.key));
                          message.error({
                              content:
                                  errorCode === 'nacos_namespace_list_forbidden'
                                      ? t('nacos.namespace.message.scope_required')
                                      : res.message,
                              key: `conn-${currentConnection.id}-nacos-ns`,
                          });
                      }
                  }
              } catch (e: any) {
                  const currentConnection = resolveCurrentRequestConnection();
                  if (!currentConnection) {
                      return;
                  }
                  setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
                  setLoadedKeys(prev => prev.filter(k => k !== node.key));
                  message.error({
                      content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                      key: `conn-${currentConnection.id}-nacos-ns`,
                  });
              } finally {
                  const activeRequest =
                      nacosNamespaceActiveRequestsRef.current[conn.id];
                  if (activeRequest?.requestId === requestId) {
                      delete nacosNamespaceActiveRequestsRef.current[conn.id];
                      loadingNodesRef.current.delete(loadKey);
                      const currentConnection = resolveCurrentRequestConnection();
                      if (shouldMarkConnectionSuccess) {
                          if (currentConnection) {
                              setConnectionStates(prev => ({
                                  ...prev,
                                  [currentConnection.id]: 'success',
                              }));
                          }
                      }
                  }
              }
              return;
          }

	      const databaseRequestId =
              (databaseRequestIdsRef.current[conn.id] || 0) + 1;
          databaseRequestIdsRef.current[conn.id] = databaseRequestId;
          const databaseRequestSignature = buildConnectionReloadSignature(conn);
          const resolveCurrentDatabaseRequestConnection = (): SavedConnection | null => {
              if (databaseRequestIdsRef.current[conn.id] !== databaseRequestId) {
                  return null;
              }
              const currentConnection = useStore.getState().connections.find(
                  (candidate) => candidate.id === conn.id,
              );
              if (
                  !currentConnection ||
                  buildConnectionReloadSignature(currentConnection) !== databaseRequestSignature
              ) {
                  return null;
              }
              return currentConnection;
          };

	      try {
	          const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
              const currentConnection = resolveCurrentDatabaseRequestConnection();
              if (!currentConnection) {
                  return;
              }
	          if (res.success) {
                const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
                const databaseNames = filterVisibleDatabaseNames(
                    currentConnection,
                    dbRows
                        .map((row: any) => row.Database || row.database)
                        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0),
                );
	            let dbs: TreeNode[] = databaseNames.map((databaseName) => ({
	              title: databaseName,
              key: `${currentConnection.id}-${databaseName}`,
              icon: <DatabaseOutlined />,
              type: 'database' as const,
              dataRef: { ...currentConnection, dbName: databaseName },
              isLeaf: false,
            }));

            if (isV2Ui) {
                const currentPinnedSidebarDatabases =
                    useStore.getState().pinnedSidebarDatabases || pinnedSidebarDatabases;
                dbs = buildV2SidebarDatabaseSectionedChildren(
                    String(node.key),
                    applySidebarDatabasePinning(dbs, {
                        connectionId: currentConnection.id,
                        pinnedSidebarDatabases: currentPinnedSidebarDatabases,
                    }),
                );
            }

            if (dbs.length > 0) {
                replaceTreeNodeChildren(node.key, dbs, currentConnection);
            } else {
                // 空列表：清理 loadedKeys 以允许重新加载，不设置 children = []
                setLoadedKeys(prev => prev.filter(k => k !== node.key));
                message.warning({ content: t('sidebar.message.no_visible_databases'), key: `conn-${currentConnection.id}-dbs` });
            }
            shouldMarkConnectionSuccess = true;
	          } else {
	            setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
	            setLoadedKeys(prev => prev.filter(k => k !== node.key));
	            message.error({ content: res.message, key: `conn-${currentConnection.id}-dbs` });
	          }
	      } catch (e: any) {
	          const currentConnection = resolveCurrentDatabaseRequestConnection();
              if (!currentConnection) {
                  return;
              }
	          setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
	          setLoadedKeys(prev => prev.filter(k => k !== node.key));
	          message.error({
                content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                key: `conn-${currentConnection.id}-dbs`,
            });
	      } finally {
              if (databaseRequestIdsRef.current[conn.id] === databaseRequestId) {
	              loadingNodesRef.current.delete(loadKey);
                  const currentConnection = resolveCurrentDatabaseRequestConnection();
                  if (shouldMarkConnectionSuccess && currentConnection) {
                      setConnectionStates(prev => ({
                          ...prev,
                          [currentConnection.id]: 'success',
                      }));
                  }
              }
	      }
  };

  const loadDatabases = (
      node: any,
      options: SidebarTreeLoadOptions = {},
  ): Promise<void> => {
      const conn = node.dataRef as SavedConnection;
      const loadKey = `dbs-${conn.id}`;
      const signature = buildConnectionReloadSignature(conn);
      return scheduleSidebarLoad(
          databaseLoadsRef.current,
          loadKey,
          () => runLoadDatabases(node),
          options,
          signature,
      );
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

	  const runLoadTables = async (node: any) => {
	      const conn = node.dataRef; // has dbName
	      const dbName = conn.dbName;
      const key = node.key;
      const loadKey = `tables-${conn.id}-${dbName}`;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);
      setConnectionStates(prev => ({ ...prev, [key as string]: 'loading' }));
      let shouldMarkDatabaseSuccess = false;
      
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
                const tableRows: any[] = Array.isArray(res.data) ? res.data : [];
                const tableStatusSql = buildSidebarTableStatusSQL(conn as SavedConnection, conn.dbName);
                const tableStatsResult = tableStatusSql
                    ? await DBQuery(buildRpcConnectionConfig(config) as any, conn.dbName, tableStatusSql).catch(() => ({ success: false, data: [] as any[] }))
                    : { success: false, data: [] as any[] };
                const tableMetadataMap = new Map<string, SidebarLoadedTableMetadata>();
                const buildTableMetadataKeys = (rawTableName: string, rawSchemaName = ''): string[] => {
                    const tableName = String(rawTableName || '').trim();
                    if (!tableName) return [];
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
                    buildTableMetadataKeys(rawTableName, rawSchemaName).forEach((metadataKey) => {
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
                    const rowCount = parseMetadataRowCount(row);
                    if (tableName && rowCount !== undefined) {
                        mergeTableMetadata(tableName, { rowCount });
                    }
                });
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
                        const rowCount = parseMetadataRowCount(row);
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
                    const metadataKeys = buildTableMetadataKeys(tableName);
                    const resolvedMetadata = metadataKeys
                        .map((metadataKey) => tableMetadataMap.get(metadataKey))
                        .find((value): value is SidebarLoadedTableMetadata => !!value);
                    const rowSchemaName = getCaseInsensitiveValue(row, ['schema_name', 'SCHEMA_NAME', 'owner', 'OWNER']);
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
                        rowCount: parseMetadataRowCount(row) ?? resolvedMetadata?.rowCount,
                        tableSize: resolvedMetadata?.tableSize,
                        createdAt: resolvedMetadata?.createdAt,
                        updatedAt: resolvedMetadata?.updatedAt,
                        tableComment: rowComment
                            || resolvedMetadata?.tableComment
                            || '',
	                    partitionParentTableName: resolvedMetadata?.partitionParentTableName,
	                };
	            }) as SidebarLoadedTableEntry[];

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
            const normalizedSchemaRows = schemaRows
                .map((schemaName) => String(schemaName || '').trim())
                .filter((schemaName) => schemaName !== '');
            const normalizedTableEntries = tableEntries.map((entry) => {
                if (entry.schemaName || normalizedSchemaRows.length !== 1) {
                    return entry;
                }
                return {
                    ...entry,
                    schemaName: normalizedSchemaRows[0],
                };
            });

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

            const routineEntries = (() => {
                const deduped: Array<{ routineName: string; routineType: string; schemaName: string; displayName: string }> = [];
                const routineSeen = new Set<string>();
                routineRows.forEach((routine: any) => {
                    const parsed = splitQualifiedName(routine.routineName);
                    const routineType = String(routine.routineType || 'FUNCTION').toUpperCase().includes('PROC')
                        ? 'PROCEDURE'
                        : 'FUNCTION';
                    const schemaName = String(parsed.schemaName || routine.schemaName || '').trim();
                    const objectName = String(parsed.objectName || routine.routineName || '').trim();
                    if (!objectName) return;
                    const routineName = String(routine.routineName || objectName).trim();
                    const typeLabel = routineType === 'PROCEDURE' ? 'P' : 'F';
                    const dedupeKey = `${schemaName.toLowerCase()}@@${objectName.toLowerCase()}@@${routineType}`;
                    if (routineSeen.has(dedupeKey)) return;
                    routineSeen.add(dedupeKey);
                    deduped.push({
                        routineName,
                        routineType,
                        schemaName,
                        displayName: `${objectName} [${typeLabel}]`,
                    });
                });
                return deduped;
            })();

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
	            // Metadata loading can overlap with a schema visibility save. Build partition
	            // relationships from the newest visible table set so hidden schemas cannot leak
	            // through a visible parent, and visible children do not disappear with a hidden parent.
	            const latestConnection = useStore.getState().connections.find(
	                (candidate) => candidate.id === conn.id,
	            ) || conn;
	            const latestDatabaseConnection = { ...latestConnection, dbName };
	            const shouldGroupBySchema = shouldHideSchemaPrefix(latestDatabaseConnection as SavedConnection);
	            const schemaVisibilityRule = getSchemaVisibilityRule(latestDatabaseConnection, dbName);

	            // 获取当前数据库的排序偏好
	            const sortPreferenceKey = `${conn.id}-${conn.dbName}`;
	            const sortBy = currentTableSortPreference[sortPreferenceKey] || 'name';

	            const sortedTableEntries = groupSidebarPartitionTableEntries(sortSidebarTableEntries(normalizedTableEntries, {
	                connectionId: conn.id,
	                dbName: conn.dbName,
	                sortBy,
	                tableAccessCount: currentTableAccessCount,
	                pinnedSidebarTables: isV2Ui ? currentPinnedSidebarTables : [],
	            }), {
	                isEntryVisible: (entry) => !shouldGroupBySchema
	                    || isSchemaVisible(schemaVisibilityRule, entry.schemaName),
	            }) as SidebarLoadedTableEntry[];

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

	            const buildTableNode = (entry: SidebarLoadedTableEntry): TreeNode => {
	                const isPinned = isV2Ui && isSidebarTablePinned(
	                    currentPinnedSidebarTables,
	                    conn.id,
	                    conn.dbName,
	                    entry.tableName,
	                    entry.schemaName,
	                );
	                const nodeKey = `${conn.id}-${conn.dbName}-${entry.tableName}`;
	                const tableDataRef = {
	                    ...conn,
	                    tableName: entry.tableName,
	                    schemaName: entry.schemaName,
	                    ...(entry.rowCount !== undefined ? { rowCount: entry.rowCount } : {}),
                        tableSize: entry.tableSize,
                        createdAt: entry.createdAt,
                        updatedAt: entry.updatedAt,
                        tableComment: entry.tableComment,
	                    ...(isPinned ? { pinnedSidebarTable: true } : {}),
	                };
	                const partitionNodes = (entry.partitionTables || []).map(buildTableNode);
	                const children: TreeNode[] | undefined = partitionNodes.length > 0
	                    ? [
	                        {
	                            title: t('sidebar.table_folder.columns'),
	                            key: `${nodeKey}-columns`,
	                            icon: <UnorderedListOutlined />,
	                            type: 'folder-columns',
	                            isLeaf: true,
	                            dataRef: tableDataRef,
	                        },
	                        {
	                            title: t('sidebar.table_folder.indexes'),
	                            key: `${nodeKey}-indexes`,
	                            icon: <KeyOutlined style={{ transform: 'rotate(45deg)' }} />,
	                            type: 'folder-indexes',
	                            isLeaf: true,
	                            dataRef: tableDataRef,
	                        },
	                        {
	                            title: t('sidebar.table_folder.foreign_keys'),
	                            key: `${nodeKey}-fks`,
	                            icon: <LinkOutlined />,
	                            type: 'folder-fks',
	                            isLeaf: true,
	                            dataRef: tableDataRef,
	                        },
	                        {
	                            title: t('sidebar.table_folder.triggers'),
	                            key: `${nodeKey}-triggers`,
	                            icon: <ThunderboltOutlined />,
	                            type: 'folder-triggers',
	                            isLeaf: true,
	                            dataRef: tableDataRef,
	                        },
	                        {
	                            title: t('sidebar.table_folder.partitions'),
	                            key: `${nodeKey}-partitions`,
	                            icon: <FolderOpenOutlined />,
	                            type: 'object-group',
	                            isLeaf: false,
	                            selectable: false,
	                            children: partitionNodes,
	                            dataRef: {
	                                ...tableDataRef,
	                                groupKey: 'partitions',
	                                partitionCount: partitionNodes.length,
	                            },
	                        },
	                    ]
	                    : undefined;
	                return {
	                    title: entry.displayName,
	                    key: nodeKey,
	                    icon: <TableOutlined />,
	                    type: 'table',
	                    dataRef: tableDataRef,
	                    ...(children ? { children } : {}),
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

	            const buildRoutineNode = (entry: { routineName: string; routineType: string; schemaName: string; displayName: string }): TreeNode => {
	                const typeToken = entry.routineType === 'PROCEDURE' ? 'proc' : 'func';
	                const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.routineName);
	                return {
	                    title: entry.displayName,
	                    // 必须带 routineType：同名函数/过程否则 key 冲突，虚拟列表会叠成“同一函数无限重复”
	                    key: `${conn.id}-${conn.dbName}-routine-${typeToken}-${keyName}`,
	                    icon: <CodeOutlined />,
	                    type: 'routine',
	                    dataRef: { ...conn, routineName: entry.routineName, routineType: entry.routineType, schemaName: entry.schemaName },
	                    isLeaf: true,
	                };
	            };

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
	                const includeSequences = supportsDatabaseSequences(conn as SavedConnection);
	                const includeEvents = supportsDatabaseEvents(conn as SavedConnection);

	                const schemaNodes: TreeNode[] = Array.from(schemaMap.values())
	                    .filter((bucket) => !(isOracleLike && !bucket.schemaName))
	                    .filter((bucket) => isSchemaVisible(schemaVisibilityRule, bucket.schemaName))
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
	                            ...(includeSequences ? [buildObjectGroup(schemaNodeKey, 'sequences', t('sidebar.object_group.sequences'), <KeyOutlined />, bucket.sequences, { schemaName: bucket.schemaName })] : []),
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

	                replaceTreeNodeChildren(key, [queriesNode, ...schemaNodes], latestDatabaseConnection);
	            } else {
	                const dialect = getMetadataDialect(conn as SavedConnection);
	                const includeMaterializedViews = dialect === 'starrocks';
	                const includeOracleObjects = dialect === 'oracle' || dialect === 'dm';
	                const includeSequences = supportsDatabaseSequences(conn as SavedConnection);
	                const includeEvents = supportsDatabaseEvents(conn as SavedConnection);
	                const groupedNodes: TreeNode[] = [
	                    buildObjectGroup(key as string, 'tables', t('sidebar.object_group.tables'), <TableOutlined />, sortedTableEntries.map(buildTableNode)),
	                    buildObjectGroup(key as string, 'views', t('sidebar.object_group.views'), <EyeOutlined />, viewEntries.map(buildViewNode)),
	                    ...(includeMaterializedViews ? [buildObjectGroup(key as string, 'materializedViews', t('sidebar.object_group.materialized_views'), <ThunderboltOutlined />, materializedViewEntries.map(buildMaterializedViewNode))] : []),
	                    ...(includeSequences ? [buildObjectGroup(key as string, 'sequences', t('sidebar.object_group.sequences'), <KeyOutlined />, sequenceEntries.map(buildSequenceNode))] : []),
	                    buildObjectGroup(key as string, 'routines', t('sidebar.object_group.routines'), <CodeOutlined />, routineEntries.map(buildRoutineNode)),
	                    ...(includeOracleObjects ? [buildObjectGroup(key as string, 'packages', t('sidebar.object_group.packages'), <CodeOutlined />, packageEntries.map(buildPackageNode))] : []),
	                    buildObjectGroup(key as string, 'triggers', t('sidebar.object_group.triggers'), <FunctionOutlined />, triggerEntries.map(buildTriggerNode)),
	                    ...(includeEvents ? [buildObjectGroup(key as string, 'events', t('sidebar.object_group.events'), <ClockCircleOutlined />, eventEntries.map(buildEventNode))] : []),
	                ];

	                replaceTreeNodeChildren(key, [queriesNode, ...groupedNodes], latestDatabaseConnection);
	            }
                onDatabaseTreeLoaded?.(String(key));
                shouldMarkDatabaseSuccess = true;
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
              if (shouldMarkDatabaseSuccess) {
                  setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));
              }
	      }
  };

  const loadTables = (
      node: any,
      options: SidebarTreeLoadOptions = {},
  ): Promise<void> => {
      const conn = node.dataRef;
      const loadKey = `tables-${conn.id}-${conn.dbName}`;
      return scheduleSidebarLoad(
          tableLoadsRef.current,
          loadKey,
          () => runLoadTables(node),
          options,
      );
  };


  const loadNacosConfigGroups = async (node: any) => {
      const dataRef = node?.dataRef || {};
      const connectionId = String(dataRef.id || '');
      const namespaceId = String(dataRef.nacosNamespaceId ?? '');
      const namespaceName = String(dataRef.nacosNamespaceName || namespaceId || 'public');
      const nodeKeyId = namespaceId || 'public';
      const loadKey = `nacos-groups-${connectionId}-${nodeKeyId}`;
      if (!connectionId) return;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);
      try {
          const res = await (window as any).go.app.App.NacosListConfigGroups(
              buildRpcConnectionConfig(dataRef.config || {}),
              namespaceId,
          );
          if (!res?.success) {
              message.error({
                  content: res?.message || t('sidebar.message.connection_failed', { error: 'list groups failed' }),
                  key: loadKey,
              });
              setLoadedKeys((prev) => prev.filter((k) => k !== node.key));
              return;
          }
          const groups: string[] = Array.isArray(res.data) ? res.data.map((g: any) => String(g || '').trim()).filter(Boolean) : [];
          // Always offer "全部" so users can open the namespace without a group filter.
          const allNode: TreeNode = {
              title: t('nacos_viewer.label.all'),
              key: `${connectionId}-nacos-ns-${nodeKeyId}-group-__all__`,
              icon: <AppstoreOutlined style={{ color: '#2E6BE6' }} />,
              type: 'nacos-config-group' as const,
              dataRef: {
                  ...dataRef,
                  nacosNamespaceId: namespaceId,
                  nacosNamespaceName: namespaceName,
                  nacosGroup: '',
                  nacosAllConfigs: true,
              },
              isLeaf: true,
          };
          const groupNodes: TreeNode[] = groups.map((group) => ({
              title: group,
              key: `${connectionId}-nacos-ns-${nodeKeyId}-group-${encodeURIComponent(group)}`,
              icon: <FolderOpenOutlined style={{ color: '#2E6BE6' }} />,
              type: 'nacos-config-group' as const,
              dataRef: {
                  ...dataRef,
                  nacosNamespaceId: namespaceId,
                  nacosNamespaceName: namespaceName,
                  nacosGroup: group,
                  nacosAllConfigs: false,
              },
              isLeaf: true,
          }));
          replaceTreeNodeChildren(node.key, [allNode, ...groupNodes], dataRef);
          if (groups.length === 0) {
              message.info({
                  content: t('nacos_viewer.message.no_groups'),
                  key: loadKey,
              });
          }
      } catch (error: any) {
          message.error({
              content: t('sidebar.message.connection_failed', { error: error?.message || String(error) }),
              key: loadKey,
          });
          setLoadedKeys((prev) => prev.filter((k) => k !== node.key));
      } finally {
          loadingNodesRef.current.delete(loadKey);
      }
  };

  const loadNacosServiceGroups = async (
      node: any,
      options: { force?: boolean } = {},
  ): Promise<boolean> => {
      const dataRef = node?.dataRef || {};
      const connectionId = String(dataRef.id || '');
      const namespaceId = String(dataRef.nacosNamespaceId ?? '');
      const namespaceName = String(dataRef.nacosNamespaceName || namespaceId || 'public');
      const nodeKeyId = namespaceId || 'public';
      const loadKey = `nacos-service-groups-${connectionId}-${nodeKeyId}`;
      if (!connectionId) return false;
      if (loadingNodesRef.current.has(loadKey) && !options.force) return false;
      const requestId = (nacosServiceGroupRequestIdsRef.current[loadKey] || 0) + 1;
      nacosServiceGroupRequestIdsRef.current[loadKey] = requestId;
      loadingNodesRef.current.add(loadKey);
      try {
          const rpcConfig = buildRpcConnectionConfig(dataRef.config || {});
          const groups = await collectNacosServiceGroupsByPage(async (pageNo, pageSize) => {
              const res = await (window as any).go.app.App.NacosListServices(rpcConfig, {
                  namespaceId,
                  groupName: '',
                  pageNo,
                  pageSize,
              });
              if (!res?.success) {
                  throw new Error(res?.message || 'list service groups failed');
              }
              return res.data || {};
          });
          if (nacosServiceGroupRequestIdsRef.current[loadKey] !== requestId) {
              return false;
          }

          const allNode: TreeNode = {
              title: t('nacos_viewer.label.all'),
              key: `${connectionId}-nacos-ns-${nodeKeyId}-service-group-__all__`,
              icon: <AppstoreOutlined style={{ color: '#13C2C2' }} />,
              type: 'nacos-service-group',
              dataRef: {
                  ...dataRef,
                  nacosNamespaceId: namespaceId,
                  nacosNamespaceName: namespaceName,
                  nacosGroup: '',
              },
              isLeaf: true,
          };
          const groupNodes: TreeNode[] = groups.map((group) => ({
              title: group,
              key: `${connectionId}-nacos-ns-${nodeKeyId}-service-group-${encodeURIComponent(group)}`,
              icon: <FolderOpenOutlined style={{ color: '#13C2C2' }} />,
              type: 'nacos-service-group',
              dataRef: {
                  ...dataRef,
                  nacosNamespaceId: namespaceId,
                  nacosNamespaceName: namespaceName,
                  nacosGroup: group,
              },
              isLeaf: true,
          }));
          replaceTreeNodeChildren(node.key, [allNode, ...groupNodes], dataRef);
          return true;
      } catch (error: any) {
          if (nacosServiceGroupRequestIdsRef.current[loadKey] !== requestId) {
              return false;
          }
          message.error({
              content: t('sidebar.message.connection_failed', { error: error?.message || String(error) }),
              key: loadKey,
          });
          setLoadedKeys((prev) => prev.filter((k) => k !== node.key));
          return false;
      } finally {
          if (nacosServiceGroupRequestIdsRef.current[loadKey] === requestId) {
              loadingNodesRef.current.delete(loadKey);
          }
      }
  };

  return {
      loadDatabases,
      loadJVMResources,
      loadTables,
      loadNacosConfigGroups,
      loadNacosServiceGroups,
  };
};
