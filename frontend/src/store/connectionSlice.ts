import { sanitizeSavedConnection, sanitizeConnections } from "./storeConnectionConfig";
import {
  buildSidebarRootConnectionToken,
  sanitizeSidebarItemOrder,
  sanitizeConnectionTags,
  sanitizeSidebarRootOrder,
  buildSidebarRootTagToken,
  resolveConnectionTagChildOrder,
  normalizeConnectionTagTree,
  insertSidebarRootTokenBeforeUngrouped,
  resolveSidebarRootOrderTokens,
  isSidebarRootTagToken,
  moveSidebarRootToken,
} from "./storeSidebarRootOrder";
import {
  normalizeConnectionTagTreeState,
  materializeManualConnectionOrder,
  moveConnectionInTree,
  moveConnectionTagInTree,
  setConnectionTagChildOrder,
  replaceSidebarItemToken,
  orderUngroupedConnectionsBySidebarRootOrder,
} from "./storeConnectionTagTree";
import { removeConnectionTableAccessCounts } from "../utils/tableAccessCount";
import { readPersistedShortcutOptions } from "./storeSettingsSanitizers";
import { ConnectionDisplaySortMode, ConnectionTag } from "../types";
import { v4 as uuidv4 } from "uuid";
import {
  toTrimmedString,
  indexedStoreFallback,
  sanitizeStringArray,
} from "./storeConnectionSanitizers";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type ConnectionSliceState = Pick<AppState, 
  | 'addConnection'
  | 'updateConnection'
  | 'removeConnection'
  | 'replaceConnections'
  | 'replaceConnectionSidebarLayout'
  | 'setConnectionDisplaySortMode'
  | 'duplicateConnectionTag'
  | 'moveConnectionsToTag'
  | 'addConnectionTag'
  | 'updateConnectionTag'
  | 'removeConnectionTag'
  | 'removeConnectionTagTree'
  | 'moveConnectionToTag'
  | 'moveConnectionTag'
  | 'reorderConnections'
  | 'reorderTags'
  | 'reorderSidebarRoot'
>;

export const createConnectionSlice = (set: StoreSet, get: StoreGet): ConnectionSliceState => ({
  addConnection: (conn) =>
    set((state) => {
      const sanitized = sanitizeSavedConnection(
        conn,
        state.connections.length,
      );
      if (!sanitized) {
        return { connections: state.connections };
      }
      return { connections: [...state.connections, sanitized] };
    }),
  updateConnection: (conn) =>
    set((state) => {
      const sanitized = sanitizeSavedConnection(
        conn,
        state.connections.length,
      );
      if (!sanitized) {
        return { connections: state.connections };
      }
      return {
        connections: state.connections.map((c) =>
          c.id === conn.id ? sanitized : c,
        ),
      };
    }),
  removeConnection: (id) =>
    set((state) => {
      const nextConnections = state.connections.filter((c) => c.id !== id);
      const connectionToken = buildSidebarRootConnectionToken(id);
      const nextTags = state.connectionTags.map((tag) => ({
        ...tag,
        connectionIds: tag.connectionIds.filter((cid) => cid !== id),
        childOrder: sanitizeSidebarItemOrder(tag.childOrder).filter(
          (token) => token !== connectionToken,
        ),
      }));
      const normalized = normalizeConnectionTagTreeState(
        nextTags,
        state.sidebarRootOrder.filter(
          (token) => token !== connectionToken,
        ),
        nextConnections,
      );
      const nextDesignerSchemas = { ...state.tableDesignerSchemaByConnection };
      delete nextDesignerSchemas[id];
      return {
        connections: nextConnections,
        connectionTags: normalized.connectionTags,
        recentConnectionTargets: state.recentConnectionTargets.filter(
          (target) => target.connectionId !== id,
        ),
        recentSQLFiles: state.recentSQLFiles.filter(
          (file) => file.connectionId !== id,
        ),
        tableAccessCount: removeConnectionTableAccessCounts(
          state.tableAccessCount,
          id,
          nextConnections.map((connection) => connection.id),
        ),
        tableDesignerSchemaByConnection: nextDesignerSchemas,
        sidebarRootOrder: normalized.sidebarRootOrder,
      };
    }),
  replaceConnections: (connections) =>
    set((state) => {
      const nextConnections = sanitizeConnections(connections);
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        nextConnections,
      );
      const validConnectionIds = new Set(nextConnections.map((connection) => connection.id));
      const nextDesignerSchemas = Object.fromEntries(
        Object.entries(state.tableDesignerSchemaByConnection)
          .filter(([connectionId]) => validConnectionIds.has(connectionId)),
      );
      return {
        connections: nextConnections,
        connectionTags: normalized.connectionTags,
        sidebarRootOrder: normalized.sidebarRootOrder,
        tableDesignerSchemaByConnection: nextDesignerSchemas,
        shortcutOptions:
          readPersistedShortcutOptions() ?? state.shortcutOptions,
      };
    }),
  replaceConnectionSidebarLayout: (layout) =>
    set((state) =>
      ({ ...normalizeConnectionTagTreeState(
        sanitizeConnectionTags(layout?.connectionTags),
        sanitizeSidebarRootOrder(layout?.sidebarRootOrder),
        state.connections,
      ),
      rootSortMode: 'manual',
      rootConnectionSortMode: layout?.rootConnectionSortMode === 'manual' || layout?.rootConnectionSortMode === 'name' || layout?.rootConnectionSortMode === 'createdAt'
        ? layout.rootConnectionSortMode
        : layout?.rootSortMode === 'name' || layout?.rootSortMode === 'createdAt'
          ? layout.rootSortMode
          : 'createdAt',
      }),
    ),

  setConnectionDisplaySortMode: (tagId, mode) =>
    set((state) => {
      const safeMode: ConnectionDisplaySortMode = mode === 'manual' || mode === 'name' ? mode : 'createdAt';
      if (safeMode === 'manual') {
        return materializeManualConnectionOrder(
          state.connectionTags,
          state.sidebarRootOrder,
          state.connections,
          state.rootConnectionSortMode,
          tagId,
        );
      }
      if (!tagId) return { rootConnectionSortMode: safeMode };
      return {
        connectionTags: state.connectionTags.map((tag) =>
          tag.id === tagId ? { ...tag, connectionSortMode: safeMode } : tag,
        ),
      };
    }),
  duplicateConnectionTag: (id) => {
    let duplicatedId: string | null = null;
    set((state) => {
      const source = state.connectionTags.find((tag) => tag.id === id);
      if (!source) return state;
      const descendants = new Set<string>();
      const collect = (parent: string) => state.connectionTags.forEach((tag) => {
        if (tag.parentTagId === parent && !descendants.has(tag.id)) {
          descendants.add(tag.id); collect(tag.id);
        }
      });
      collect(id);
      const oldIds = [id, ...descendants];
      const idMap = new Map(oldIds.map((oldId) => [oldId, `tag-${uuidv4()}`]));
      duplicatedId = idMap.get(id) || null;
      const copies = state.connectionTags.filter((tag) => oldIds.includes(tag.id)).map((tag) => ({
        ...tag,
        id: idMap.get(tag.id)!,
        name: `${tag.name} - Copy`,
        parentTagId: tag.parentTagId ? idMap.get(tag.parentTagId) : undefined,
        childOrder: tag.childOrder?.map((token) => token.startsWith('tag:')
          ? `tag:${idMap.get(token.slice(4)) || token.slice(4)}` : token),
        sortMode: tag.sortMode || 'manual',
        createdAt: Date.now(),
      }));
      const sourceParent = source.parentTagId;
      const sourceToken = buildSidebarRootTagToken(id);
      const newToken = buildSidebarRootTagToken(duplicatedId!);
      const nextTags = [...state.connectionTags, ...copies];
      if (!sourceParent) {
        const order = [...state.sidebarRootOrder];
        const index = order.indexOf(sourceToken);
        order.splice(index < 0 ? order.length : index + 1, 0, newToken);
        return { connectionTags: nextTags, sidebarRootOrder: order };
      }
      const parent = nextTags.find((tag) => tag.id === sourceParent);
      if (!parent) return { connectionTags: nextTags };
      const order = resolveConnectionTagChildOrder(sourceParent, nextTags);
      const index = order.indexOf(sourceToken);
      return { connectionTags: nextTags.map((tag) => tag.id === sourceParent
        ? { ...tag, childOrder: (() => { const next = [...order]; next.splice(index < 0 ? next.length : index + 1, 0, newToken); return next; })() }
        : tag) };
    });
    return duplicatedId;
  },
  moveConnectionsToTag: (ids, targetTagId) =>
    set((state) => {
      const selected = new Set(ids.filter((id) => state.connections.some((connection) => connection.id === id)));
      if (!selected.size || (targetTagId && !state.connectionTags.some((tag) => tag.id === targetTagId))) return state;
      let nextTags = state.connectionTags;
      let nextRootOrder = state.sidebarRootOrder;
      const connectionIDs = [...selected];
      if (!targetTagId) connectionIDs.reverse();
      connectionIDs.forEach((connectionId) => {
        const moved = moveConnectionInTree(
          nextTags,
          nextRootOrder,
          state.connections,
          connectionId,
          targetTagId,
        );
        if (moved) {
          nextTags = moved.connectionTags;
          nextRootOrder = moved.sidebarRootOrder;
        }
      });
      if (nextTags === state.connectionTags && nextRootOrder === state.sidebarRootOrder) {
        return state;
      }
      return { connectionTags: nextTags, sidebarRootOrder: nextRootOrder };
    }),

  addConnectionTag: (tag) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const tagId = toTrimmedString(tag.id);
      if (
        !tagId ||
        normalized.connectionTags.some((candidate) => candidate.id === tagId)
      ) {
        return normalized;
      }

      const parentTagId = toTrimmedString(tag.parentTagId) || undefined;
      const name = toTrimmedString(
        tag.name,
        indexedStoreFallback(
          "store.fallback.connection_tag_name",
          normalized.connectionTags.length,
        ),
      ) || indexedStoreFallback(
        "store.fallback.connection_tag_name",
        normalized.connectionTags.length,
      );
      if (normalized.connectionTags.some((candidate) =>
        candidate.parentTagId === parentTagId
        && candidate.name.trim().localeCompare(name.trim(), undefined, { sensitivity: "accent" }) === 0,
      )) {
        return normalized;
      }

      const directConnectionIds = sanitizeStringArray(tag.connectionIds, 256);
      const directConnectionTokens = new Set(
        directConnectionIds.map(buildSidebarRootConnectionToken),
      );
      const nextTags = normalizeConnectionTagTree([
        ...normalized.connectionTags.map((candidate) => ({
          ...candidate,
          connectionIds: candidate.connectionIds.filter(
            (connectionId) => !directConnectionIds.includes(connectionId),
          ),
          childOrder: sanitizeSidebarItemOrder(candidate.childOrder).filter(
            (token) => !directConnectionTokens.has(token),
          ),
        })),
        {
          id: tagId,
          name,
          createdAt: Number.isFinite(Number(tag.createdAt)) && Number(tag.createdAt) > 0
            ? Number(tag.createdAt)
            : Date.now(),
          parentTagId,
          connectionIds: directConnectionIds,
          childOrder: sanitizeSidebarItemOrder(tag.childOrder),
        },
      ]);
      const addedTag = nextTags.find((candidate) => candidate.id === tagId);
      const nextRootOrder = addedTag?.parentTagId
        ? normalized.sidebarRootOrder
        : insertSidebarRootTokenBeforeUngrouped(
            resolveSidebarRootOrderTokens(
              normalized.sidebarRootOrder,
              nextTags,
              state.connections,
            ).filter(
              (token) => token !== buildSidebarRootTagToken(tagId),
            ),
            buildSidebarRootTagToken(tagId),
          );
      return normalizeConnectionTagTreeState(
        nextTags,
        nextRootOrder,
        state.connections,
      );
    }),
  updateConnectionTag: (tag) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const existing = normalized.connectionTags.find(
        (candidate) => candidate.id === tag.id,
      );
      if (!existing) return normalized;

      const requestedConnectionIds = sanitizeStringArray(
        tag.connectionIds,
        256,
      );
      const requestedConnectionTokens = new Set(
        requestedConnectionIds.map(buildSidebarRootConnectionToken),
      );
      const hasRequestedParent = Object.prototype.hasOwnProperty.call(
        tag,
        "parentTagId",
      );
      const requestedParentTagId = hasRequestedParent
        ? toTrimmedString(tag.parentTagId) || undefined
        : existing.parentTagId;
      const requestedName = toTrimmedString(tag.name, existing.name) || existing.name;
      if (normalized.connectionTags.some((candidate) =>
        candidate.id !== tag.id
        && candidate.parentTagId === requestedParentTagId
        && candidate.name.trim().localeCompare(requestedName.trim(), undefined, { sensitivity: "accent" }) === 0,
      )) return normalized;
      const hasRequestedChildOrder = Object.prototype.hasOwnProperty.call(
        tag,
        "childOrder",
      );
      let nextTags: ConnectionTag[] = normalized.connectionTags.map((candidate) => {
        if (candidate.id === tag.id) {
          return {
            ...candidate,
            name: requestedName,
            connectionIds: requestedConnectionIds,
            childOrder: hasRequestedChildOrder
              ? sanitizeSidebarItemOrder(tag.childOrder)
              : candidate.childOrder,
          };
        }
        return {
          ...candidate,
          connectionIds: candidate.connectionIds.filter(
            (connectionId) => !requestedConnectionIds.includes(connectionId),
          ),
          childOrder: sanitizeSidebarItemOrder(candidate.childOrder).filter(
            (token) => !requestedConnectionTokens.has(token),
          ),
        };
      });
      nextTags = normalizeConnectionTagTree(nextTags);

      if (requestedParentTagId !== existing.parentTagId) {
        const moved = moveConnectionTagInTree(
          nextTags,
          normalized.sidebarRootOrder,
          state.connections,
          tag.id,
          requestedParentTagId ?? null,
        );
        if (moved) return moved;
      }
      return normalizeConnectionTagTreeState(
        nextTags,
        normalized.sidebarRootOrder,
        state.connections,
      );
    }),
  removeConnectionTag: (id) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const removedTag = normalized.connectionTags.find(
        (tag) => tag.id === id,
      );
      if (!removedTag) return normalized;

      const removedToken = buildSidebarRootTagToken(id);
      const promotedOrder = resolveConnectionTagChildOrder(
        id,
        normalized.connectionTags,
      );
      const parentTagId = removedTag.parentTagId;
      let nextTags: ConnectionTag[] = normalized.connectionTags
        .filter((tag) => tag.id !== id)
        .map((tag) => {
          const isDirectChild = tag.parentTagId === id;
          const isParent = parentTagId && tag.id === parentTagId;
          return {
            ...tag,
            parentTagId: isDirectChild ? parentTagId : tag.parentTagId,
            connectionIds: isParent
              ? [...tag.connectionIds, ...removedTag.connectionIds]
              : tag.connectionIds,
          };
        });
      let nextRootOrder = normalized.sidebarRootOrder;

      if (parentTagId) {
        const parentOrder = resolveConnectionTagChildOrder(
          parentTagId,
          normalized.connectionTags,
        );
        nextTags = setConnectionTagChildOrder(
          nextTags,
          parentTagId,
          replaceSidebarItemToken(
            parentOrder,
            removedToken,
            promotedOrder,
          ),
        );
      } else {
        nextRootOrder = replaceSidebarItemToken(
          normalized.sidebarRootOrder,
          removedToken,
          promotedOrder,
        );
      }

      return normalizeConnectionTagTreeState(
        nextTags,
        nextRootOrder,
        state.connections,
      );
    }),
  removeConnectionTagTree: (id) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const removedIds = new Set<string>();
      const pending = [id];
      while (pending.length) {
        const current = pending.pop();
        if (!current || removedIds.has(current)) continue;
        removedIds.add(current);
        normalized.connectionTags.forEach((tag) => {
          if (tag.parentTagId === current) pending.push(tag.id);
        });
      }
      if (!removedIds.size || !removedIds.has(id)) return normalized;
      const removedTokens = new Set([...removedIds].map(buildSidebarRootTagToken));
      return normalizeConnectionTagTreeState(
        normalized.connectionTags.filter((tag) => !removedIds.has(tag.id)),
        normalized.sidebarRootOrder.filter((token) => !removedTokens.has(token)),
        state.connections,
      );
    }),
  moveConnectionToTag: (
    connectionId,
    targetTagId,
    targetToken,
    insertBefore = false,
  ) =>
    set((state) => {
      const base = targetToken
        ? materializeManualConnectionOrder(
            state.connectionTags,
            state.sidebarRootOrder,
            state.connections,
            state.rootConnectionSortMode,
            targetTagId,
          )
        : {
            connectionTags: state.connectionTags,
            sidebarRootOrder: state.sidebarRootOrder,
            rootConnectionSortMode: state.rootConnectionSortMode,
          };
      const moved = moveConnectionInTree(
        base.connectionTags,
        base.sidebarRootOrder,
        state.connections,
        connectionId,
        targetTagId,
        targetToken,
        insertBefore,
      );
      if (!moved) return { connectionTags: state.connectionTags, sidebarRootOrder: state.sidebarRootOrder };
      if (!targetToken) return moved;
      return { ...moved, rootConnectionSortMode: base.rootConnectionSortMode };
    }),
  moveConnectionTag: (
    tagId,
    targetParentTagId,
    targetToken,
    insertBefore = false,
  ) =>
    set((state) => {
      const moved = moveConnectionTagInTree(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
        tagId,
        targetParentTagId,
        targetToken,
        insertBefore,
      );
      return moved || {
        connectionTags: state.connectionTags,
        sidebarRootOrder: state.sidebarRootOrder,
      };
    }),
  reorderConnections: (
    connectionId,
    targetConnectionId,
    targetTagId,
    insertBefore = false,
  ) =>
    set((state) => {
      const sortMode = targetTagId
        ? state.connectionTags.find((tag) => tag.id === targetTagId)?.sortMode || 'manual'
        : state.rootSortMode;
      if (sortMode !== 'manual') {
        return {
          connections: state.connections,
          connectionTags: state.connectionTags,
          sidebarRootOrder: state.sidebarRootOrder,
        };
      }
      if (
        !connectionId ||
        !targetConnectionId ||
        connectionId === targetConnectionId ||
        !state.connections.some(
          (connection) => connection.id === targetConnectionId,
        )
      ) {
        return {
          connections: state.connections,
          connectionTags: state.connectionTags,
        };
      }
      const moved = moveConnectionInTree(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
        connectionId,
        targetTagId,
        buildSidebarRootConnectionToken(targetConnectionId),
        insertBefore,
      );
      if (!moved) {
        return {
          connections: state.connections,
          connectionTags: state.connectionTags,
          sidebarRootOrder: state.sidebarRootOrder,
        };
      }
      const nextConnections = targetTagId
        ? state.connections
        : orderUngroupedConnectionsBySidebarRootOrder(
            state.connections,
            moved.connectionTags,
            moved.sidebarRootOrder,
          );
      return {
        connections: nextConnections,
        connectionTags: moved.connectionTags,
        sidebarRootOrder: resolveSidebarRootOrderTokens(
          moved.sidebarRootOrder,
          moved.connectionTags,
          nextConnections,
        ),
      };
    }),
  reorderTags: (tagIds) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const rootTagIds = new Set(
        normalized.connectionTags
          .filter((tag) => !tag.parentTagId)
          .map((tag) => tag.id),
      );
      const requestedTagTokens = Array.from(
        new Set(
          tagIds
            .filter((id) => rootTagIds.has(id))
            .map(buildSidebarRootTagToken),
        ),
      );
      const orderedRootOrder = [
        ...requestedTagTokens,
        ...normalized.sidebarRootOrder.filter(
          (token) =>
            isSidebarRootTagToken(token) &&
            !requestedTagTokens.includes(token),
        ),
        ...normalized.sidebarRootOrder.filter(
          (token) => !isSidebarRootTagToken(token),
        ),
      ];
      return normalizeConnectionTagTreeState(
        normalized.connectionTags,
        orderedRootOrder,
        state.connections,
      );
    }),
  reorderSidebarRoot: (sourceToken, targetToken, insertBefore) =>
    set((state) => {
      const normalized = normalizeConnectionTagTreeState(
        state.connectionTags,
        state.sidebarRootOrder,
        state.connections,
      );
      const nextRootOrder = moveSidebarRootToken(
        normalized.sidebarRootOrder,
        sourceToken,
        targetToken,
        insertBefore,
      );
      return normalizeConnectionTagTreeState(
        normalized.connectionTags,
        nextRootOrder,
        state.connections,
      );
    }),
});
