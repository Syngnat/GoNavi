import type { SavedConnection, JVMResourceSummary } from '../../types';
import { t } from '../../i18n';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { GnFolderOpenIcon } from '../icons/gnIcons';
import { HddOutlined } from '@ant-design/icons';
import { message } from 'antd';
import type { SidebarTreeLoadStateApi } from './useSidebarTreeLoadState';
import type { UseSidebarTreeLoadersOptions } from './useSidebarTreeLoaders';

export interface UseSidebarJvmResourceLoaderInput {
  loadingNodesRef: UseSidebarTreeLoadersOptions['loadingNodesRef'];
  buildJVMRuntimeConfig: UseSidebarTreeLoadersOptions['buildJVMRuntimeConfig'];
  replaceTreeNodeChildren: UseSidebarTreeLoadersOptions['replaceTreeNodeChildren'];
  setLoadedKeys: UseSidebarTreeLoadersOptions['setLoadedKeys'];
  getConnectionLoadEpoch: SidebarTreeLoadStateApi['getConnectionLoadEpoch'];
  beginLoadGeneration: SidebarTreeLoadStateApi['beginLoadGeneration'];
  isCurrentConnectionLoadEpoch: SidebarTreeLoadStateApi['isCurrentConnectionLoadEpoch'];
  isCurrentLoadGeneration: SidebarTreeLoadStateApi['isCurrentLoadGeneration'];
}

export const useSidebarJvmResourceLoader = ({
  loadingNodesRef, buildJVMRuntimeConfig, replaceTreeNodeChildren, setLoadedKeys,
  getConnectionLoadEpoch, beginLoadGeneration, isCurrentConnectionLoadEpoch,
  isCurrentLoadGeneration,
}: UseSidebarJvmResourceLoaderInput) => {
  const loadJVMResources = async (node: any) => {
      const conn = node.dataRef as SavedConnection & { providerMode?: string; resourcePath?: string };
      const providerMode = String(conn.providerMode || '').trim().toLowerCase();
      const parentPath = String(conn.resourcePath || '').trim();
      const loadKey = `jvm-resources-${conn.id}-${providerMode}-${parentPath}`;
      const connectionEpoch = getConnectionLoadEpoch(conn.id);
      if (loadingNodesRef.current.has(loadKey)) return;
      const loadGeneration = beginLoadGeneration(loadKey);
      const isCurrentLoad = () => (
          isCurrentConnectionLoadEpoch(conn.id, connectionEpoch)
          && isCurrentLoadGeneration(loadKey, loadGeneration)
      );
      loadingNodesRef.current.add(loadKey);

      try {
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.JVMListResources !== 'function') {
              throw new Error(t('sidebar.message.jvm_resources_backend_unavailable'));
          }

          const res = await backendApp.JVMListResources(buildJVMRuntimeConfig(conn, providerMode), parentPath);
          if (!isCurrentLoad()) return;
          if (res.success) {
              const resourceRows: JVMResourceSummary[] = Array.isArray(res.data) ? res.data as JVMResourceSummary[] : [];
              const resourceNodes: TreeNode[] = resourceRows.map((item) => ({
                  title: item.name || item.path || item.id,
                  key: `${conn.id}-jvm-resource-${providerMode}-${item.path}`,
                  icon: item.hasChildren ? <GnFolderOpenIcon /> : <HddOutlined />,
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
          if (!isCurrentLoad()) return;
          setLoadedKeys(prev => prev.filter(k => k !== node.key));
          message.error({
              content: t('sidebar.message.load_jvm_resources_failed', { error: e?.message || String(e) }),
              key: `jvm-resource-${node.key}`,
          });
      } finally {
          if (isCurrentLoad()) {
              loadingNodesRef.current.delete(loadKey);
          }
      }
  };
  return { loadJVMResources };
};

export type SidebarJvmResourceLoaderApi = ReturnType<typeof useSidebarJvmResourceLoader>;
