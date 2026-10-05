import type { ReactNode, Key } from 'react';
import type { SidebarTreeNodeType } from './sidebarTreeNodeTypes';
import { t } from '../../i18n';
import { t as catalogTranslate } from '../../i18n/catalog';

export type SidebarV2Translate = (key: string) => string;

export const translateSidebarV2Current: SidebarV2Translate = (key) => t(key);
const translateSidebarV2ZhCN: SidebarV2Translate = (key) => catalogTranslate('zh-CN', key);

export type SidebarConnectionState = 'loading' | 'success' | 'error';

export interface SidebarTreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  selectable?: boolean;
  children?: SidebarTreeNode[];
  icon?: ReactNode;
  dataRef?: any;
  type?: SidebarTreeNodeType;
}

/**
 * Keep the tree safe for rc-tree/virtual-list consumers when a metadata
 * endpoint returns the same node more than once.  Keys are expected to be
 * globally unique; a duplicate key otherwise makes the virtual list reuse a
 * row and can render one item over and over while filtering. The first node
 * keeps its position and metadata, while children discovered on later copies
 * are merged into it so a late-loaded subtree is not lost.
 */
export const dedupeSidebarTreeNodesByKey = (
  nodes: SidebarTreeNode[],
): SidebarTreeNode[] => {
  type SidebarNodeRecord = {
    source: SidebarTreeNode;
    children: SidebarNodeRecord[];
  };

  // Treat the incoming tree as a graph. Metadata refreshes can create both
  // repeated object references and distinct objects with the same key; an
  // iterative collection pass avoids recursion limits while retaining every
  // descendant discovered on a duplicate node.
  const recordsByObject = new Map<SidebarTreeNode, SidebarNodeRecord>();
  const recordsByKey = new Map<string, SidebarNodeRecord>();
  const visitedObjects = new Set<SidebarTreeNode>();

  const getNodeKey = (node: SidebarTreeNode): string => (
    node.key == null ? '' : String(node.key).trim()
  );

  const getRecord = (node: SidebarTreeNode): SidebarNodeRecord => {
    const objectRecord = recordsByObject.get(node);
    if (objectRecord) return objectRecord;

    const key = getNodeKey(node);
    const record = recordsByKey.get(key) || {
      source: node,
      children: [],
    };
    recordsByObject.set(node, record);
    if (!recordsByKey.has(key)) recordsByKey.set(key, record);
    return record;
  };

  type CollectFrame = {
    node: SidebarTreeNode;
    parent?: SidebarNodeRecord;
  };
  const pending: CollectFrame[] = [];
  const rootNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node): node is SidebarTreeNode => !!node && typeof node === 'object');

  // Use an explicit DFS stack so merged children retain the same preorder as
  // the original recursive implementation without risking call-stack growth.
  for (let index = rootNodes.length - 1; index >= 0; index -= 1) {
    const node = rootNodes[index];
    if (node && typeof node === 'object') pending.push({ node });
  }
  while (pending.length > 0) {
    const frame = pending.pop();
    const node = frame?.node;
    if (!node || visitedObjects.has(node)) continue;
    visitedObjects.add(node);

    const record = getRecord(node);
    if (frame?.parent) frame.parent.children.push(record);
    const children = Array.isArray(node.children) ? node.children : [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      const child = children[childIndex];
      if (child && typeof child === 'object' && !visitedObjects.has(child)) {
        pending.push({ node: child, parent: record });
      }
    }
  }

  // Resolve root records after collection so a descendant encountered before
  // a later root with the same key remains the canonical (first) node.
  const roots = rootNodes.map((node) => getRecord(node));

  const emitted = new Set<SidebarNodeRecord>();
  type BuildFrame = {
    records: SidebarNodeRecord[];
    index: number;
    output: SidebarTreeNode[];
    owner?: SidebarTreeNode;
    childOutput?: SidebarTreeNode[];
  };
  const result: SidebarTreeNode[] = [];
  const stack: BuildFrame[] = [{ records: roots, index: 0, output: result }];

  // Emit each keyed record once. A global emitted set is intentional: rc-tree
  // requires globally unique keys, so a duplicate appearing under another
  // parent must not produce a second rendered row.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.records.length) {
      stack.pop();
      if (frame.owner && frame.childOutput) {
        if (frame.childOutput.length === 0) {
          delete frame.owner.children;
        } else {
          // A later duplicate can turn a placeholder leaf into a branch.
          frame.owner.isLeaf = false;
        }
      }
      continue;
    }

    const record = frame.records[frame.index];
    frame.index += 1;
    if (!record || emitted.has(record)) continue;
    emitted.add(record);

    const { children: _sourceChildren, ...sourceWithoutChildren } = record.source;
    const normalizedNode: SidebarTreeNode = { ...sourceWithoutChildren };
    frame.output.push(normalizedNode);

    if (record.children.length > 0) {
      const childOutput: SidebarTreeNode[] = [];
      normalizedNode.children = childOutput;
      stack.push({
        records: record.children,
        index: 0,
        output: childOutput,
        owner: normalizedNode,
        childOutput,
      });
    }
  }

  return result;
};
/**
 * Replaces one node's children while preserving the tree's global key
 * invariant. Canonicalize before the replacement so stale children from a
 * duplicate target cannot be merged back after a metadata refresh.
 */
export const replaceSidebarTreeNodeChildren = (
  nodes: SidebarTreeNode[],
  targetKey: Key,
  children: SidebarTreeNode[] | undefined,
  dataRef?: unknown,
): SidebarTreeNode[] => {
  const canonicalTree = dedupeSidebarTreeNodesByKey(nodes);
  const result: SidebarTreeNode[] = [];
  const normalizedTargetKey = targetKey == null ? '' : String(targetKey).trim();
  let replaced = false;
  type CopyFrame = {
    source: SidebarTreeNode;
    output: SidebarTreeNode[];
  };
  const pending: CopyFrame[] = [];

  for (let index = canonicalTree.length - 1; index >= 0; index -= 1) {
    pending.push({ source: canonicalTree[index], output: result });
  }

  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) continue;

    const { source, output } = frame;
    if (!replaced && String(source.key == null ? '' : source.key).trim() === normalizedTargetKey) {
      replaced = true;
      output.push({
        ...source,
        children,
        ...(dataRef === undefined ? {} : { dataRef }),
      });
      continue;
    }

    const clonedNode: SidebarTreeNode = { ...source };
    output.push(clonedNode);
    if (!Array.isArray(source.children) || source.children.length === 0) continue;

    const childOutput: SidebarTreeNode[] = [];
    clonedNode.children = childOutput;
    for (let index = source.children.length - 1; index >= 0; index -= 1) {
      pending.push({ source: source.children[index], output: childOutput });
    }
  }

  return dedupeSidebarTreeNodesByKey(result);
};

// Keep these values aligned with the V2 explorer tree layout in v2-theme.css.
const V2_TREE_HORIZONTAL_SCROLL_RESERVE_PX = 0;
const V2_TREE_CONTENT_TOP_PADDING_PX = 4;

export const resolveSidebarTreeVirtualHeight = (
  containerHeight: number,
): number => {
  if (!Number.isFinite(containerHeight)) return 0;
  const normalizedHeight = Math.max(0, containerHeight);
  return Math.max(
    0,
    normalizedHeight - (
      V2_TREE_HORIZONTAL_SCROLL_RESERVE_PX + V2_TREE_CONTENT_TOP_PADDING_PX
    ),
  );
};

/** Exact V2 row geometry, including Ant Tree's 4px inter-row margin. */
export const resolveSidebarTreeRowHeight = (
  node: SidebarTreeNode | null | undefined,
): number => {
  if (node?.type === 'v2-table-section' || node?.type === 'v2-database-section') {
    return 36;
  }
  return 30;
};

export const hasSidebarLazyChildren = (children: unknown): boolean => {
  return Array.isArray(children) && children.length > 0;
};

export const shouldLoadSidebarNodeOnExpand = (
  node: Pick<SidebarTreeNode, 'type' | 'children' | 'isLeaf'> | null | undefined,
): boolean => {
  if (!node || node.isLeaf === true || hasSidebarLazyChildren(node.children)) return false;
  return node.type === 'connection'
    || node.type === 'database'
    || node.type === 'message-namespace'
    || node.type === 'external-sql-root'
    || node.type === 'table'
    || node.type === 'jvm-mode'
    || node.type === 'jvm-resource'
    || node.type === 'nacos-config-entry'
    || node.type === 'nacos-services-entry';
};
