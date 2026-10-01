import type { Key } from 'react';
import type { SidebarTreeNode } from '../sidebarV2Utils';

/**
 * rc-tree 传给 switcherIcon / titleRender 的是它自己的包装节点：业务字段
 * （type、dataRef）挂在 data 上，loading 由 rc-tree 在 loadData 期间维护。
 */
export type SidebarTreeSwitcherNodeLike = {
  key?: Key;
  data?: SidebarTreeNode;
  isLeaf?: boolean;
  loading?: boolean;
};

// 懒加载节点在 loadingNodesRef 里的键必须与写入方逐字一致。Nacos 两个入口的
// 后缀都取「命名空间 id，为空回落 public」（见 useSidebarTreeLoaders 的
// loadNacosConfigGroups 与 nacosServiceGroupNodes 的 loadNacosServiceGroups），
// 这里照抄同一算法，否则加载态永远匹配不上，双击后没有任何反馈。
const resolveNacosNodeKeyId = (dataRef: any): string => {
  const namespaceId = String(dataRef?.nacosNamespaceId ?? '');
  return namespaceId || 'public';
};

export const resolveSidebarSwitcherLoadKey = (node: SidebarTreeSwitcherNodeLike | null | undefined): string | null => {
  const treeNode = node?.data;
  const dataRef = treeNode?.dataRef;
  if (!treeNode) {
    return null;
  }

  if (treeNode.type === 'connection') {
    const connectionId = String(dataRef?.id || treeNode.key || node?.key || '').trim();
    return connectionId ? `dbs-${connectionId}` : null;
  }

  if (treeNode.type === 'database' || treeNode.type === 'message-namespace') {
    const connectionId = String(dataRef?.id || '').trim();
    const dbName = String(dataRef?.dbName || '').trim();
    return connectionId && dbName ? `tables-${connectionId}-${dbName}` : null;
  }

  if (treeNode.type === 'jvm-mode' || treeNode.type === 'jvm-resource') {
    const connectionId = String(dataRef?.id || '').trim();
    const providerMode = String(dataRef?.providerMode || '').trim().toLowerCase();
    const parentPath = treeNode.type === 'jvm-resource' ? String(dataRef?.resourcePath || '').trim() : '';
    return connectionId && providerMode ? `jvm-resources-${connectionId}-${providerMode}-${parentPath}` : null;
  }

  if (treeNode.type === 'nacos-config-entry') {
    const connectionId = String(dataRef?.id || '');
    return connectionId ? `nacos-groups-${connectionId}-${resolveNacosNodeKeyId(dataRef)}` : null;
  }

  if (treeNode.type === 'nacos-services-entry') {
    const connectionId = String(dataRef?.id || '');
    return connectionId ? `nacos-service-groups-${connectionId}-${resolveNacosNodeKeyId(dataRef)}` : null;
  }

  return null;
};

/**
 * 节点是否处于加载中。rc-tree 自己调 loadData 时会带上 node.loading，而
 * 双击展开走的是手动 onLoadData，只更新 loadingNodesRef，所以两条路径都要看。
 */
export const isSidebarSwitcherLoading = (
  node: SidebarTreeSwitcherNodeLike | null | undefined,
  loadingKeys: ReadonlySet<string>,
): boolean => {
  if (!node || node.isLeaf) {
    return false;
  }
  if (node.loading) {
    return true;
  }
  const loadKey = resolveSidebarSwitcherLoadKey(node);
  return !!loadKey && loadingKeys.has(loadKey);
};

export const shouldKeepSidebarSwitcherCollapsedWhileLoading = (
  node: SidebarTreeSwitcherNodeLike | null | undefined,
  loadingKeys: ReadonlySet<string>,
): boolean => isSidebarSwitcherLoading(node, loadingKeys);
