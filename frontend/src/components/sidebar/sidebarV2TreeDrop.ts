import type { Key } from 'react';
import { type SidebarTreeNode, shouldLoadSidebarNodeOnExpand } from './sidebarV2TreeNodes';

export const resolveSidebarConnectionIdFromKey = (
  key: unknown,
  connectionIds: string[],
): string => {
  const keyText = String(key ?? '').trim();
  if (!keyText) return '';

  const sortedIds = Array.from(new Set(connectionIds.filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  return sortedIds.find((id) => keyText === id || keyText.startsWith(`${id}-`)) || '';
};

export const resolveSidebarConnectionRefreshKeys = ({
  treeData,
  expandedKeys,
  connectionId,
}: {
  treeData: SidebarTreeNode[];
  expandedKeys: Key[];
  connectionId: string;
}): string[] => {
  const normalizedConnectionId = String(connectionId || '').trim();
  if (!normalizedConnectionId) return [];

  const expandedKeySet = new Set(
    expandedKeys
      .map((key) => String(key || '').trim())
      .filter((key) => key === normalizedConnectionId || key.startsWith(`${normalizedConnectionId}-`)),
  );
  if (expandedKeySet.size === 0) return [];

  const depthByKey = new Map<string, number>();
  const collectDepths = (nodes: SidebarTreeNode[], depth: number) => {
    nodes.forEach((node) => {
      const key = String(node.key || '').trim();
      if (key) depthByKey.set(key, depth);
      if (node.children?.length) collectDepths(node.children, depth + 1);
    });
  };
  collectDepths(treeData, 0);

  return Array.from(expandedKeySet)
    .filter((key) => depthByKey.has(key))
    .sort((left, right) => {
      const depthDifference = (depthByKey.get(left) || 0) - (depthByKey.get(right) || 0);
      return depthDifference || left.localeCompare(right);
    });
};

export const resolveSidebarNodeConnectionId = (
  node: { key?: unknown; dataRef?: Record<string, unknown> } | null | undefined,
  connectionIds: string[],
): string => {
  const directId = String(node?.dataRef?.id || node?.dataRef?.connectionId || '').trim();
  if (directId && connectionIds.includes(directId)) return directId;
  return resolveSidebarConnectionIdFromKey(node?.key, connectionIds);
};

export const normalizeSidebarTreeRelativeDropPosition = (
  absoluteDropPosition: number,
  nodePos: unknown,
): number => {
  const segments = String(nodePos || '').split('-');
  const tailIndex = Number(segments[segments.length - 1] || 0);
  return absoluteDropPosition - tailIndex;
};

export const resolveSidebarDropInsertBefore = (
  relativeDropPosition: number,
  metrics?: {
    clientY?: number;
    top?: number;
    height?: number;
  } | null,
): boolean => {
  if (relativeDropPosition < 0) return true;
  if (relativeDropPosition > 0) return false;
  const clientY = metrics?.clientY;
  const top = metrics?.top;
  const height = metrics?.height;
  if (
    typeof clientY !== 'number'
    || typeof top !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(clientY)
    || !Number.isFinite(top)
    || !Number.isFinite(height)
    || height <= 0
  ) {
    return false;
  }
  return clientY < (top + height / 2);
};

export type SidebarTreeDropPlacement = 'before' | 'inside' | 'after';

export type SidebarHostGroupDropDestination = {
  targetParentTagId: string | null;
  targetToken: string | null;
  insertBefore: boolean;
};

type SidebarTreeDropPlacementOptions = {
  dragNodeType: unknown;
  dropNodeType: unknown;
  relativeDropPosition: number;
  dropToGap?: boolean;
  fallbackInsertBefore: boolean;
  metrics?: {
    clientY?: number;
    top?: number;
    height?: number;
  } | null;
};

const SIDEBAR_HOST_GROUP_DROP_EDGE_PX = 4;

/**
 * Resolves the user-facing drop intent from the real row under the pointer.
 *
 * rc-tree normally requires a hidden horizontal-indent gesture to drop into a
 * collapsed node. Host rows should instead treat the visible group row as the
 * primary target, while retaining narrow top/bottom gaps for explicit sorting.
 */
export const resolveSidebarTreeDropPlacement = ({
  dragNodeType,
  dropNodeType,
  relativeDropPosition,
  dropToGap,
  fallbackInsertBefore,
  metrics,
}: SidebarTreeDropPlacementOptions): SidebarTreeDropPlacement => {
  const isHostMovingToGroup = (dragNodeType === 'connection' || dragNodeType === 'tag')
    && dropNodeType === 'tag';
  if (isHostMovingToGroup) {
    const clientY = metrics?.clientY;
    const top = metrics?.top;
    const height = metrics?.height;
    if (
      typeof clientY === 'number'
      && typeof top === 'number'
      && typeof height === 'number'
      && Number.isFinite(clientY)
      && Number.isFinite(top)
      && Number.isFinite(height)
      && height > 0
    ) {
      const edgeSize = Math.min(SIDEBAR_HOST_GROUP_DROP_EDGE_PX, height / 4);
      const offset = clientY - top;
      if (offset < edgeSize) return 'before';
      if (offset > height - edgeSize) return 'after';
      return 'inside';
    }
    if (dragNodeType === 'connection') return 'inside';
  }

  if (
    dropNodeType === 'tag'
    && (dropToGap === false || (dropToGap === undefined && relativeDropPosition === 0))
  ) {
    return 'inside';
  }
  if (relativeDropPosition < 0) return 'before';
  if (relativeDropPosition > 0) return 'after';
  return fallbackInsertBefore ? 'before' : 'after';
};

export const resolveSidebarHostGroupDropDestination = (options: {
  targetTagId: string;
  targetTagParentId: string | null;
  targetTagToken: string | null;
  placement: SidebarTreeDropPlacement;
}): SidebarHostGroupDropDestination => (
  options.placement === 'inside'
    ? {
        targetParentTagId: options.targetTagId,
        targetToken: null,
        insertBefore: false,
      }
    : {
        targetParentTagId: options.targetTagParentId,
        targetToken: options.targetTagToken,
        insertBefore: options.placement === 'before',
      }
);

const resolveSidebarDropBaseElementFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): Element | null => {
  if (typeof document === 'undefined') return null;
  const fallbackTarget = event?.target && typeof (event.target as any).closest === 'function'
    ? (event.target as unknown as Element)
    : null;
  const pointTarget = (
    typeof event?.clientX === 'number'
    && typeof event?.clientY === 'number'
  )
    ? document.elementFromPoint(event.clientX, event.clientY)
    : null;
  const baseElement = pointTarget || fallbackTarget;
  if (!baseElement || typeof baseElement.closest !== 'function') return null;
  return baseElement;
};

export type SidebarDropDomHit = {
  key: string;
  type: string;
  metrics: { top: number; height: number } | null;
};

export const resolveSidebarDropDomHit = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): SidebarDropDomHit | null => {
  const baseElement = resolveSidebarDropBaseElementFromDomEvent(event);
  if (!baseElement) return null;

  const treeNode = baseElement.closest('.ant-tree-treenode') as HTMLElement | null;
  const rowKey = String(treeNode?.getAttribute?.('data-sidebar-node-key') || '').trim();
  const rowType = String(treeNode?.getAttribute?.('data-sidebar-node-type') || '').trim();
  const nestedMarker = treeNode?.querySelector?.('[data-sidebar-node-key]') as HTMLElement | null;
  const fallbackMarker = baseElement.closest('[data-sidebar-node-key]') as HTMLElement | null;
  const marker = rowKey && rowType ? treeNode : (nestedMarker || fallbackMarker);
  if (!marker) return null;

  const key = rowKey || String(marker.getAttribute('data-sidebar-node-key') || '').trim();
  const type = rowType || String(marker.getAttribute('data-sidebar-node-type') || '').trim();
  if (!key || !type) return null;

  let metrics: SidebarDropDomHit['metrics'] = null;
  if (treeNode && typeof treeNode.getBoundingClientRect === 'function') {
    const rect = treeNode.getBoundingClientRect();
    if (Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0) {
      metrics = { top: rect.top, height: rect.height };
    }
  }
  return { key, type, metrics };
};

export const resolveSidebarDropNodeFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): { key: string; type: string } | null => {
  const hit = resolveSidebarDropDomHit(event);
  return hit ? { key: hit.key, type: hit.type } : null;
};

export const resolveSidebarDropTargetMetricsFromDomEvent = (
  event: {
    clientX?: number;
    clientY?: number;
    target?: EventTarget | null;
  } | null | undefined,
): { top: number; height: number } | null => {
  const baseElement = resolveSidebarDropBaseElementFromDomEvent(event);
  if (!baseElement) return null;
  const treeNode = baseElement.closest('.ant-tree-treenode') as HTMLElement | null;
  if (!treeNode || typeof treeNode.getBoundingClientRect !== 'function') return null;
  const rect = treeNode.getBoundingClientRect();
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return null;
  }
  return {
    top: rect.top,
    height: rect.height,
  };
};

export const resolveSidebarTagDropInsertBefore = (options: {
  currentTagOrder: string[];
  dragTagId: string;
  dropTagId: string;
  relativeDropPosition: number;
  fallbackInsertBefore: boolean;
  metrics?: {
    clientY?: number;
    top?: number;
    height?: number;
  } | null;
}): boolean => {
  const {
    currentTagOrder,
    dragTagId,
    dropTagId,
    relativeDropPosition,
    fallbackInsertBefore,
    metrics,
  } = options;

  if (relativeDropPosition !== 0) {
    return fallbackInsertBefore;
  }

  const clientY = metrics?.clientY;
  const top = metrics?.top;
  const height = metrics?.height;
  if (
    typeof clientY !== 'number'
    || typeof top !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(clientY)
    || !Number.isFinite(top)
    || !Number.isFinite(height)
    || height <= 0
  ) {
    return fallbackInsertBefore;
  }

  const ratio = (clientY - top) / height;
  if (ratio < 0.35) return true;
  if (ratio > 0.65) return false;

  const dragIndex = currentTagOrder.indexOf(dragTagId);
  const dropIndex = currentTagOrder.indexOf(dropTagId);
  if (dragIndex === -1 || dropIndex === -1 || dragIndex === dropIndex) {
    return fallbackInsertBefore;
  }
  return dragIndex > dropIndex;
};

export const shouldSkipSidebarSelectWhileDragging = (
  isTreeDragging: boolean,
  info: { selected?: boolean } | null | undefined,
): boolean => isTreeDragging || !info?.selected;

export const shouldSkipSidebarLoadOnExpandWhileDragging = (
  isTreeDragging: boolean,
  info: { expanded?: boolean; node?: Pick<SidebarTreeNode, 'type' | 'children' | 'isLeaf'> | null } | null | undefined,
): boolean => {
  if (isTreeDragging) return true;
  if (!info?.expanded) return true;
  return !shouldLoadSidebarNodeOnExpand(info.node);
};

export const SIDEBAR_COLLAPSE_UNLOAD_SUBTREE_LIMIT = 160;
