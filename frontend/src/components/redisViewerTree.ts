import type { DataNode } from 'antd/es/tree';
import type { RedisKeyInfo } from '../types';

const KEY_GROUP_DELIMITER = ':';
const EMPTY_SEGMENT_LABEL = '(empty)';

type RedisKeyTreeLeaf = {
  keyInfo: RedisKeyInfo;
  label: string;
};

type RedisKeyTreeGroup = {
  name: string;
  path: string;
  children: Map<string, RedisKeyTreeGroup>;
  leaves: RedisKeyTreeLeaf[];
  leafCount: number;
};

export type RedisTreeDataNode = Omit<DataNode, 'children'> & {
  nodeType: 'group' | 'leaf';
  children?: RedisTreeDataNode[];
  groupName?: string;
  groupPath?: string;
  groupLeafCount?: number;
  leafLabel?: string;
  rawKey?: string;
  keyType?: string;
  ttl?: number;
  descendantRawKeys?: string[];
};

export type RedisKeyTreeResult = {
  treeData: RedisTreeDataNode[];
  groupKeys: string[];
};

export type RedisTreeCheckedState = {
  checked: string[];
  halfChecked: string[];
};

export type RenamedRedisKeyStateInput = {
  keys: RedisKeyInfo[];
  selectedKey: string | null;
  selectedKeys: string[];
};

export type RenamedRedisKeyStateResult = {
  keys: RedisKeyInfo[];
  selectedKey: string | null;
  selectedKeys: string[];
};

const normalizeKeySegment = (segment: string): string => {
  return segment === '' ? EMPTY_SEGMENT_LABEL : segment;
};

const createTreeGroup = (name: string, path: string): RedisKeyTreeGroup => {
  return { name, path, children: new Map(), leaves: [], leafCount: 0 };
};

const calculateGroupLeafCount = (group: RedisKeyTreeGroup): number => {
  let count = group.leaves.length;
  group.children.forEach((child) => {
    count += calculateGroupLeafCount(child);
  });
  group.leafCount = count;
  return count;
};

export const buildLeafNodeKey = (rawKey: string): string => `key:${rawKey}`;

export const parseRawKeyFromNodeKey = (nodeKey: React.Key): string | null => {
  const keyText = String(nodeKey);
  if (!keyText.startsWith('key:')) {
    return null;
  }
  return keyText.slice(4);
};

export const buildRedisKeyTree = (
  keys: RedisKeyInfo[],
  sortLeafNodes: boolean
): RedisKeyTreeResult => {
  const root = createTreeGroup('__root__', '__root__');

  keys.forEach((keyInfo) => {
    const segments = keyInfo.key.split(KEY_GROUP_DELIMITER);
    if (segments.length <= 1) {
      root.leaves.push({ keyInfo, label: keyInfo.key });
      return;
    }

    const groupSegments = segments.slice(0, -1);
    const leafLabel = normalizeKeySegment(segments[segments.length - 1]);
    let current = root;
    const pathParts: string[] = [];

    groupSegments.forEach((segment) => {
      const normalized = normalizeKeySegment(segment);
      pathParts.push(normalized);
      const groupPath = pathParts.join(KEY_GROUP_DELIMITER);
      let child = current.children.get(normalized);
      if (!child) {
        child = createTreeGroup(normalized, groupPath);
        current.children.set(normalized, child);
      }
      current = child;
    });

    current.leaves.push({ keyInfo, label: leafLabel });
  });

  calculateGroupLeafCount(root);
  const groupKeys: string[] = [];

  const toTreeNodes = (group: RedisKeyTreeGroup): RedisTreeDataNode[] => {
    const childGroups = Array.from(group.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    const childLeaves = sortLeafNodes
      ? [...group.leaves].sort((a, b) => a.keyInfo.key.localeCompare(b.keyInfo.key))
      : group.leaves;

    const groupNodes: RedisTreeDataNode[] = childGroups.map((child) => {
      const children = toTreeNodes(child);
      const descendantRawKeys = children.flatMap((node) => {
        if (node.nodeType === 'leaf') {
          return node.rawKey ? [node.rawKey] : [];
        }
        return node.descendantRawKeys || [];
      });
      const groupNodeKey = `group:${child.path}`;
      groupKeys.push(groupNodeKey);
      return {
        key: groupNodeKey,
        title: child.name,
        nodeType: 'group',
        groupName: child.name,
        groupPath: child.path,
        groupLeafCount: child.leafCount,
        descendantRawKeys,
        children,
      };
    });

    const leafNodes: RedisTreeDataNode[] = childLeaves.map((leaf) => {
      return {
        key: buildLeafNodeKey(leaf.keyInfo.key),
        isLeaf: true,
        title: leaf.label,
        nodeType: 'leaf',
        leafLabel: leaf.label,
        rawKey: leaf.keyInfo.key,
        keyType: leaf.keyInfo.type,
        ttl: leaf.keyInfo.ttl,
      };
    });

    return [...groupNodes, ...leafNodes];
  };

  return {
    treeData: toTreeNodes(root),
    groupKeys,
  };
};

export const applyTreeNodeCheck = (
  selectedKeys: string[],
  node: RedisTreeDataNode,
  checked: boolean
): string[] => {
  if (node.nodeType === 'leaf') {
    if (!node.rawKey) {
      return selectedKeys;
    }
    if (checked) {
      return Array.from(new Set([...selectedKeys, node.rawKey]));
    }
    return selectedKeys.filter((item) => item !== node.rawKey);
  }

  const descendantRawKeys = node.descendantRawKeys || [];
  if (descendantRawKeys.length === 0) {
    return selectedKeys;
  }
  if (checked) {
    return Array.from(new Set([...selectedKeys, ...descendantRawKeys]));
  }
  const removeSet = new Set(descendantRawKeys);
  return selectedKeys.filter((item) => !removeSet.has(item));
};

const walkGroupStates = (
  nodes: RedisTreeDataNode[],
  selectedKeySet: Set<string>,
  checked: string[],
  halfChecked: string[]
) => {
  nodes.forEach((node) => {
    if (node.nodeType === 'leaf') {
      if (node.rawKey && selectedKeySet.has(node.rawKey)) {
        checked.push(String(node.key));
      }
      return;
    }

    walkGroupStates((node.children || []) as RedisTreeDataNode[], selectedKeySet, checked, halfChecked);
    const descendantRawKeys = node.descendantRawKeys || [];
    if (descendantRawKeys.length === 0) {
      return;
    }

    const selectedCount = descendantRawKeys.filter((rawKey) => selectedKeySet.has(rawKey)).length;
    if (selectedCount === descendantRawKeys.length) {
      checked.push(String(node.key));
      return;
    }
    if (selectedCount > 0) {
      halfChecked.push(String(node.key));
    }
  });
};

export const buildCheckedTreeNodeState = (
  selectedKeys: string[],
  keyTree: RedisKeyTreeResult
): RedisTreeCheckedState => {
  const selectedKeySet = new Set(selectedKeys);
  const checked: string[] = [];
  const halfChecked: string[] = [];

  walkGroupStates(keyTree.treeData, selectedKeySet, checked, halfChecked);
  return { checked, halfChecked };
};

export const isGroupFullyChecked = (
  node: RedisTreeDataNode,
  selectedKeys: string[]
): boolean => {
  if (node.nodeType !== 'group') {
    return false;
  }
  const descendantRawKeys = node.descendantRawKeys || [];
  if (descendantRawKeys.length === 0) {
    return false;
  }
  const selectedKeySet = new Set(selectedKeys);
  return descendantRawKeys.every((rawKey) => selectedKeySet.has(rawKey));
};

export const applyRenamedRedisKeyState = (
  state: RenamedRedisKeyStateInput,
  oldKey: string,
  newKey: string
): RenamedRedisKeyStateResult => {
  return {
    keys: state.keys.map((item) => (item.key === oldKey ? { ...item, key: newKey } : item)),
    selectedKey: state.selectedKey === oldKey ? newKey : state.selectedKey,
    selectedKeys: state.selectedKeys.map((item) => (item === oldKey ? newKey : item)),
  };
};
