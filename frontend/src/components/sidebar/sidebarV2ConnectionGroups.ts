import {
  buildSidebarRootConnectionToken,
  buildSidebarRootTagToken,
  resolveConnectionTagChildOrder,
  resolveSidebarRootOrderTokens,
} from '../../store';
import type { SavedConnection, ConnectionTag, ConnectionDisplaySortMode } from '../../types';
import { t } from '../../i18n';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';

export interface V2RailConnectionGroup {
  id: string;
  name: string;
  connections: SavedConnection[];
  directConnections?: SavedConnection[];
  children?: V2RailConnectionGroup[];
  isUngrouped?: boolean;
  rootToken: string;
}

export type SidebarConnectionTagTreeItem =
  | {
    kind: 'tag';
    id: string;
    token: string;
    tag: ConnectionTag;
    children: SidebarConnectionTagTreeItem[];
  }
  | {
    kind: 'connection';
    id: string;
    token: string;
    connection: SavedConnection;
  };

const resolveConnectionTagParentId = (tag: ConnectionTag): string =>
  String(tag.parentTagId || '').trim();

/**
 * Returns true when candidateChildTagId is below ancestorTagId. The guard also
 * makes a malformed persisted loop harmless while the store normalizes it.
 */
export const isConnectionTagDescendant = (
  ancestorTagId: string,
  candidateChildTagId: string | null | undefined,
  connectionTags: ConnectionTag[],
): boolean => {
  const ancestorId = String(ancestorTagId || '').trim();
  let currentId = String(candidateChildTagId || '').trim();
  if (!ancestorId || !currentId) return false;

  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true;
    seen.add(currentId);
    const currentTag = tagById.get(currentId);
    if (!currentTag) break;
    currentId = resolveConnectionTagParentId(currentTag);
  }
  return false;
};

/**
 * Builds the host-group hierarchy from flat persisted records. `childOrder`
 * owns the mixed sibling order while `parentTagId` owns group containment.
 */
export const buildSidebarConnectionTagTree = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[] = [],
  _rootSortMode: ConnectionTag['sortMode'] = 'manual',
  rootConnectionSortMode: ConnectionDisplaySortMode = 'createdAt',
): SidebarConnectionTagTreeItem[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const rawParentById = new Map(
    connectionTags.map((tag) => [tag.id, resolveConnectionTagParentId(tag)]),
  );

  const resolveSafeParentId = (tagId: string): string => {
    const parentId = rawParentById.get(tagId) || '';
    if (!parentId || !tagById.has(parentId) || parentId === tagId) return '';

    const seen = new Set<string>([tagId]);
    let currentId = parentId;
    while (currentId) {
      if (seen.has(currentId)) return '';
      seen.add(currentId);
      const nextId = rawParentById.get(currentId) || '';
      if (!nextId || !tagById.has(nextId)) break;
      currentId = nextId;
    }
    return parentId;
  };

  const parentByTagId = new Map<string, string>();
  const childTagIdsByParentId = new Map<string, string[]>();
  const rootTagIds: string[] = [];
  connectionTags.forEach((tag) => {
    const parentId = resolveSafeParentId(tag.id);
    parentByTagId.set(tag.id, parentId);
    if (!parentId) {
      rootTagIds.push(tag.id);
      return;
    }
    const childIds = childTagIdsByParentId.get(parentId) || [];
    childIds.push(tag.id);
    childTagIdsByParentId.set(parentId, childIds);
  });

  // A connection can only be rendered once, even if an old persisted payload
  // still lists it in more than one group before hydration cleanup runs.
  const connectionOwnerTagId = new Map<string, string>();
  connectionTags.forEach((tag) => {
    tag.connectionIds.forEach((connectionId) => {
      if (!connectionById.has(connectionId) || connectionOwnerTagId.has(connectionId)) return;
      connectionOwnerTagId.set(connectionId, tag.id);
    });
  });

  const directConnectionIdsForTag = (tagId: string): string[] => {
    const tag = tagById.get(tagId);
    if (!tag) return [];
    return tag.connectionIds.filter((connectionId) => (
      connectionOwnerTagId.get(connectionId) === tagId && connectionById.has(connectionId)
    ));
  };

  const sortConnectionIds = (ids: string[], mode: ConnectionDisplaySortMode): string[] => {
    if (mode === 'manual') return ids;
    const manualIndex = new Map(ids.map((id, index) => [id, index]));
    return [...ids].sort((left, right) => {
      const a = connectionById.get(left);
      const b = connectionById.get(right);
      if (!a || !b) return (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0);
      if (mode === 'createdAt') {
        return (b.createdAt || 0) - (a.createdAt || 0)
          || (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0)
          || left.localeCompare(right);
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
        || (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0)
        || left.localeCompare(right);
    });
  };

  const applyConnectionSort = (tokens: string[], ids: string[], mode: ConnectionDisplaySortMode): string[] => {
    const sorted = sortConnectionIds(ids, mode);
    if (sorted === ids) return tokens;
    const sortedTokens = sorted.map(buildSidebarRootConnectionToken);
    let index = 0;
    return tokens.map((token) => token.startsWith('connection:') ? sortedTokens[index++] || token : token);
  };

  const resolveOrderedChildTokens = (tagId: string): string[] => {
    const directTagIds = childTagIdsByParentId.get(tagId) || [];
    const directConnectionIds = directConnectionIdsForTag(tagId);
    const allowedTokens = new Set([
      ...directConnectionIds.map(buildSidebarRootConnectionToken),
      ...directTagIds.map(buildSidebarRootTagToken),
    ]);
    const result: string[] = [];
    const append = (token: string) => {
      if (!allowedTokens.has(token) || result.includes(token)) return;
      result.push(token);
    };

    const orderedTokens = resolveConnectionTagChildOrder(tagId, connectionTags);
    applyConnectionSort(
      orderedTokens,
      directConnectionIds,
      tagById.get(tagId)?.connectionSortMode || 'createdAt',
    ).forEach(append);
    // Legacy groups have no childOrder; keep their old host-first layout and
    // append any new subgroup records in their persisted creation order.
    directConnectionIds.forEach((id) => append(buildSidebarRootConnectionToken(id)));
    directTagIds.forEach((id) => append(buildSidebarRootTagToken(id)));
    return result;
  };

  const rootConnectionIds = connections
    .map((connection) => connection.id)
    .filter((connectionId) => !connectionOwnerTagId.has(connectionId));
  const rootAllowedTokens = new Set([
    ...rootTagIds.map(buildSidebarRootTagToken),
    ...rootConnectionIds.map(buildSidebarRootConnectionToken),
  ]);
  const orderedRootTokens: string[] = [];
  const appendRoot = (token: string) => {
    if (!rootAllowedTokens.has(token) || orderedRootTokens.includes(token)) return;
    orderedRootTokens.push(token);
  };
  const rawRootTokens = resolveSidebarRootOrderTokens(sidebarRootOrder, connectionTags, connections);
  applyConnectionSort(rawRootTokens, rootConnectionIds, rootConnectionSortMode).forEach(appendRoot);
  rootTagIds.forEach((id) => appendRoot(buildSidebarRootTagToken(id)));
  rootConnectionIds.forEach((id) => appendRoot(buildSidebarRootConnectionToken(id)));

  const buildTagItem = (tagId: string, activeTagIds: Set<string>): SidebarConnectionTagTreeItem | null => {
    const tag = tagById.get(tagId);
    if (!tag || activeTagIds.has(tagId)) return null;

    const nextActiveTagIds = new Set(activeTagIds);
    nextActiveTagIds.add(tagId);
    const children: SidebarConnectionTagTreeItem[] = [];
    resolveOrderedChildTokens(tagId).forEach((token) => {
      if (token.startsWith('tag:')) {
        const childTagId = token.slice('tag:'.length);
        if (parentByTagId.get(childTagId) !== tagId) return;
        const child = buildTagItem(childTagId, nextActiveTagIds);
        if (child) children.push(child);
        return;
      }
      if (token.startsWith('connection:')) {
        const connectionId = token.slice('connection:'.length);
        if (connectionOwnerTagId.get(connectionId) !== tagId) return;
        const connection = connectionById.get(connectionId);
        if (!connection) return;
        children.push({
          kind: 'connection',
          id: connectionId,
          token,
          connection,
        });
      }
    });

    return {
      kind: 'tag',
      id: tag.id,
      token: buildSidebarRootTagToken(tag.id),
      tag,
      children,
    };
  };

  const rootItems: SidebarConnectionTagTreeItem[] = [];
  orderedRootTokens.forEach((token) => {
    if (token.startsWith('tag:')) {
      const tagId = token.slice('tag:'.length);
      if (parentByTagId.get(tagId)) return;
      const tag = buildTagItem(tagId, new Set());
      if (tag) rootItems.push(tag);
      return;
    }
    if (token.startsWith('connection:')) {
      const connectionId = token.slice('connection:'.length);
      if (connectionOwnerTagId.has(connectionId)) return;
      const connection = connectionById.get(connectionId);
      if (!connection) return;
      rootItems.push({
        kind: 'connection',
        id: connectionId,
        token,
        connection,
      });
    }
  });

  return rootItems;
};

export const flattenSidebarConnectionTagTree = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[] = [],
  rootSortMode: ConnectionTag['sortMode'] = 'manual',
  rootConnectionSortMode: ConnectionDisplaySortMode = 'createdAt',
): SavedConnection[] => {
  const ordered: SavedConnection[] = [];
  const append = (items: SidebarConnectionTagTreeItem[]) => {
    items.forEach((item) => {
      if (item.kind === 'connection') {
        ordered.push(item.connection);
        return;
      }
      append(item.children);
    });
  };

  append(buildSidebarConnectionTagTree(connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode));
  return ordered;
};

export const buildV2RailConnectionGroups = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[] = [],
  rootSortMode: ConnectionTag['sortMode'] = 'manual',
  rootConnectionSortMode: ConnectionDisplaySortMode = 'createdAt',
): V2RailConnectionGroup[] => {
  const buildGroup = (item: SidebarConnectionTagTreeItem): V2RailConnectionGroup => {
    if (item.kind === 'connection') {
      return {
        id: item.id,
        name: item.connection.name,
        connections: [item.connection],
        directConnections: [item.connection],
        isUngrouped: true,
        rootToken: item.token,
      };
    }

    const directConnections = item.children
      .filter((child): child is Extract<SidebarConnectionTagTreeItem, { kind: 'connection' }> => child.kind === 'connection')
      .map((child) => child.connection);
    const children = item.children
      .filter((child): child is Extract<SidebarConnectionTagTreeItem, { kind: 'tag' }> => child.kind === 'tag')
      .map(buildGroup);
    return {
      id: item.id,
      name: item.tag.name || t('connection.sidebar.group.untitled'),
      connections: [...directConnections, ...children.flatMap((child) => child.connections)],
      directConnections,
      children,
      rootToken: item.token,
    };
  };

  return buildSidebarConnectionTagTree(connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode).map(buildGroup);
};

export const resolveV2ConnectionGroup = (
  node: Pick<SidebarTreeNode, 'type' | 'dataRef'> | null | undefined,
  groups: V2RailConnectionGroup[],
): V2RailConnectionGroup | null => {
  if (node?.type !== 'tag') return null;
  const groupId = String(node.dataRef?.id || '').trim();
  if (!groupId) return null;

  const findGroup = (items: V2RailConnectionGroup[]): V2RailConnectionGroup | null => {
    for (const group of items) {
      if (group.id === groupId) return group;
      const childMatch = findGroup(group.children || []);
      if (childMatch) return childMatch;
    }
    return null;
  };

  return findGroup(groups);
};

export const getV2RailConnectionGroupBadgeText = (name: unknown, fallback = t('connection.sidebar.group.badge')): string => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return fallback;
  const cjkParts = trimmed.match(/[\u4e00-\u9fa5]/g);
  if (cjkParts && cjkParts.length > 0) {
    return cjkParts.slice(0, 1).join('');
  }
  const latinTokens = trimmed.match(/[a-z0-9]+/gi) || [];
  if (latinTokens.length >= 2) {
    const firstToken = latinTokens[0] || '';
    const secondToken = latinTokens[1] || '';
    return `${firstToken[0] || ''}${secondToken[0] || ''}`.toUpperCase();
  }
  if (latinTokens.length === 1) {
    const token = latinTokens[0] || '';
    const alphaPrefix = token.match(/^[a-z]+/i)?.[0] || '';
    if (alphaPrefix) {
      return alphaPrefix.slice(0, 2).toUpperCase();
    }
    const trailingDigits = token.match(/(\d{2,})$/)?.[1];
    if (trailingDigits) {
      return trailingDigits.slice(-2).toUpperCase();
    }
    return token.slice(0, 2).toUpperCase();
  }
  return trimmed.slice(0, 2);
};
