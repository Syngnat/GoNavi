import {
  sanitizeSavedQueries,
  getSavedQueryGroupsFromBackend,
  saveSavedQueryGroupToBackend,
  deleteSavedQueryGroupFromBackend,
  moveSavedQueryToGroupInBackend,
  moveSavedQueryGroupInBackend,
  saveSavedQueryToBackend,
  deleteSavedQueryFromBackend,
} from "../utils/savedQueryPersistence";
import { normalizeSavedQueryGroups } from "../utils/savedQueryGroups";
import { resolveSavedQueryBackend, toTrimmedString } from "./storeConnectionSanitizers";
import {
  sanitizeExternalSQLFileBindings,
  resolveExternalSQLDirectoryName,
  normalizeRecentSQLPath,
  sanitizeRecentSQLFiles,
  resolveRecentSQLFileName,
  isRecentSQLPathInDirectory,
  relocateRecentSQLFilePath,
} from "./storeWorkbenchSanitizers";
import { ExternalSQLDirectory } from "../types";
import { buildExternalSQLDirectoryId } from "../utils/externalSqlTree";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type SavedQuerySliceState = Pick<AppState, 
  | 'replaceSavedQueries'
  | 'replaceSavedQueryGroups'
  | 'reloadSavedQueryGroups'
  | 'saveSavedQueryGroup'
  | 'deleteSavedQueryGroup'
  | 'moveSavedQueryToGroup'
  | 'moveSavedQueryGroup'
  | 'saveQuery'
  | 'deleteQuery'
  | 'saveExternalSQLDirectory'
  | 'deleteExternalSQLDirectory'
  | 'updateRecentSQLFilePath'
  | 'removeRecentSQLFilesByPath'
  | 'moveRecentSQLFilesByDirectory'
  | 'removeRecentSQLFilesByDirectory'
>;

export const createSavedQuerySlice = (set: StoreSet, get: StoreGet): SavedQuerySliceState => ({
  replaceSavedQueries: (queries) =>
    set({ savedQueries: sanitizeSavedQueries(queries) }),

  replaceSavedQueryGroups: (groups) =>
    set((state) => ({
      savedQueryGroups: normalizeSavedQueryGroups(
        groups,
        state.savedQueries.map((query) => query.id),
      ),
    })),

  reloadSavedQueryGroups: async () => {
    const groups = await getSavedQueryGroupsFromBackend(
      resolveSavedQueryBackend(),
    );
    const normalized = normalizeSavedQueryGroups(
      groups,
      get().savedQueries.map((query) => query.id),
    );
    set({ savedQueryGroups: normalized });
    return normalized;
  },

  saveSavedQueryGroup: async (group) => {
    const saved = await saveSavedQueryGroupToBackend(
      resolveSavedQueryBackend(),
      group,
    );
    // The backend normalizes ownership and mixed child order. Reload after
    // every write rather than applying an optimistic local patch.
    await get().reloadSavedQueryGroups();
    return saved;
  },

  deleteSavedQueryGroup: async (id) => {
    await deleteSavedQueryGroupFromBackend(resolveSavedQueryBackend(), id);
    await get().reloadSavedQueryGroups();
  },

  moveSavedQueryToGroup: async (queryId, groupId) => {
    await moveSavedQueryToGroupInBackend(
      resolveSavedQueryBackend(),
      queryId,
      groupId,
    );
    await get().reloadSavedQueryGroups();
  },

  moveSavedQueryGroup: async (groupId, parentGroupId) => {
    await moveSavedQueryGroupInBackend(
      resolveSavedQueryBackend(),
      groupId,
      parentGroupId,
    );
    await get().reloadSavedQueryGroups();
  },

  saveQuery: async (query) => {
    const saved = await saveSavedQueryToBackend(
      resolveSavedQueryBackend(),
      query,
    );
    set((state) => {
      const existing = state.savedQueries.find((q) => q.id === saved.id);
      if (existing) {
        return {
          savedQueries: state.savedQueries.map((q) =>
            q.id === saved.id ? saved : q,
          ),
        };
      }
      return { savedQueries: [...state.savedQueries, saved] };
    });
    return saved;
  },

  deleteQuery: async (id) => {
    await deleteSavedQueryFromBackend(resolveSavedQueryBackend(), id);
    const groups = await getSavedQueryGroupsFromBackend(
      resolveSavedQueryBackend(),
    );
    set((state) => ({
      savedQueries: state.savedQueries.filter((q) => q.id !== id),
      savedQueryGroups: normalizeSavedQueryGroups(
        groups,
        state.savedQueries
          .filter((query) => query.id !== id)
          .map((query) => query.id),
      ),
    }));
  },

  saveExternalSQLDirectory: (directory) =>
    set((state) => {
      const path = toTrimmedString(directory.path);
      if (!path) {
        return state;
      }
      const connectionId = toTrimmedString(directory.connectionId);
      const dbName = toTrimmedString(directory.dbName);
      const fileBindings = sanitizeExternalSQLFileBindings(directory.fileBindings);
      const nextDirectory: ExternalSQLDirectory = {
        id:
          toTrimmedString(
            directory.id,
            buildExternalSQLDirectoryId(connectionId, dbName, path),
          ) || buildExternalSQLDirectoryId(connectionId, dbName, path),
        name: resolveExternalSQLDirectoryName(directory.name, path),
        path,
        ...(connectionId ? { connectionId } : {}),
        ...(dbName ? { dbName } : {}),
        ...(fileBindings.length > 0 ? { fileBindings } : {}),
        createdAt: Number.isFinite(Number(directory.createdAt))
          ? Number(directory.createdAt)
          : Date.now(),
      };
      const existingIndex = state.externalSQLDirectories.findIndex(
        (item) => item.id === nextDirectory.id,
      );
      if (existingIndex === -1) {
        return {
          externalSQLDirectories: [
            ...state.externalSQLDirectories,
            nextDirectory,
          ],
        };
      }
      return {
        externalSQLDirectories: state.externalSQLDirectories.map(
          (item, index) => (index === existingIndex ? nextDirectory : item),
        ),
      };
    }),

  deleteExternalSQLDirectory: (id) =>
    set((state) => ({
      externalSQLDirectories: state.externalSQLDirectories.filter(
        (item) => item.id !== id,
      ),
    })),

  updateRecentSQLFilePath: (previousPath, nextPath) =>
    set((state) => {
      const previousKey = normalizeRecentSQLPath(previousPath);
      const normalizedNextPath = toTrimmedString(nextPath);
      if (!previousKey || !normalizedNextPath) return state;
      return {
        recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles.map((file) => (
          normalizeRecentSQLPath(file.filePath) === previousKey
            ? {
                ...file,
                filePath: normalizedNextPath,
                fileName: resolveRecentSQLFileName(normalizedNextPath, undefined),
              }
            : file
        ))),
      };
    }),

  removeRecentSQLFilesByPath: (filePath) =>
    set((state) => {
      const pathKey = normalizeRecentSQLPath(filePath);
      if (!pathKey) return state;
      return {
        recentSQLFiles: state.recentSQLFiles.filter(
          (file) => normalizeRecentSQLPath(file.filePath) !== pathKey,
        ),
      };
    }),

  moveRecentSQLFilesByDirectory: (previousDirectoryPath, nextDirectoryPath) =>
    set((state) => {
      const previousPath = normalizeRecentSQLPath(previousDirectoryPath);
      const nextPath = normalizeRecentSQLPath(nextDirectoryPath);
      if (!previousPath || !nextPath) return state;
      return {
        recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles.map((file) => {
          if (!isRecentSQLPathInDirectory(file.filePath, previousPath)) return file;
          const filePath = relocateRecentSQLFilePath(
            file.filePath,
            previousDirectoryPath,
            nextDirectoryPath,
          );
          return {
            ...file,
            filePath,
            fileName: resolveRecentSQLFileName(filePath, undefined),
          };
        })),
      };
    }),

  removeRecentSQLFilesByDirectory: (directoryPath) =>
    set((state) => ({
      recentSQLFiles: state.recentSQLFiles.filter(
        (file) => !isRecentSQLPathInDirectory(file.filePath, directoryPath),
      ),
    })),
});
