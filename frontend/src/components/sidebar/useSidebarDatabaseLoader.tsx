import type { SavedConnection, JVMCapability } from '../../types';
import {
  buildConnectionReloadSignature,
  dedupeTrimmedDatabaseNames,
  type SidebarTreeLoadOptions,
  scheduleSidebarLoad,
} from './sidebarTreeLoaderHelpers';
import { JVMProbeCapabilities, DBGetDatabases } from '../../../wailsjs/go/app/App';
import {
  type SidebarTreeNode as TreeNode,
  buildV2SidebarDatabaseSectionedChildren,
  applySidebarDatabasePinning,
} from '../sidebarV2Utils';
import {
  HddOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { buildJVMMonitoringActionDescriptors } from '../../utils/jvmSidebarActions';
import { message } from 'antd';
import { t } from '../../i18n';
import { useStore } from '../../store';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { getRedisDbAlias, buildRedisDbNodeLabel } from '../../utils/redisDbAlias';
import { buildNacosNamespaceTreeNode as buildNamespaceNode } from './nacosNamespaceTreeNode';
import { resolveNacosConnectionScope } from '../../utils/nacosConnectionScope';
import { filterVisibleDatabaseNames } from '../../utils/databaseVisibility';
import { resolveSidebarMessageQueueProfile } from './sidebarMessageProfiles';
import { GnDatabaseIcon } from '../icons/gnIcons';
import { resolveDataSourceType } from '../../utils/dataSourceCapabilities';
import { isElasticsearchFamilyType } from '../../utils/elasticsearchFamily';
import type { SidebarTreeLoadStateApi } from './useSidebarTreeLoadState';
import type { UseSidebarTreeLoadersOptions } from './useSidebarTreeLoaders';

export interface UseSidebarDatabaseLoaderInput {
  loadingNodesRef: UseSidebarTreeLoadersOptions['loadingNodesRef'];
  setConnectionStates: UseSidebarTreeLoadersOptions['setConnectionStates'];
  buildRuntimeConfig: UseSidebarTreeLoadersOptions['buildRuntimeConfig'];
  buildJVMDiagnosticTreeNodes: UseSidebarTreeLoadersOptions['buildJVMDiagnosticTreeNodes'];
  replaceTreeNodeChildren: UseSidebarTreeLoadersOptions['replaceTreeNodeChildren'];
  setLoadedKeys: UseSidebarTreeLoadersOptions['setLoadedKeys'];
  pinnedSidebarDatabases: UseSidebarTreeLoadersOptions['pinnedSidebarDatabases'];
  getConnectionLoadEpoch: SidebarTreeLoadStateApi['getConnectionLoadEpoch'];
  isCurrentConnectionLoadEpoch: SidebarTreeLoadStateApi['isCurrentConnectionLoadEpoch'];
  nacosNamespaceActiveRequestsRef: SidebarTreeLoadStateApi['nacosNamespaceActiveRequestsRef'];
  beginLoadGeneration: SidebarTreeLoadStateApi['beginLoadGeneration'];
  nacosNamespaceRequestIdsRef: SidebarTreeLoadStateApi['nacosNamespaceRequestIdsRef'];
  isCurrentLoadGeneration: SidebarTreeLoadStateApi['isCurrentLoadGeneration'];
  databaseRequestIdsRef: SidebarTreeLoadStateApi['databaseRequestIdsRef'];
  databaseLoadsRef: SidebarTreeLoadStateApi['databaseLoadsRef'];
}

export const useSidebarDatabaseLoader = ({
  loadingNodesRef, setConnectionStates, buildRuntimeConfig, buildJVMDiagnosticTreeNodes,
  replaceTreeNodeChildren, setLoadedKeys, pinnedSidebarDatabases, getConnectionLoadEpoch,
  isCurrentConnectionLoadEpoch, nacosNamespaceActiveRequestsRef, beginLoadGeneration,
  nacosNamespaceRequestIdsRef, isCurrentLoadGeneration, databaseRequestIdsRef, databaseLoadsRef,
}: UseSidebarDatabaseLoaderInput) => {
  	  const runLoadDatabases = async (
        node: any,
        expectedConnectionEpoch = getConnectionLoadEpoch(String(node?.dataRef?.id || '')),
    ) => {
  		      const conn = node.dataRef as SavedConnection;
  	      if (!isCurrentConnectionLoadEpoch(conn.id, expectedConnectionEpoch)) return;
  		      const loadKey = `dbs-${conn.id}`;
            let loadGeneration = 0;
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
                loadGeneration = beginLoadGeneration(loadKey);
                const requestId =
                    (nacosNamespaceRequestIdsRef.current[conn.id] || 0) + 1;
                nacosNamespaceRequestIdsRef.current[conn.id] = requestId;
                nacosNamespaceRequest = { requestId, signature };
                nacosNamespaceActiveRequestsRef.current[conn.id] =
                    nacosNamespaceRequest;
                loadingNodesRef.current.add(loadKey);
            } else {
                if (loadingNodesRef.current.has(loadKey)) return;
                loadGeneration = beginLoadGeneration(loadKey);
                loadingNodesRef.current.add(loadKey);
            }
            const isCurrentLoad = () => (
                isCurrentConnectionLoadEpoch(conn.id, expectedConnectionEpoch)
                && isCurrentLoadGeneration(loadKey, loadGeneration)
            );
            if (!isCurrentLoad()) return;
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
                    if (!isCurrentLoad()) return;
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
                    if (!isCurrentLoad()) return;
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
                    if (isCurrentLoad()) {
                        loadingNodesRef.current.delete(loadKey);
                        if (shouldMarkConnectionSuccess) {
                            setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                        }
                    }
                }
                return;
            }
  
            // Handle Redis connections differently
            if (conn.config.type === 'redis') {
                const redisRequestId = (databaseRequestIdsRef.current[conn.id] || 0) + 1;
                databaseRequestIdsRef.current[conn.id] = redisRequestId;
                const redisRequestSignature = buildConnectionReloadSignature(conn);
                const resolveCurrentRedisRequestConnection = (): SavedConnection | null => {
                    if (!isCurrentLoad()) return null;
                    if (databaseRequestIdsRef.current[conn.id] !== redisRequestId) return null;
                    const currentConnection = useStore.getState().connections.find(
                        (candidate) => candidate.id === conn.id,
                    );
                    if (
                        !currentConnection
                        || buildConnectionReloadSignature(currentConnection) !== redisRequestSignature
                    ) {
                        return null;
                    }
                    return currentConnection;
                };
                try {
                    const res = await (window as any).go.app.App.RedisGetDatabases(buildRpcConnectionConfig(config));
                    const currentConnection = resolveCurrentRedisRequestConnection();
                    if (!currentConnection) return;
                    if (res.success) {
                        const redisRows: any[] = Array.isArray(res.data) ? res.data : [];
                        const redisDbAliases = useStore.getState().appearance.redisDbAliases;
                        let dbs = redisRows.map((db: any) => {
                            const keyCount = Number(db.keys) > 0 ? Number(db.keys) : 0;
                            const alias = getRedisDbAlias(redisDbAliases, currentConnection.id, db.index);
                            return {
                                title: buildRedisDbNodeLabel(db.index, alias),
                                key: `${currentConnection.id}-db${db.index}`,
                                icon: <DatabaseOutlined style={{ color: '#DC382D' }} />,
                                type: 'redis-db' as const,
                                dataRef: {
                                    ...currentConnection,
                                    redisDB: db.index,
                                    redisKeyCount: keyCount,
                                    redisDbAlias: alias,
                                },
                                isLeaf: true,
                                dbIndex: db.index,
                            };
                        });
                        if (currentConnection.includeRedisDatabases?.length) {
                            dbs = dbs.filter((db) => currentConnection.includeRedisDatabases!.includes(db.dbIndex));
                        }
                        replaceTreeNodeChildren(node.key, dbs, currentConnection);
                        shouldMarkConnectionSuccess = true;
                    } else {
                        setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
                        message.error({ content: res.message, key: `conn-${currentConnection.id}-dbs` });
                    }
                } catch (e: any) {
                    const currentConnection = resolveCurrentRedisRequestConnection();
                    if (!currentConnection) return;
                    setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'error' }));
                    message.error({
                        content: t('sidebar.message.connection_failed', { error: e?.message || String(e) }),
                        key: `conn-${currentConnection.id}-dbs`,
                    });
                } finally {
                    if (
                        isCurrentLoad()
                        && databaseRequestIdsRef.current[conn.id] === redisRequestId
                    ) {
                        loadingNodesRef.current.delete(loadKey);
                        const currentConnection = resolveCurrentRedisRequestConnection();
                        if (shouldMarkConnectionSuccess && currentConnection) {
                            setConnectionStates(prev => ({ ...prev, [currentConnection.id]: 'success' }));
                        }
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
                    if (!isCurrentLoad()) {
                        return null;
                    }
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
                        replaceTreeNodeChildren(node.key, buildV2SidebarDatabaseSectionedChildren(
                            String(node.key),
                            applySidebarDatabasePinning(namespaces, {
                                connectionId: conn.id,
                                pinnedSidebarDatabases: useStore.getState().pinnedSidebarDatabases || pinnedSidebarDatabases,
                            }),
                        ), {
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
                            replaceTreeNodeChildren(node.key, buildV2SidebarDatabaseSectionedChildren(
                                String(node.key),
                                applySidebarDatabasePinning([namespace], {
                                    connectionId: conn.id,
                                    pinnedSidebarDatabases: useStore.getState().pinnedSidebarDatabases || pinnedSidebarDatabases,
                                }),
                            ), {
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
                    if (activeRequest?.requestId === requestId && isCurrentLoad()) {
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
                if (!isCurrentLoad()) {
                    return null;
                }
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
                  const returnedDatabaseNames = dbRows
                      .map((row: any) => row.Database || row.database)
                      .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
                  const visibleDatabaseNames = filterVisibleDatabaseNames(
                      currentConnection,
                      returnedDatabaseNames,
                  );
  
                  const databaseNames = dedupeTrimmedDatabaseNames(visibleDatabaseNames);
                  const messageQueueProfile = resolveSidebarMessageQueueProfile(
                      currentConnection.config,
                  );
  	            let dbs: TreeNode[] = databaseNames.map((databaseName) => (
                    messageQueueProfile
                      ? {
                          title: messageQueueProfile.namespaceTitle(databaseName),
                          key: `${currentConnection.id}-${databaseName}`,
                          icon: messageQueueProfile.namespaceKind === 'vhost'
                            ? <DatabaseOutlined />
                            : <UnorderedListOutlined />,
                          type: 'message-namespace' as const,
                          dataRef: {
                            ...currentConnection,
                            dbName: databaseName,
                            messageQueue: true,
                            messageQueueType: messageQueueProfile.type,
                            messageNamespaceKind: messageQueueProfile.namespaceKind,
                          },
                          isLeaf: false,
                        }
                      : {
  	                    title: databaseName,
                          key: `${currentConnection.id}-${databaseName}`,
                          icon: <GnDatabaseIcon />,
                          type: 'database' as const,
                          dataRef: { ...currentConnection, dbName: databaseName },
                          isLeaf: false,
                        }
                  ));
  
              {
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
                  const isEmptyElasticsearchCluster =
                      isElasticsearchFamilyType(resolveDataSourceType(currentConnection.config))
                      && returnedDatabaseNames.length === 0;
                  if (isEmptyElasticsearchCluster) {
                      // Clear stale index nodes after the last index is deleted while
                      // keeping children undefined so the connection remains reloadable.
                      replaceTreeNodeChildren(node.key, undefined, currentConnection);
                      message.info({
                          content: t('sidebar.message.elasticsearch_no_indices'),
                          key: `conn-${currentConnection.id}-dbs`,
                      });
                  } else {
                      message.warning({
                          content: t('sidebar.message.no_visible_databases'),
                          key: `conn-${currentConnection.id}-dbs`,
                      });
                  }
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
                if (
                    isCurrentLoad()
                    && databaseRequestIdsRef.current[conn.id] === databaseRequestId
                ) {
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
        const connectionEpoch = getConnectionLoadEpoch(conn.id);
        return scheduleSidebarLoad(
            databaseLoadsRef.current,
            loadKey,
            () => runLoadDatabases(node, connectionEpoch),
            options,
            signature,
        );
    };
  return { loadDatabases };
};

export type SidebarDatabaseLoaderApi = ReturnType<typeof useSidebarDatabaseLoader>;
