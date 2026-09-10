import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CaretRightOutlined } from '@ant-design/icons';

import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import './SettingsCenterTreeNav.css';

export type SettingsCenterTreeItem = {
  key: string;
  icon?: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  children?: ReadonlyArray<SettingsCenterTreeItem>;
};

export type SettingsCenterTreeGroup = {
  key: string;
  icon?: React.ReactNode;
  title: string;
  description: string;
  items: ReadonlyArray<SettingsCenterTreeItem>;
};

export type SettingsCenterTreeNodeId =
  | { type: 'group'; groupKey: string }
  | { type: 'item'; groupKey: string; itemKey: string; parentItemKey?: string };

type VisibleTreeNode = SettingsCenterTreeNodeId & {
  id: string;
  expandable: boolean;
  depth: number;
};

export const settingsCenterTreeNodeId = (node: SettingsCenterTreeNodeId): string => (
  node.type === 'group' ? `group:${node.groupKey}` : `item:${node.groupKey}:${node.itemKey}`
);


export const SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY = 'gonavi.settings-center.expanded-keys';

export const collectExpandableSettingsCenterTreeIds = (
  groups: ReadonlyArray<SettingsCenterTreeGroup>,
): string[] => {
  const ids: string[] = [];
  const walkItems = (groupKey: string, items: ReadonlyArray<SettingsCenterTreeItem>) => {
    items.forEach((item) => {
      if (item.children && item.children.length > 0) {
        ids.push(settingsCenterTreeNodeId({ type: 'item', groupKey, itemKey: item.key }));
        walkItems(groupKey, item.children);
      }
    });
  };
  groups.forEach((group) => {
    if (group.items.length > 0) {
      ids.push(settingsCenterTreeNodeId({ type: 'group', groupKey: group.key }));
      walkItems(group.key, group.items);
    }
  });
  return ids;
};

export const loadCollapsedKeys = (expandableIds: string[]): Set<string> => {
  if (typeof localStorage === 'undefined') {
    return new Set(expandableIds);
  }
  try {
    const raw = localStorage.getItem(SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY);
    if (raw == null) {
      return new Set(expandableIds);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set(expandableIds);
    }
    const expandableSet = new Set(expandableIds);
    const expanded = new Set(
      parsed.filter((id): id is string => typeof id === 'string' && expandableSet.has(id)),
    );
    return new Set(expandableIds.filter((id) => !expanded.has(id)));
  } catch {
    return new Set(expandableIds);
  }
};

export const saveExpandedKeysFromCollapsed = (
  collapsed: ReadonlySet<string>,
  expandableIds: string[],
): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    const expanded = expandableIds.filter((id) => !collapsed.has(id));
    localStorage.setItem(SETTINGS_CENTER_EXPANDED_KEYS_STORAGE_KEY, JSON.stringify(expanded));
  } catch {
    // Ignore quota / private-mode failures.
  }
};


const walkSettingsCenterTreeItems = (
  items: ReadonlyArray<SettingsCenterTreeItem>,
  itemKey: string,
  ancestors: string[] = [],
): { item: SettingsCenterTreeItem; ancestors: string[] } | null => {
  for (const item of items) {
    if (item.key === itemKey) {
      return { item, ancestors };
    }
    if (item.children?.length) {
      const nested = walkSettingsCenterTreeItems(item.children, itemKey, [...ancestors, item.key]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

export const findSettingsCenterTreeItem = (
  groups: ReadonlyArray<SettingsCenterTreeGroup>,
  groupKey: string,
  itemKey: string | null,
): SettingsCenterTreeItem | null => {
  if (!itemKey) {
    return null;
  }
  const group = groups.find((entry) => entry.key === groupKey);
  if (!group) {
    return null;
  }
  return walkSettingsCenterTreeItems(group.items, itemKey)?.item ?? null;
};

export const findSettingsCenterTreeAncestors = (
  groups: ReadonlyArray<SettingsCenterTreeGroup>,
  groupKey: string,
  itemKey: string | null,
): string[] => {
  if (!itemKey) {
    return [];
  }
  const group = groups.find((entry) => entry.key === groupKey);
  if (!group) {
    return [];
  }
  return walkSettingsCenterTreeItems(group.items, itemKey)?.ancestors ?? [];
};

export const flattenVisibleSettingsCenterTree = (
  groups: ReadonlyArray<SettingsCenterTreeGroup>,
  collapsedKeys: ReadonlySet<string>,
): VisibleTreeNode[] => {
  const nodes: VisibleTreeNode[] = [];
  groups.forEach((group) => {
    const groupId = settingsCenterTreeNodeId({ type: 'group', groupKey: group.key });
    const expandable = group.items.length > 0;
    nodes.push({
      type: 'group',
      groupKey: group.key,
      id: groupId,
      expandable,
      depth: 0,
    });
    if (!expandable || collapsedKeys.has(groupId) || collapsedKeys.has(group.key)) {
      return;
    }
    const pushItems = (
      items: ReadonlyArray<SettingsCenterTreeItem>,
      depth: number,
      parentItemKey?: string,
    ) => {
      items.forEach((item) => {
        const itemId = settingsCenterTreeNodeId({ type: 'item', groupKey: group.key, itemKey: item.key });
        const hasChildren = Boolean(item.children && item.children.length > 0);
        nodes.push({
          type: 'item',
          groupKey: group.key,
          itemKey: item.key,
          parentItemKey,
          id: itemId,
          expandable: hasChildren,
          depth,
        });
        if (!hasChildren || collapsedKeys.has(itemId)) {
          return;
        }
        pushItems(item.children ?? [], depth + 1, item.key);
      });
    };
    pushItems(group.items, 1);
  });
  return nodes;
};

interface SettingsCenterTreeNavProps {
  groups: ReadonlyArray<SettingsCenterTreeGroup>;
  activeGroupKey: string;
  activeItemKey: string | null;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  ariaLabel: string;
  onSelectGroup: (groupKey: string) => void;
}

const SettingsCenterTreeNav: React.FC<SettingsCenterTreeNavProps> = ({
  groups,
  activeGroupKey,
  activeItemKey,
  darkMode,
  overlayTheme,
  ariaLabel,
  onSelectGroup,
}) => {
  const expandableIds = useMemo(
    () => collectExpandableSettingsCenterTreeIds(groups),
    [groups],
  );
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => (
    loadCollapsedKeys(collectExpandableSettingsCenterTreeIds(groups))
  ));
  const previousExpandableIdsRef = useRef<string[] | null>(null);
  const selectedNodeId = activeItemKey
    ? settingsCenterTreeNodeId({ type: 'item', groupKey: activeGroupKey, itemKey: activeItemKey })
    : settingsCenterTreeNodeId({ type: 'group', groupKey: activeGroupKey });
  const [focusedNodeId, setFocusedNodeId] = useState(selectedNodeId);

  useEffect(() => {
    const previous = previousExpandableIdsRef.current;
    previousExpandableIdsRef.current = expandableIds;
    if (previous === null) {
      return;
    }
    const previousSet = new Set(previous);
    setCollapsedKeys((current) => {
      const next = new Set<string>();
      expandableIds.forEach((id) => {
        // Keep prior collapse state for known ids; new expandable nodes start collapsed.
        if (current.has(id) || !previousSet.has(id)) {
          next.add(id);
        }
      });
      const unchanged = (
        next.size === current.size
        && [...next].every((id) => current.has(id))
        && [...current].every((id) => next.has(id))
      );
      return unchanged ? current : next;
    });
  }, [expandableIds]);

  useEffect(() => {
    saveExpandedKeysFromCollapsed(collapsedKeys, expandableIds);
  }, [collapsedKeys, expandableIds]);

  useEffect(() => {
    setFocusedNodeId(selectedNodeId);
  }, [selectedNodeId]);


  // Programmatic navigation (e.g. AI panel → settings) must reveal the active leaf.
  useEffect(() => {
    const idsToExpand: string[] = [
      settingsCenterTreeNodeId({ type: 'group', groupKey: activeGroupKey }),
    ];
    if (activeItemKey) {
      const ancestors = findSettingsCenterTreeAncestors(groups, activeGroupKey, activeItemKey);
      ancestors.forEach((ancestorKey) => {
        idsToExpand.push(settingsCenterTreeNodeId({
          type: 'item',
          groupKey: activeGroupKey,
          itemKey: ancestorKey,
        }));
      });
    }
    setCollapsedKeys((current) => {
      let changed = false;
      const next = new Set(current);
      idsToExpand.forEach((id) => {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [activeGroupKey, activeItemKey, groups]);

  const visibleNodes = useMemo(
    () => flattenVisibleSettingsCenterTree(groups, collapsedKeys),
    [collapsedKeys, groups],
  );

  const toggleCollapsed = (nodeId: string) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const expandNode = (nodeId: string) => {
    setCollapsedKeys((current) => {
      if (!current.has(nodeId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  };

  const findItem = (groupKey: string, itemKey: string): SettingsCenterTreeItem | null => (
    findSettingsCenterTreeItem(groups, groupKey, itemKey)
  );

  const activateNode = (node: VisibleTreeNode) => {
    setFocusedNodeId(node.id);
    if (node.type === 'group') {
      expandNode(node.id);
      if (node.groupKey !== activeGroupKey) {
        onSelectGroup(node.groupKey);
      }
      return;
    }
    if (node.expandable) {
      expandNode(node.id);
    }
    findItem(node.groupKey, node.itemKey)?.onClick();
  };

  const revealNode = (node: VisibleTreeNode) => {
    setFocusedNodeId(node.id);
    if (node.type === 'item' && !node.expandable) {
      activateNode(node);
    }
  };

  const moveFocus = (currentId: string, delta: number) => {
    const currentIndex = visibleNodes.findIndex((visible) => visible.id === currentId);
    if (visibleNodes.length === 0) {
      return;
    }
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + delta + visibleNodes.length) % visibleNodes.length;
    revealNode(visibleNodes[nextIndex]);
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLElement>, node: VisibleTreeNode) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateNode(node);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(node.id, 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(node.id, -1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (visibleNodes[0]) {
        revealNode(visibleNodes[0]);
      }
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const lastNode = visibleNodes[visibleNodes.length - 1];
      if (lastNode) {
        revealNode(lastNode);
      }
      return;
    }
    if (event.key === 'ArrowRight' && node.expandable) {
      event.preventDefault();
      if (collapsedKeys.has(node.id)) {
        toggleCollapsed(node.id);
        return;
      }
      moveFocus(node.id, 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.expandable && !collapsedKeys.has(node.id)) {
        toggleCollapsed(node.id);
        return;
      }
      if (node.type === 'item' && node.parentItemKey) {
        setFocusedNodeId(settingsCenterTreeNodeId({
          type: 'item',
          groupKey: node.groupKey,
          itemKey: node.parentItemKey,
        }));
        return;
      }
      if (node.type === 'item') {
        setFocusedNodeId(settingsCenterTreeNodeId({ type: 'group', groupKey: node.groupKey }));
      }
    }
  };

  const nodeColor = (active: boolean) => (
    active
      ? (darkMode ? '#f5f7ff' : '#162033')
      : (darkMode ? 'rgba(255,255,255,0.82)' : '#3f4b5e')
  );

  const renderTreeItem = (
    groupKey: string,
    item: SettingsCenterTreeItem,
    depth: number,
    parentItemKey?: string,
  ) => {
    const itemId = settingsCenterTreeNodeId({ type: 'item', groupKey, itemKey: item.key });
    const hasChildren = Boolean(item.children && item.children.length > 0);
    const itemExpanded = hasChildren && !collapsedKeys.has(itemId);
    const itemActive = groupKey === activeGroupKey && item.key === activeItemKey;
    const itemFocused = focusedNodeId === itemId;
    const depthClass = depth >= 3
      ? ' is-great-grandchild'
      : depth === 2
        ? ' is-grandchild'
        : ' is-child';
    const visibleNode = {
      type: 'item' as const,
      groupKey,
      itemKey: item.key,
      parentItemKey,
      id: itemId,
      expandable: hasChildren,
      depth,
    };
    return (
      <div key={item.key} role="none">
        <div
          className={`gonavi-settings-center-tree-node${depthClass}${hasChildren ? ' has-children' : ''}${itemActive ? ' is-active' : ''}`}
          role="treeitem"
          aria-expanded={hasChildren ? itemExpanded : undefined}
          aria-selected={itemActive}
          aria-label={item.title}
          title={`${item.title} - ${item.description}`}
          tabIndex={itemFocused ? 0 : -1}
          data-settings-pane-key={item.key}
          data-settings-tree-node={itemId}
          onClick={() => activateNode(visibleNode)}
          onKeyDown={(event) => handleTreeKeyDown(event, visibleNode)}
          style={{
            background: itemActive ? overlayTheme.selectedBg : 'transparent',
            color: depth >= 2 && !itemActive ? overlayTheme.mutedText : nodeColor(itemActive),
          }}
        >
          {hasChildren ? renderCaret(itemExpanded, itemActive, itemId) : depth === 1 ? (
            <span className="gonavi-settings-center-tree-caret is-placeholder" aria-hidden="true" />
          ) : null}
          <span className="gonavi-settings-center-tree-label">{item.title}</span>
        </div>
        {itemExpanded ? (
          <div
            className={`gonavi-settings-center-tree-branch${depth >= 2 ? ' is-nested' : ''}`}
            role="group"
            aria-label={item.title}
          >
            {item.children?.map((child) => renderTreeItem(groupKey, child, depth + 1, item.key))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCaret = (expanded: boolean, active: boolean, nodeId: string) => (
    <button
      className="gonavi-settings-center-tree-caret"
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-settings-tree-toggle={nodeId}
      onClick={(event) => {
        event.stopPropagation();
        toggleCollapsed(nodeId);
      }}
    >
      <CaretRightOutlined
        style={{
          fontSize: 10,
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          color: active ? overlayTheme.selectedText : overlayTheme.mutedText,
        }}
      />
    </button>
  );

  return (
    <div
      className="gonavi-settings-center-tree"
      role="tree"
      aria-label={ariaLabel}
      aria-orientation="vertical"
    >
      {groups.map((group) => {
        const groupId = settingsCenterTreeNodeId({ type: 'group', groupKey: group.key });
        const groupExpandable = group.items.length > 0;
        const groupExpanded = groupExpandable && !collapsedKeys.has(groupId) && !collapsedKeys.has(group.key);
        const groupActive = group.key === activeGroupKey && (!groupExpandable || !activeItemKey);
        const groupFocused = focusedNodeId === groupId;
        return (
          <div key={group.key} role="none">
            <div
              className={`gonavi-settings-center-tree-node${groupActive ? ' is-active' : ''}`}
              role="treeitem"
              aria-expanded={groupExpandable ? groupExpanded : undefined}
              aria-selected={groupActive}
              aria-label={group.title}
              title={`${group.title} - ${group.description}`}
              tabIndex={groupFocused ? 0 : -1}
              data-settings-tree-node={groupId}
              onClick={() => activateNode({
                type: 'group',
                groupKey: group.key,
                id: groupId,
                expandable: groupExpandable,
                depth: 0,
              })}
              onKeyDown={(event) => handleTreeKeyDown(event, {
                type: 'group',
                groupKey: group.key,
                id: groupId,
                expandable: groupExpandable,
                depth: 0,
              })}
              style={{
                background: groupActive ? overlayTheme.selectedBg : 'transparent',
                color: nodeColor(groupActive),
              }}
            >
              {groupExpandable ? renderCaret(groupExpanded, groupActive, groupId) : (
                <span className="gonavi-settings-center-tree-caret is-placeholder" aria-hidden="true" />
              )}
              <span className="gonavi-settings-center-tree-label">{group.title}</span>
            </div>
            {groupExpanded ? (
              <div role="group" aria-label={group.title}>
                {group.items.map((item) => renderTreeItem(group.key, item, 1))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export default SettingsCenterTreeNav;
