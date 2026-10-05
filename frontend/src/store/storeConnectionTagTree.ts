import { ConnectionTag, SavedConnection, ConnectionDisplaySortMode } from "../types";
import {
  sanitizeSidebarItemOrder,
  normalizeConnectionTagTree,
  resolveSidebarRootOrderTokens,
  buildSidebarRootConnectionToken,
  isSidebarRootConnectionToken,
  getSidebarConnectionIdFromToken,
  resolveConnectionTagChildOrder,
  buildSidebarRootTagToken,
  insertSidebarRootTokenAfter,
  insertSidebarRootTokenBeforeUngrouped,
} from "./storeSidebarRootOrder";
import { toTrimmedString } from "./storeConnectionSanitizers";
import { LEGACY_DEFAULT_OPACITY, OPACITY_EPSILON } from "./storeConstants";

type ConnectionTagTreeState = {
  connectionTags: ConnectionTag[];
  sidebarRootOrder: string[];
};

export const setConnectionTagChildOrder = (
  connectionTags: ConnectionTag[],
  tagId: string,
  childOrder: string[],
): ConnectionTag[] =>
  connectionTags.map((tag) =>
    tag.id === tagId ? { ...tag, childOrder } : tag,
  );

const removeSidebarItemTokenFromTagOrders = (
  connectionTags: ConnectionTag[],
  token: string,
): ConnectionTag[] =>
  connectionTags.map((tag) => ({
    ...tag,
    childOrder: sanitizeSidebarItemOrder(tag.childOrder).filter(
      (item) => item !== token,
    ),
  }));

const placeSidebarItemToken = (
  order: string[],
  token: string,
  targetToken?: string | null,
  insertBefore = false,
): string[] => {
  if (!token) return [...order];
  if (targetToken === token) return [...order];
  const nextOrder = order.filter((item) => item !== token);
  if (!targetToken) {
    return [...nextOrder, token];
  }
  const targetIndex = nextOrder.indexOf(targetToken);
  if (targetIndex === -1) {
    return [...nextOrder, token];
  }
  const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
  nextOrder.splice(insertIndex, 0, token);
  return nextOrder;
};

export const replaceSidebarItemToken = (
  order: string[],
  token: string,
  replacements: string[],
): string[] => {
  const replacementTokens = Array.from(
    new Set(replacements.filter(Boolean)),
  );
  const replacementSet = new Set(replacementTokens);
  const result: string[] = [];
  let inserted = false;

  order.forEach((item) => {
    if (item === token) {
      if (!inserted) {
        result.push(...replacementTokens);
        inserted = true;
      }
      return;
    }
    if (replacementSet.has(item)) return;
    result.push(item);
  });
  if (!inserted) {
    result.push(...replacementTokens);
  }
  return result;
};

const getConnectionOwnerTagId = (
  connectionId: string,
  connectionTags: ConnectionTag[],
): string | undefined =>
  connectionTags.find((tag) => tag.connectionIds.includes(connectionId))?.id;

const getRootConnectionTagId = (
  tagId: string | undefined,
  connectionTags: ConnectionTag[],
): string | undefined => {
  if (!tagId) return undefined;
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const visited = new Set<string>();
  let current = tagById.get(tagId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (!current.parentTagId) return current.id;
    current = tagById.get(current.parentTagId);
  }
  return undefined;
};

const isConnectionTagSelfOrDescendant = (
  tagId: string,
  candidateParentTagId: string,
  connectionTags: ConnectionTag[],
): boolean => {
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));
  const visited = new Set<string>();
  let currentId: string | undefined = candidateParentTagId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === tagId) return true;
    visited.add(currentId);
    currentId = tagById.get(currentId)?.parentTagId;
  }
  return false;
};

export const normalizeConnectionTagTreeState = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
): ConnectionTagTreeState => {
  const nextTags = normalizeConnectionTagTree(connectionTags);
  return {
    connectionTags: nextTags,
    sidebarRootOrder: resolveSidebarRootOrderTokens(
      sidebarRootOrder,
      nextTags,
      connections,
    ),
  };
};

const sortConnectionIdsForDisplay = (
  ids: string[],
  connections: SavedConnection[],
  mode: ConnectionDisplaySortMode,
): string[] => {
  if (mode === 'manual') return [...ids];
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const stableIndex = new Map(ids.map((id, index) => [id, index]));
  return [...ids].sort((left, right) => {
    const a = connectionById.get(left);
    const b = connectionById.get(right);
    if (!a || !b) return (stableIndex.get(left) || 0) - (stableIndex.get(right) || 0);
    if (mode === 'createdAt') {
      return (b.createdAt || 0) - (a.createdAt || 0)
        || (stableIndex.get(left) || 0) - (stableIndex.get(right) || 0)
        || left.localeCompare(right);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      || (stableIndex.get(left) || 0) - (stableIndex.get(right) || 0)
      || left.localeCompare(right);
  });
};

const applyConnectionOrderToMixedTokens = (
  tokens: string[],
  orderedConnectionIds: string[],
): string[] => {
  const orderedTokens = orderedConnectionIds.map(buildSidebarRootConnectionToken);
  let connectionIndex = 0;
  return tokens.map((token) => (
    isSidebarRootConnectionToken(token)
      ? orderedTokens[connectionIndex++] || token
      : token
  ));
};

const connectionIdsFromMixedTokens = (tokens: string[]): string[] => (
  tokens
    .filter(isSidebarRootConnectionToken)
    .map(getSidebarConnectionIdFromToken)
);

export const materializeManualConnectionOrder = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
  rootConnectionSortMode: ConnectionDisplaySortMode,
  targetTagId: string | null,
): ConnectionTagTreeState & { rootConnectionSortMode: ConnectionDisplaySortMode } => {
  const normalized = normalizeConnectionTagTreeState(connectionTags, sidebarRootOrder, connections);
  const normalizedTargetTagId = toTrimmedString(targetTagId);
  if (normalizedTargetTagId) {
    const target = normalized.connectionTags.find((tag) => tag.id === normalizedTargetTagId);
    if (!target) return { ...normalized, rootConnectionSortMode };
    const currentChildOrder = resolveConnectionTagChildOrder(target.id, normalized.connectionTags);
    const currentMode = target.connectionSortMode || 'createdAt';
    const orderedConnectionIds = currentMode === 'manual'
      ? connectionIdsFromMixedTokens(currentChildOrder)
      : sortConnectionIdsForDisplay(target.connectionIds, connections, currentMode);
    const childOrder = applyConnectionOrderToMixedTokens(
      currentChildOrder,
      orderedConnectionIds,
    );
    return {
      ...normalized,
      connectionTags: normalized.connectionTags.map((tag) => (
        tag.id === target.id
          ? { ...tag, connectionIds: orderedConnectionIds, childOrder, connectionSortMode: 'manual' }
          : tag
      )),
      rootConnectionSortMode,
    };
  }

  const groupedConnectionIds = new Set(normalized.connectionTags.flatMap((tag) => tag.connectionIds));
  const rootConnectionIds = connections
    .map((connection) => connection.id)
    .filter((connectionId) => !groupedConnectionIds.has(connectionId));
  const currentRootOrder = resolveSidebarRootOrderTokens(
    normalized.sidebarRootOrder,
    normalized.connectionTags,
    connections,
  );
  const orderedConnectionIds = rootConnectionSortMode === 'manual'
    ? connectionIdsFromMixedTokens(currentRootOrder)
    : sortConnectionIdsForDisplay(rootConnectionIds, connections, rootConnectionSortMode);
  return {
    ...normalized,
    sidebarRootOrder: applyConnectionOrderToMixedTokens(
      currentRootOrder,
      orderedConnectionIds,
    ),
    rootConnectionSortMode: 'manual',
  };
};

export const moveConnectionTagInTree = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
  tagId: string,
  targetParentTagId: string | null,
  targetToken?: string | null,
  insertBefore = false,
): ConnectionTagTreeState | null => {
  const normalized = normalizeConnectionTagTreeState(
    connectionTags,
    sidebarRootOrder,
    connections,
  );
  const tagById = new Map(
    normalized.connectionTags.map((tag) => [tag.id, tag]),
  );
  const source = tagById.get(tagId);
  if (!source) return null;

  const nextParentTagId = toTrimmedString(targetParentTagId) || undefined;
  if (
    nextParentTagId &&
    (!tagById.has(nextParentTagId) ||
      isConnectionTagSelfOrDescendant(
        tagId,
        nextParentTagId,
        normalized.connectionTags,
      ))
  ) {
    return null;
  }

  const token = buildSidebarRootTagToken(tagId);
  let nextTags = removeSidebarItemTokenFromTagOrders(
    normalized.connectionTags,
    token,
  ).map((tag) =>
    tag.id === tagId ? { ...tag, parentTagId: nextParentTagId } : tag,
  );
  let nextRootOrder = normalized.sidebarRootOrder.filter(
    (item) => item !== token,
  );

  nextTags = normalizeConnectionTagTree(nextTags);
  if (nextParentTagId) {
    const targetOrder = resolveConnectionTagChildOrder(
      nextParentTagId,
      nextTags,
    );
    nextTags = setConnectionTagChildOrder(
      nextTags,
      nextParentTagId,
      placeSidebarItemToken(targetOrder, token, targetToken, insertBefore),
    );
  } else {
    const targetOrder = resolveSidebarRootOrderTokens(
      nextRootOrder,
      nextTags,
      connections,
    );
    nextRootOrder = placeSidebarItemToken(
      targetOrder,
      token,
      targetToken,
      insertBefore,
    );
  }

  return normalizeConnectionTagTreeState(
    nextTags,
    nextRootOrder,
    connections,
  );
};

export const moveConnectionInTree = (
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
  connections: SavedConnection[],
  connectionId: string,
  targetTagId: string | null,
  targetToken?: string | null,
  insertBefore = false,
): ConnectionTagTreeState | null => {
  if (!connections.some((connection) => connection.id === connectionId)) {
    return null;
  }
  const normalized = normalizeConnectionTagTreeState(
    connectionTags,
    sidebarRootOrder,
    connections,
  );
  const nextTargetTagId = toTrimmedString(targetTagId) || undefined;
  if (
    nextTargetTagId &&
    !normalized.connectionTags.some((tag) => tag.id === nextTargetTagId)
  ) {
    return null;
  }

  const sourceTagId = getConnectionOwnerTagId(
    connectionId,
    normalized.connectionTags,
  );
  const sourceRootTagId = getRootConnectionTagId(
    sourceTagId,
    normalized.connectionTags,
  );
  const token = buildSidebarRootConnectionToken(connectionId);
  let nextTags = removeSidebarItemTokenFromTagOrders(
    normalized.connectionTags,
    token,
  ).map((tag) => ({
    ...tag,
    connectionIds: tag.connectionIds.filter((id) => id !== connectionId),
  }));
  let nextRootOrder = normalized.sidebarRootOrder.filter(
    (item) => item !== token,
  );

  if (nextTargetTagId) {
    nextTags = nextTags.map((tag) =>
      tag.id === nextTargetTagId
        ? {
            ...tag,
            connectionIds: [...tag.connectionIds, connectionId],
          }
        : tag,
    );
    nextTags = normalizeConnectionTagTree(nextTags);
    const targetOrder = resolveConnectionTagChildOrder(
      nextTargetTagId,
      nextTags,
    );
    nextTags = setConnectionTagChildOrder(
      nextTags,
      nextTargetTagId,
      placeSidebarItemToken(targetOrder, token, targetToken, insertBefore),
    );
  } else {
    nextTags = normalizeConnectionTagTree(nextTags);
    const rootOrder = resolveSidebarRootOrderTokens(
      nextRootOrder,
      nextTags,
      connections,
    );
    nextRootOrder = targetToken
      ? placeSidebarItemToken(rootOrder, token, targetToken, insertBefore)
      : sourceRootTagId
        ? insertSidebarRootTokenAfter(
            rootOrder,
            token,
            buildSidebarRootTagToken(sourceRootTagId),
          )
        : insertSidebarRootTokenBeforeUngrouped(rootOrder, token);
  }

  return normalizeConnectionTagTreeState(
    nextTags,
    nextRootOrder,
    connections,
  );
};

export const orderUngroupedConnectionsBySidebarRootOrder = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  sidebarRootOrder: string[],
): SavedConnection[] => {
  const rootOrder = resolveSidebarRootOrderTokens(
    sidebarRootOrder,
    connectionTags,
    connections,
  );
  const orderMap = new Map<string, number>();
  rootOrder.forEach((token, index) => {
    if (isSidebarRootConnectionToken(token)) {
      orderMap.set(getSidebarConnectionIdFromToken(token), index);
    }
  });
  return [...connections].sort((left, right) => {
    const leftIndex = orderMap.get(left.id);
    const rightIndex = orderMap.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return 0;
  });
};

export const isLegacyDefaultAppearance = (
  appearance: Partial<{ opacity: number; blur: number }> | undefined,
): boolean => {
  if (!appearance) {
    return true;
  }
  const opacity =
    typeof appearance.opacity === "number"
      ? appearance.opacity
      : LEGACY_DEFAULT_OPACITY;
  const blur = typeof appearance.blur === "number" ? appearance.blur : 0;
  return (
    Math.abs(opacity - LEGACY_DEFAULT_OPACITY) < OPACITY_EPSILON && blur === 0
  );
};
