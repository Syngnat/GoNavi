import {
  ConnectionTag,
  ConnectionSortMode,
  ConnectionDisplaySortMode,
  SavedConnection,
} from "../types";
import {
  toTrimmedString,
  indexedStoreFallback,
  sanitizeStringArray,
} from "./storeConnectionSanitizers";

const SIDEBAR_ROOT_TAG_TOKEN_PREFIX = "tag:";
const SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX = "connection:";

export const buildSidebarRootTagToken = (tagId: string): string =>
  `${SIDEBAR_ROOT_TAG_TOKEN_PREFIX}${toTrimmedString(tagId)}`;

export const buildSidebarRootConnectionToken = (
  connectionId: string,
): string => `${SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX}${toTrimmedString(connectionId)}`;

export const isSidebarRootTagToken = (token: string): boolean =>
  token.startsWith(SIDEBAR_ROOT_TAG_TOKEN_PREFIX) &&
  token.length > SIDEBAR_ROOT_TAG_TOKEN_PREFIX.length;

export const isSidebarRootConnectionToken = (token: string): boolean =>
  token.startsWith(SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX) &&
  token.length > SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX.length;

const getSidebarTagIdFromToken = (token: string): string =>
  isSidebarRootTagToken(token)
    ? token.slice(SIDEBAR_ROOT_TAG_TOKEN_PREFIX.length)
    : "";

export const getSidebarConnectionIdFromToken = (token: string): string =>
  isSidebarRootConnectionToken(token)
    ? token.slice(SIDEBAR_ROOT_CONNECTION_TOKEN_PREFIX.length)
    : "";

export const sanitizeSidebarItemOrder = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry) => {
    const token = toTrimmedString(entry);
    if (!token) return;
    if (!isSidebarRootTagToken(token) && !isSidebarRootConnectionToken(token)) {
      return;
    }
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });
  return result;
};

export const sanitizeSidebarRootOrder = sanitizeSidebarItemOrder;

export const normalizeConnectionTagTree = (
  value: ConnectionTag[],
): ConnectionTag[] => {
  const tags: ConnectionTag[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const id =
      toTrimmedString(entry.id, `tag-${index + 1}`) || `tag-${index + 1}`;
    if (idSet.has(id)) return;
    idSet.add(id);

    const fallbackName = indexedStoreFallback(
      "store.fallback.connection_tag_name",
      index,
    );
    const name = toTrimmedString(entry.name, fallbackName) || fallbackName;
    const parentTagId = toTrimmedString(entry.parentTagId) || undefined;
    const createdAt = Number(entry.createdAt);
    tags.push({
      id,
      name,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined,
      parentTagId,
      connectionIds: sanitizeStringArray(entry.connectionIds, 256),
      childOrder: sanitizeSidebarItemOrder(entry.childOrder),
      // Group order is always user-defined. Preserve a legacy automatic mode
      // only as the initial direct-connection display preference.
      sortMode: 'manual',
      connectionSortMode: entry.connectionSortMode === 'manual' || entry.connectionSortMode === 'name' || entry.connectionSortMode === 'createdAt'
        ? entry.connectionSortMode
        : entry.sortMode === 'name' || entry.sortMode === 'createdAt'
          ? entry.sortMode
          : 'createdAt',
    });
  });

  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  tags.forEach((tag) => {
    if (
      !tag.parentTagId ||
      tag.parentTagId === tag.id ||
      !tagById.has(tag.parentTagId)
    ) {
      tag.parentTagId = undefined;
    }
  });

  // Corrupted persisted data must never make the sidebar recurse forever.
  // Promote every member of a detected parent cycle to the root.
  tags.forEach((tag) => {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let currentId = tag.id;
    while (currentId) {
      const current = tagById.get(currentId);
      if (!current?.parentTagId) break;
      const cycleStart = pathIndex.get(currentId);
      if (cycleStart !== undefined) {
        path.slice(cycleStart).forEach((cycleTagId) => {
          const cycleTag = tagById.get(cycleTagId);
          if (cycleTag) cycleTag.parentTagId = undefined;
        });
        break;
      }
      pathIndex.set(currentId, path.length);
      path.push(currentId);
      currentId = current.parentTagId;
    }
  });

  // A host can have one direct owner only. Keep the first persisted owner to
  // make recovery deterministic and match the flat model's intended invariant.
  const assignedConnectionIds = new Set<string>();
  tags.forEach((tag) => {
    tag.connectionIds = tag.connectionIds.filter((connectionId) => {
      if (assignedConnectionIds.has(connectionId)) return false;
      assignedConnectionIds.add(connectionId);
      return true;
    });
  });

  return tags.map((tag) => {
    const childOrder = resolveConnectionTagChildOrder(tag.id, tags);
    return {
      ...tag,
      // Keep the direct-host array aligned with its display-order subsequence.
      connectionIds: childOrder
        .filter(isSidebarRootConnectionToken)
        .map(getSidebarConnectionIdFromToken),
      childOrder,
    };
  });
};

export const sanitizeConnectionTags = (value: unknown): ConnectionTag[] => {
  if (!Array.isArray(value)) return [];
  const result: ConnectionTag[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const id =
      toTrimmedString(raw.id, `tag-${index + 1}`) || `tag-${index + 1}`;
    if (idSet.has(id)) return;
    idSet.add(id);

    const fallbackName = indexedStoreFallback(
      "store.fallback.connection_tag_name",
      index,
    );
    const name = toTrimmedString(raw.name, fallbackName) || fallbackName;
    const sortMode = toTrimmedString(raw.sortMode) as ConnectionSortMode;
    const connectionSortMode = toTrimmedString(raw.connectionSortMode) as ConnectionDisplaySortMode;
    const createdAt = Number(raw.createdAt);
    result.push({
      id,
      name,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined,
      parentTagId: toTrimmedString(raw.parentTagId) || undefined,
      connectionIds: sanitizeStringArray(raw.connectionIds, 256),
      childOrder: sanitizeSidebarItemOrder(raw.childOrder),
      sortMode: 'manual',
      connectionSortMode: connectionSortMode === 'manual' || connectionSortMode === 'name' || connectionSortMode === 'createdAt'
        ? connectionSortMode
        : sortMode === 'name' || sortMode === 'createdAt'
          ? sortMode
          : 'createdAt',
    });
  });

  return normalizeConnectionTagTree(result);
};

export const resolveConnectionTagChildOrder = (
  tagId: string,
  connectionTags: ConnectionTag[],
): string[] => {
  const tag = connectionTags.find((candidate) => candidate.id === tagId);
  if (!tag) return [];

  const defaultOrder = [
    ...sanitizeStringArray(tag.connectionIds, 256).map(
      buildSidebarRootConnectionToken,
    ),
    ...connectionTags
      .filter((candidate) => candidate.parentTagId === tagId)
      .map((candidate) => buildSidebarRootTagToken(candidate.id)),
  ];
  const validTokens = new Set(defaultOrder);
  const seen = new Set<string>();
  const result: string[] = [];

  sanitizeSidebarItemOrder(tag.childOrder).forEach((token) => {
    if (!validTokens.has(token) || seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });
  defaultOrder.forEach((token) => {
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  return result;
};

const buildDefaultSidebarRootOrderTokens = (
  connectionTags: ConnectionTag[],
  connections: SavedConnection[],
): string[] => {
  const groupedConnectionIds = new Set<string>();
  connectionTags.forEach((tag) => {
    tag.connectionIds.forEach((connectionId) => {
      if (connectionId) groupedConnectionIds.add(connectionId);
    });
  });

  return [
    ...connectionTags
      .filter((tag) => !tag.parentTagId)
      .map((tag) => buildSidebarRootTagToken(tag.id)),
    ...connections
      .filter((connection) => !groupedConnectionIds.has(connection.id))
      .map((connection) => buildSidebarRootConnectionToken(connection.id)),
  ];
};

export const resolveSidebarRootOrderTokens = (
  sidebarRootOrder: unknown,
  connectionTags: ConnectionTag[],
  connections: SavedConnection[],
): string[] => {
  const defaultOrder = buildDefaultSidebarRootOrderTokens(
    connectionTags,
    connections,
  );
  if (defaultOrder.length === 0) {
    return [];
  }

  const validTokens = new Set(defaultOrder);
  const seen = new Set<string>();
  const result: string[] = [];

  sanitizeSidebarRootOrder(sidebarRootOrder).forEach((token) => {
    if (!validTokens.has(token) || seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  defaultOrder.forEach((token) => {
    if (seen.has(token)) return;
    seen.add(token);
    result.push(token);
  });

  return result;
};

export const resolveHydratedSidebarRootOrderTokens = (
  sidebarRootOrder: unknown,
  connectionTags?: ConnectionTag[],
  connections?: SavedConnection[],
): string[] => {
  const sanitized = sanitizeSidebarRootOrder(sidebarRootOrder);
  if (!connectionTags) {
    return sanitized;
  }
  const rootTagIds = new Set(
    connectionTags
      .filter((tag) => !tag.parentTagId)
      .map((tag) => tag.id),
  );
  const rootOnly = sanitized.filter(
    (token) =>
      !isSidebarRootTagToken(token) ||
      rootTagIds.has(getSidebarTagIdFromToken(token)),
  );
  if (!connections) {
    return rootOnly;
  }
  return resolveSidebarRootOrderTokens(rootOnly, connectionTags, connections);
};

export const insertSidebarRootTokenBeforeUngrouped = (
  sidebarRootOrder: string[],
  token: string,
): string[] => {
  if (!token || sidebarRootOrder.includes(token)) {
    return [...sidebarRootOrder];
  }
  const firstConnectionIndex = sidebarRootOrder.findIndex(
    isSidebarRootConnectionToken,
  );
  if (firstConnectionIndex === -1) {
    return [...sidebarRootOrder, token];
  }
  const nextOrder = [...sidebarRootOrder];
  nextOrder.splice(firstConnectionIndex, 0, token);
  return nextOrder;
};

export const insertSidebarRootTokenAfter = (
  sidebarRootOrder: string[],
  token: string,
  anchorToken: string,
): string[] => {
  if (!token) return [...sidebarRootOrder];
  const nextOrder = sidebarRootOrder.filter((item) => item !== token);
  const anchorIndex = nextOrder.indexOf(anchorToken);
  if (anchorIndex === -1) {
    nextOrder.push(token);
    return nextOrder;
  }
  nextOrder.splice(anchorIndex + 1, 0, token);
  return nextOrder;
};

export const moveSidebarRootToken = (
  sidebarRootOrder: string[],
  sourceToken: string,
  targetToken: string,
  insertBefore: boolean,
): string[] => {
  if (!sourceToken || !targetToken || sourceToken === targetToken) {
    return [...sidebarRootOrder];
  }
  const filtered = sidebarRootOrder.filter((token) => token !== sourceToken);
  const targetIndex = filtered.indexOf(targetToken);
  const insertIndex =
    targetIndex === -1
      ? filtered.length
      : Math.max(
          0,
          Math.min(
            filtered.length,
            insertBefore ? targetIndex : targetIndex + 1,
          ),
        );
  filtered.splice(insertIndex, 0, sourceToken);
  return filtered;
};
