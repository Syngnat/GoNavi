import {
  type SidebarTreeDropPlacement,
  type SidebarTreeNode as TreeNode,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarDropDomHit,
  resolveSidebarDropInsertBefore,
  resolveSidebarTreeDropPlacement,
  resolveV2ConnectionGroup,
} from '../sidebarV2Utils';
import { SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS, isPostgresSchemaDialect } from './sidebarRootHelpers';
import * as sidebarTreeDrag from './sidebarTreeDragOrder';
import React from 'react';
import { resolveSidebarContextMenuPosition, resolveSidebarTreeRowKey } from '../sidebarCoreUtils';
import { getMetadataDialect } from './sidebarMetadataLoaders';
import { SavedConnection } from '../../types';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarContextMenusApi } from './useSidebarContextMenus';

export interface UseSidebarTreeDndInput {
  sidebarGroupHoverExpandTimerRef: SidebarTreeViewStateApi['sidebarGroupHoverExpandTimerRef'];
  sidebarTreeDropPreviewRef: SidebarTreeViewStateApi['sidebarTreeDropPreviewRef'];
  setSidebarTreeDropPreview: SidebarTreeViewStateApi['setSidebarTreeDropPreview'];
  expandedKeysRef: SidebarSearchStateApi['expandedKeysRef'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setAutoExpandParent: SidebarSearchStateApi['setAutoExpandParent'];
  sidebarTreeDragNodeRef: SidebarTreeViewStateApi['sidebarTreeDragNodeRef'];
  setSidebarTreeDragNodeType: SidebarTreeViewStateApi['setSidebarTreeDragNodeType'];
  sidebarTreeDragPreviewElementRef: SidebarTreeViewStateApi['sidebarTreeDragPreviewElementRef'];
  setIsTreeDragging: SidebarTreeViewStateApi['setIsTreeDragging'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  connectionTags: SidebarStoreStateApi['connectionTags'];
  moveConnectionTag: SidebarStoreStateApi['moveConnectionTag'];
  moveConnectionToTag: SidebarStoreStateApi['moveConnectionToTag'];
  sidebarTreeOrdersRef: SidebarStoreStateApi['sidebarTreeOrdersRef'];
  tableSortPreferenceRef: SidebarStoreStateApi['tableSortPreferenceRef'];
  setTreeData: SidebarStoreStateApi['setTreeData'];
  updateSidebarTreeOrders: SidebarStoreStateApi['updateSidebarTreeOrders'];
  setTableSortPreference: SidebarStoreStateApi['setTableSortPreference'];
  restoreTreeSelectionAfterDrag: SidebarSearchStateApi['restoreTreeSelectionAfterDrag'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  v2RailConnectionGroups: SidebarContextMenusApi['v2RailConnectionGroups'];
  setContextMenu: SidebarContextMenusApi['setContextMenu'];
  openV2ConnectionContextMenu: SidebarContextMenusApi['openV2ConnectionContextMenu'];
  getNodeMenuItems: SidebarContextMenusApi['getNodeMenuItems'];
}

export const useSidebarTreeDnd = ({
  sidebarGroupHoverExpandTimerRef, sidebarTreeDropPreviewRef, setSidebarTreeDropPreview,
  expandedKeysRef, setExpandedKeys, setAutoExpandParent, sidebarTreeDragNodeRef,
  setSidebarTreeDragNodeType, sidebarTreeDragPreviewElementRef, setIsTreeDragging, treeDataRef,
  connectionTags, moveConnectionTag, moveConnectionToTag, sidebarTreeOrdersRef,
  tableSortPreferenceRef, setTreeData, updateSidebarTreeOrders, setTableSortPreference,
  restoreTreeSelectionAfterDrag, findTreeNodeByKeyRef, v2RailConnectionGroups, setContextMenu,
  openV2ConnectionContextMenu, getNodeMenuItems,
}: UseSidebarTreeDndInput) => {
  const clearSidebarGroupHoverExpandTimer = () => {
      if (sidebarGroupHoverExpandTimerRef.current === null) return;
      window.clearTimeout(sidebarGroupHoverExpandTimerRef.current);
      sidebarGroupHoverExpandTimerRef.current = null;
  };

  const updateSidebarTreeDropPreview = (
      nextPreview: { nodeKey: string; placement: SidebarTreeDropPlacement } | null,
  ) => {
      const previousPreview = sidebarTreeDropPreviewRef.current;
      if (
          previousPreview?.nodeKey === nextPreview?.nodeKey
          && previousPreview?.placement === nextPreview?.placement
      ) {
          return;
      }

      clearSidebarGroupHoverExpandTimer();
      sidebarTreeDropPreviewRef.current = nextPreview;
      setSidebarTreeDropPreview(nextPreview);
      if (!nextPreview || nextPreview.placement !== 'inside') return;
      if (expandedKeysRef.current.some((key) => String(key) === nextPreview.nodeKey)) return;

      sidebarGroupHoverExpandTimerRef.current = window.setTimeout(() => {
          sidebarGroupHoverExpandTimerRef.current = null;
          const activePreview = sidebarTreeDropPreviewRef.current;
          if (
              activePreview?.nodeKey !== nextPreview.nodeKey
              || activePreview.placement !== 'inside'
          ) {
              return;
          }
          setExpandedKeys((previous) => previous.some((key) => String(key) === nextPreview.nodeKey)
              ? previous
              : [...previous, nextPreview.nodeKey]);
          setAutoExpandParent(false);
      }, SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS);
  };

  const clearSidebarTreeDragVisuals = () => {
      clearSidebarGroupHoverExpandTimer();
      sidebarTreeDropPreviewRef.current = null;
      setSidebarTreeDropPreview(null);
      sidebarTreeDragNodeRef.current = null;
      setSidebarTreeDragNodeType(null);
      sidebarTreeDragPreviewElementRef.current?.remove();
      sidebarTreeDragPreviewElementRef.current = null;
      setIsTreeDragging(false);
  };

  const resolveSidebarHostGroupDropAtEvent = (event: {
      clientX?: number;
      clientY?: number;
      target?: EventTarget | null;
  }) => {

      const resolved = sidebarTreeDrag.resolveSidebarHostTreeDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      if (!resolved) return null;
      return sidebarTreeDrag.resolveSidebarHostTreeMove({
          ...resolved,
          connectionTags,
      }) ? resolved : null;
  };

  const applySidebarHostTreeDrop = (
      dragNode: TreeNode,
      dropNode: TreeNode,
      placement: SidebarTreeDropPlacement,
  ): boolean => {
      if (
          placement !== 'inside'
          && sidebarTreeDrag.isSidebarTreeGapNoOp(treeDataRef.current, dragNode, dropNode, placement)
      ) return false;
      const move = sidebarTreeDrag.resolveSidebarHostTreeMove({
          dragNode,
          dropNode,
          placement,
          connectionTags,
      });
      if (!move) return false;
      if (move.type === 'tag') {
          moveConnectionTag(move.id, move.targetParentTagId, move.targetToken, move.insertBefore);
      } else {
          moveConnectionToTag(move.id, move.targetParentTagId, move.targetToken, move.insertBefore);
      }
      return true;
  };

  const applySidebarTreeOrderDrop = (
      dragNode: TreeNode,
      dropNode: TreeNode,
      insertBefore: boolean,
  ): boolean => sidebarTreeDrag.commitSidebarTreeOrderDrop({
      treeData: treeDataRef.current, dragNode, dropNode, insertBefore,
      treeOrders: sidebarTreeOrdersRef.current,
      tableSortPreference: tableSortPreferenceRef.current,
      callbacks: {
          onTreeData: (next) => { treeDataRef.current = next; setTreeData(next); },
          onTreeOrders: (parentKey, orderedKeys, next) => {
              sidebarTreeOrdersRef.current = next;
              updateSidebarTreeOrders({ [parentKey]: orderedKeys });
          },
          onTableSort: (connectionId, dbName, next) => {
              tableSortPreferenceRef.current = next;
              setTableSortPreference(connectionId, dbName, 'manual');
          },
      },
  });

  const handleSidebarTreeDragOverCapture = (event: React.DragEvent<HTMLDivElement>) => {
      const objectDrop = sidebarTreeDrag.resolveSidebarTreeOrderDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      const resolvedDrop = objectDrop || resolveSidebarHostGroupDropAtEvent(event);
      if (!resolvedDrop) {
          updateSidebarTreeDropPreview(null);
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
      }
      updateSidebarTreeDropPreview({
          nodeKey: resolvedDrop.hit.key,
          placement: resolvedDrop.placement,
      });
  };

  const handleSidebarTreeDropCapture = (event: React.DragEvent<HTMLDivElement>) => {
      const objectDrop = sidebarTreeDrag.resolveSidebarTreeOrderDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      if (objectDrop) {
          event.preventDefault();
          event.stopPropagation();
          applySidebarTreeOrderDrop(
              objectDrop.dragNode,
              objectDrop.dropNode,
              objectDrop.placement === 'before',
          );
          restoreTreeSelectionAfterDrag();
          clearSidebarTreeDragVisuals();
          return;
      }
      const hostDrop = resolveSidebarHostGroupDropAtEvent(event);
      if (!hostDrop) return;

      event.preventDefault();
      event.stopPropagation();
      applySidebarHostTreeDrop(hostDrop.dragNode, hostDrop.dropNode, hostDrop.placement);
      restoreTreeSelectionAfterDrag();
      clearSidebarTreeDragVisuals();
  };

  const allowSidebarTreeDrop = ({ dragNode, dropNode, dropPosition }: any): boolean => {
      if (!dragNode || !dropNode) return false;
      if (sidebarTreeDrag.isSidebarTreeOrderNode(dragNode) || sidebarTreeDrag.isSidebarTreeOrderNode(dropNode)) {
          return sidebarTreeDrag.canDropSidebarTreeOrderNode(
              treeDataRef.current,
              dragNode,
              dropNode,
              Number(dropPosition),
          );
      }
      if ((dragNode.type !== 'tag' && dragNode.type !== 'connection') || (dropNode.type !== 'tag' && dropNode.type !== 'connection')) {
          return false;
      }
      const dropPlacement = Number(dropPosition) < 0
          ? 'before'
          : Number(dropPosition) > 0
              ? 'after'
              : 'inside';
      if (
          dropPlacement !== 'inside'
          && sidebarTreeDrag.isSidebarTreeGapNoOp(treeDataRef.current, dragNode, dropNode, dropPlacement)
      ) return false;
      // Connections cannot contain tree items. A group can contain a group only
      // when the pointer lands on its content, not on its before/after gap.
      const droppingIntoTag = dropNode.type === 'tag' && Number(dropPosition) === 0;
      if (dropNode.type === 'connection' && Number(dropPosition) === 0) return false;
      if (dragNode.type !== 'tag') return String(dragNode.key) !== String(dropNode.key);

      const dragTagId = String(dragNode?.dataRef?.id || '').trim();
      const targetParentTagId = droppingIntoTag
          ? String(dropNode?.dataRef?.id || '').trim() || null
          : sidebarTreeDrag.getSidebarTreeNodeParentTagId(dropNode, connectionTags);
      return !!dragTagId && !isConnectionTagDescendant(dragTagId, targetParentTagId, connectionTags);
  };

  const handleDrop = (info: any) => {
      clearSidebarTreeDragVisuals();
      const dropPosition = normalizeSidebarTreeRelativeDropPosition(
          Number(info.dropPosition || 0),
          info?.node?.pos,
      );
      const domDropHit = resolveSidebarDropDomHit(info?.event);
      const domDropNode = domDropHit ? { key: domDropHit.key, type: domDropHit.type } : null;
      const dropTargetMetrics = domDropHit?.metrics || null;
      const insertBefore = resolveSidebarDropInsertBefore(dropPosition, dropTargetMetrics ? {
          clientY: info?.event?.clientY,
          top: dropTargetMetrics.top,
          height: dropTargetMetrics.height,
      } : null);
      const dragNode = info.dragNode;
      const dropNode = domDropNode && domDropNode.key === String(info?.node?.key || '')
          ? info.node
          : (domDropNode
              ? findTreeNodeByKeyRef.current(treeDataRef.current, domDropNode.key) || info.node
              : info.node);
      if (!dragNode || !dropNode) return;

      const placement: SidebarTreeDropPlacement = resolveSidebarTreeDropPlacement({
              dragNodeType: dragNode.type,
              dropNodeType: dropNode.type,
              relativeDropPosition: dropPosition,
              dropToGap: info?.dropToGap,
              fallbackInsertBefore: insertBefore,
              metrics: dropTargetMetrics ? {
                  clientY: info?.event?.clientY,
                  top: dropTargetMetrics.top,
                  height: dropTargetMetrics.height,
              } : null,
          });
      if (sidebarTreeDrag.isSidebarTreeOrderNode(dragNode) || sidebarTreeDrag.isSidebarTreeOrderNode(dropNode)) {
          applySidebarTreeOrderDrop(dragNode, dropNode, placement === 'before');
          return;
      }
      applySidebarHostTreeDrop(dragNode, dropNode, placement);
  };

  const onRightClick = ({ event, node }: any) => {
      if (node?.type === 'v2-table-section' || node?.type === 'v2-database-section') {
          event.preventDefault();
          event.stopPropagation();
          return;
      }
      if (node?.type === 'tag') {
          const group = resolveV2ConnectionGroup(node, v2RailConnectionGroups);
          if (group) {
              event.preventDefault();
              event.stopPropagation();
              const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
              setContextMenu({
                  x: position.x,
                  y: position.y,
                  sourceX: event.clientX,
                  sourceY: event.clientY,
                  items: [],
                  kind: 'v2-connection-group',
                  node: group,
                  rootClassName: 'gn-v2-table-context-menu-popup',
                  overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
                  maxHeight: position.maxHeight,
              });
              return;
          }
      }
      if (node?.type === 'connection') {
          openV2ConnectionContextMenu(event, node);
          return;
      }
      if (node?.type === 'database') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-database',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (
          node?.type === 'object-group'
          && node?.dataRef?.groupKey === 'schema'
          && isPostgresSchemaDialect(getMetadataDialect(node.dataRef as SavedConnection))
          && String(node?.dataRef?.schemaName || '').trim()
      ) {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-schema',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (node?.type === 'object-group' && node?.dataRef?.groupKey === 'tables') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-table-group',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (node?.type === 'table') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-table',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      const items = getNodeMenuItems(node);
      if (items && items.length > 0) {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items,
              kind: 'v2-node',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
      }
  };

  const handleV2TreeContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const nodeKey = resolveSidebarTreeRowKey(event.target);
      if (!nodeKey) return;
      const node = findTreeNodeByKeyRef.current(treeDataRef.current, nodeKey);
      if (!node) return;
      event.preventDefault();
      onRightClick({ event, node });
  };
  return {
    updateSidebarTreeDropPreview, clearSidebarTreeDragVisuals, handleSidebarTreeDragOverCapture,
    handleSidebarTreeDropCapture, allowSidebarTreeDrop, handleDrop, onRightClick,
    handleV2TreeContextMenu,
  };
};

export type SidebarTreeDndApi = ReturnType<typeof useSidebarTreeDnd>;
