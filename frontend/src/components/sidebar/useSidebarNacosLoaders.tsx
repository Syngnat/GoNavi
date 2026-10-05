import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message } from 'antd';
import { t } from '../../i18n';
import { buildPinnedNacosConfigGroups } from './nacosConfigGroupNodes';
import { useStore } from '../../store';
import { loadNacosServiceGroupsIntoTree } from './nacosServiceGroupNodes';
import type { SidebarTreeLoadStateApi } from './useSidebarTreeLoadState';
import type { UseSidebarTreeLoadersOptions } from './useSidebarTreeLoaders';

export interface UseSidebarNacosLoadersInput {
  loadingNodesRef: UseSidebarTreeLoadersOptions['loadingNodesRef'];
  setLoadedKeys: UseSidebarTreeLoadersOptions['setLoadedKeys'];
  replaceTreeNodeChildren: UseSidebarTreeLoadersOptions['replaceTreeNodeChildren'];
  pinnedSidebarDatabases: UseSidebarTreeLoadersOptions['pinnedSidebarDatabases'];
  getConnectionLoadEpoch: SidebarTreeLoadStateApi['getConnectionLoadEpoch'];
  beginLoadGeneration: SidebarTreeLoadStateApi['beginLoadGeneration'];
  isCurrentConnectionLoadEpoch: SidebarTreeLoadStateApi['isCurrentConnectionLoadEpoch'];
  isCurrentLoadGeneration: SidebarTreeLoadStateApi['isCurrentLoadGeneration'];
  nacosServiceGroupRequestIdsRef: SidebarTreeLoadStateApi['nacosServiceGroupRequestIdsRef'];
}

export const useSidebarNacosLoaders = ({
  loadingNodesRef, setLoadedKeys, replaceTreeNodeChildren, pinnedSidebarDatabases,
  getConnectionLoadEpoch, beginLoadGeneration, isCurrentConnectionLoadEpoch,
  isCurrentLoadGeneration, nacosServiceGroupRequestIdsRef,
}: UseSidebarNacosLoadersInput) => {
  const loadNacosConfigGroups = async (node: any) => {
      const dataRef = node?.dataRef || {};
      const connectionId = String(dataRef.id || '');
      const namespaceId = String(dataRef.nacosNamespaceId ?? '');
      const namespaceName = String(dataRef.nacosNamespaceName || namespaceId || 'public');
      const nodeKeyId = namespaceId || 'public';
      const loadKey = `nacos-groups-${connectionId}-${nodeKeyId}`;
      if (!connectionId) return;
      if (loadingNodesRef.current.has(loadKey)) return;
      const connectionEpoch = getConnectionLoadEpoch(connectionId);
      const loadGeneration = beginLoadGeneration(loadKey);
      const isCurrentLoad = () => (
          isCurrentConnectionLoadEpoch(connectionId, connectionEpoch)
          && isCurrentLoadGeneration(loadKey, loadGeneration)
      );
      loadingNodesRef.current.add(loadKey);
      try {
          const res = await (window as any).go.app.App.NacosListConfigGroups(
              buildRpcConnectionConfig(dataRef.config || {}),
              namespaceId,
          );
          if (!isCurrentLoad()) return;
          if (!res?.success) {
              message.error({
                  content: res?.message || t('sidebar.message.connection_failed', { error: 'list groups failed' }),
                  key: loadKey,
              });
              setLoadedKeys((prev) => prev.filter((k) => k !== node.key));
              return;
          }
          const groups: string[] = Array.isArray(res.data) ? res.data.map((g: any) => String(g || '').trim()).filter(Boolean) : [];
          replaceTreeNodeChildren(node.key, buildPinnedNacosConfigGroups(
              dataRef, groups, useStore.getState().pinnedSidebarDatabases || pinnedSidebarDatabases,
          ), dataRef);
          if (groups.length === 0) {
              message.info({
                  content: t('nacos_viewer.message.no_groups'),
                  key: loadKey,
              });
          }
      } catch (error: any) {
          if (!isCurrentLoad()) return;
          message.error({
              content: t('sidebar.message.connection_failed', { error: error?.message || String(error) }),
              key: loadKey,
          });
          setLoadedKeys((prev) => prev.filter((k) => k !== node.key));
      } finally {
          if (isCurrentLoad()) {
              loadingNodesRef.current.delete(loadKey);
          }
      }
  };

  // Extracted to ./nacosServiceGroupNodes so this hook — already far past the repo's
  // file-size limit — only wires the loader up.
  const loadNacosServiceGroups = async (
      node: any,
      options: { force?: boolean } = {},
  ): Promise<boolean> => loadNacosServiceGroupsIntoTree({
      node,
      options,
      nacosServiceGroupRequestIdsRef,
      loadingNodesRef,
      setLoadedKeys,
      replaceTreeNodeChildren,
      buildRpcConnectionConfig,
      getConnectionLoadEpoch,
      beginLoadGeneration,
      isCurrentConnectionLoadEpoch,
      isCurrentLoadGeneration,
      showError: (payload) => message.error(payload),
      listServices: (rpcConfig, query) => (
          (window as any).go.app.App.NacosListServices(rpcConfig, query)
      ),
  });
  return { loadNacosConfigGroups, loadNacosServiceGroups };
};

export type SidebarNacosLoadersApi = ReturnType<typeof useSidebarNacosLoaders>;
