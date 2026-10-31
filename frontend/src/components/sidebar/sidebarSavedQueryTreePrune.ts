import type { TreeNode } from './sidebarNodeMenuHelpers';

const readQueryId = (node: TreeNode): string => {
  const dataRef = (node as { dataRef?: { id?: unknown } }).dataRef;
  return typeof dataRef?.id === 'string' ? dataRef.id : '';
};

// 删除查询后本地同步树：先摘掉目标查询叶子，再自底向上剪掉空掉的
// 自动分组（连接 host 层、数据库层、未分组层），手动分组由用户显式创建故保留。
export const pruneSavedQueryTreeAfterDelete = (nodes: TreeNode[], queryId: string): TreeNode[] => {
  const targetId = String(queryId || '').trim();
  if (!targetId) return nodes;

  let changed = false;
  const next: TreeNode[] = [];

  nodes.forEach((node) => {
    if (node.type === 'saved-query' && readQueryId(node) === targetId) {
      changed = true;
      return;
    }
    if (!node.children || node.children.length === 0) {
      next.push(node);
      return;
    }
    const children = pruneSavedQueryTreeAfterDelete(node.children, targetId);
    if (children === node.children) {
      next.push(node);
      return;
    }
    changed = true;
    const emptied = children.length === 0
      && (node.type === 'saved-query-group' || node.type === 'all-saved-queries');
    if (emptied) return;
    next.push({ ...node, children });
  });

  return changed ? next : nodes;
};
