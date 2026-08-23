import type {
  ExternalSQLDirectory,
  ExternalSQLFileBinding,
  ExternalSQLTreeEntry,
} from '../types';

export type ExternalSQLNodeType =
  | 'external-sql-root'
  | 'external-sql-directory'
  | 'external-sql-folder'
  | 'external-sql-file';

export interface ExternalSQLTreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: ExternalSQLTreeNode[];
  type: ExternalSQLNodeType;
  dataRef: Record<string, unknown>;
}

type BuildExternalSQLRootNodeParams = {
  dbNodeKey?: string;
  connectionId?: string;
  dbName?: string;
  directories: ExternalSQLDirectory[];
  directoryTrees: Record<string, ExternalSQLTreeEntry[]>;
  directoryStatuses?: Record<string, 'missing'>;
  labels?: Partial<ExternalSQLTreeLabels>;
};

export type ExternalSQLTreeLabels = {
  root: string;
  directoryFallback: string;
  missingDirectory: string;
};

export const normalizeExternalSQLPath = (value: string): string =>
  String(value || '').trim().replace(/\\/g, '/');

export const findExternalSQLFileBinding = (
  bindings: ExternalSQLFileBinding[] | undefined,
  filePath: string,
): ExternalSQLFileBinding | undefined => {
  const normalizedFilePath = normalizeExternalSQLPath(filePath);
  if (!normalizedFilePath) return undefined;
  return bindings?.find(
    (binding) => normalizeExternalSQLPath(binding.filePath) === normalizedFilePath,
  );
};

export const resolveExternalSQLFileBinding = (
  directories: ExternalSQLDirectory[],
  filePath: string,
  preferredContext?: { connectionId?: string; dbName?: string },
): { connectionId: string; dbName: string; hasExplicitBinding: boolean } | undefined => {
  const normalizedFilePath = normalizeExternalSQLPath(filePath);
  if (!normalizedFilePath) return undefined;
  const matchingDirectories = [...directories]
    .filter((directory) => {
      const rawDirectoryPath = normalizeExternalSQLPath(directory.path);
      const directoryPath = rawDirectoryPath === '/' ? '/' : rawDirectoryPath.replace(/\/+$/u, '');
      return Boolean(directoryPath) && (
        directoryPath === '/'
          ? normalizedFilePath.startsWith('/')
          : normalizedFilePath === directoryPath || normalizedFilePath.startsWith(`${directoryPath}/`)
      );
    })
    .sort((left, right) => (
      normalizeExternalSQLPath(right.path).length - normalizeExternalSQLPath(left.path).length
    ));
  const preferredConnectionId = String(preferredContext?.connectionId || '').trim();
  const preferredDbName = String(preferredContext?.dbName || '').trim();
  const preferredDirectory = preferredConnectionId
    ? matchingDirectories.find((directory) => (
        String(directory.connectionId || '').trim() === preferredConnectionId
        && (!preferredDbName || String(directory.dbName || '').trim() === preferredDbName)
      ))
    : undefined;
  if (preferredDirectory) {
    const binding = findExternalSQLFileBinding(preferredDirectory.fileBindings, normalizedFilePath);
    return binding
      ? {
          connectionId: String(binding.connectionId || '').trim(),
          dbName: String(binding.dbName || '').trim(),
          hasExplicitBinding: true,
        }
      : undefined;
  }
  for (const directory of matchingDirectories) {
    const binding = findExternalSQLFileBinding(directory.fileBindings, normalizedFilePath);
    if (binding) {
      return {
        connectionId: String(binding.connectionId || '').trim(),
        dbName: String(binding.dbName || '').trim(),
        hasExplicitBinding: true,
      };
    }
  }
  return undefined;
};

export const findExternalSQLDirectoriesByPath = (
  directories: ExternalSQLDirectory[],
  directoryPath: string,
): ExternalSQLDirectory[] => {
  const normalizedDirectoryPath = normalizeExternalSQLPath(directoryPath);
  if (!normalizedDirectoryPath) return [];
  return directories.filter(
    (directory) => normalizeExternalSQLPath(directory.path) === normalizedDirectoryPath,
  );
};

export const setExternalSQLFileBinding = (
  directory: ExternalSQLDirectory,
  filePath: string,
  target?: { connectionId: string; dbName: string } | null,
): ExternalSQLDirectory => {
  const normalizedFilePath = normalizeExternalSQLPath(filePath);
  if (!normalizedFilePath) return directory;
  const remainingBindings = (directory.fileBindings || []).filter(
    (binding) => normalizeExternalSQLPath(binding.filePath) !== normalizedFilePath,
  );
  const connectionId = String(target?.connectionId || '').trim();
  const dbName = String(target?.dbName || '').trim();
  // A file may deliberately use a connection without selecting a default
  // database (for example CREATE DATABASE scripts). Keep that explicit empty
  // value so it does not fall back to the directory's default database.
  const fileBindings = connectionId
    ? [...remainingBindings, { filePath: normalizedFilePath, connectionId, dbName }]
    : remainingBindings;
  const nextDirectory = { ...directory };
  if (fileBindings.length > 0) {
    nextDirectory.fileBindings = fileBindings;
  } else {
    delete nextDirectory.fileBindings;
  }
  return nextDirectory;
};

const isPathEqualOrInside = (path: string, parentPath: string): boolean => (
  path === parentPath
  || (parentPath === '/' ? path.startsWith('/') : path.startsWith(`${parentPath}/`))
);

export const moveExternalSQLFileBindings = (
  directory: ExternalSQLDirectory,
  previousPath: string,
  nextPath: string,
): ExternalSQLDirectory => {
  const normalizedPreviousPath = normalizeExternalSQLPath(previousPath);
  const normalizedNextPath = normalizeExternalSQLPath(nextPath);
  if (!normalizedPreviousPath || !normalizedNextPath || !directory.fileBindings?.length) {
    return directory;
  }
  let changed = false;
  const fileBindings = directory.fileBindings.map((binding) => {
      const normalizedBindingPath = normalizeExternalSQLPath(binding.filePath);
      if (!isPathEqualOrInside(normalizedBindingPath, normalizedPreviousPath)) {
        return binding;
      }
      changed = true;
      return {
        ...binding,
        filePath: `${normalizedNextPath}${normalizedBindingPath.slice(normalizedPreviousPath.length)}`,
      };
  });
  return changed ? { ...directory, fileBindings } : directory;
};

export const removeExternalSQLFileBindings = (
  directory: ExternalSQLDirectory,
  targetPath: string,
): ExternalSQLDirectory => {
  const normalizedTargetPath = normalizeExternalSQLPath(targetPath);
  if (!normalizedTargetPath || !directory.fileBindings?.length) return directory;
  const fileBindings = directory.fileBindings.filter((binding) => (
    !isPathEqualOrInside(normalizeExternalSQLPath(binding.filePath), normalizedTargetPath)
  ));
  if (fileBindings.length === directory.fileBindings.length) return directory;
  const nextDirectory = { ...directory };
  if (fileBindings.length > 0) {
    nextDirectory.fileBindings = fileBindings;
  } else {
    delete nextDirectory.fileBindings;
  }
  return nextDirectory;
};

const DEFAULT_EXTERNAL_SQL_TREE_LABELS: ExternalSQLTreeLabels = {
  root: 'External SQL files',
  directoryFallback: 'SQL directory',
  missingDirectory: 'Missing',
};

const resolveExternalSQLTreeLabels = (labels?: Partial<ExternalSQLTreeLabels>): ExternalSQLTreeLabels => ({
  root: String(labels?.root || '').trim() || DEFAULT_EXTERNAL_SQL_TREE_LABELS.root,
  directoryFallback:
    String(labels?.directoryFallback || '').trim() || DEFAULT_EXTERNAL_SQL_TREE_LABELS.directoryFallback,
  missingDirectory:
    String(labels?.missingDirectory || '').trim() || DEFAULT_EXTERNAL_SQL_TREE_LABELS.missingDirectory,
});

const resolveDirectoryDisplayName = (
  directory: ExternalSQLDirectory,
  labels: ExternalSQLTreeLabels,
): string => {
  const explicitName = String(directory.name || '').trim();
  if (explicitName) return explicitName;
  const normalizedPath = normalizeExternalSQLPath(directory.path);
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || labels.directoryFallback;
};

export const buildExternalSQLDirectoryId = (
  connectionId: string,
  dbName: string,
  directoryPath: string,
): string => {
  const normalizedConnectionId = String(connectionId || '').trim();
  const normalizedDbName = String(dbName || '').trim();
  const normalizedDirectoryPath = normalizeExternalSQLPath(directoryPath);
  return [
    'external-sql-dir',
    normalizedConnectionId,
    normalizedDbName,
    normalizedDirectoryPath,
  ].map(encodeURIComponent).join(':');
};

export const buildExternalSQLTabId = (connectionId: string, dbName: string, filePath: string): string =>
  `external-sql-tab:${String(connectionId || '').trim()}:${String(dbName || '').trim()}:${normalizeExternalSQLPath(filePath)}`;

const buildExternalSQLNodeKey = (
  type: ExternalSQLNodeType,
  base: string,
  directoryId?: string,
): string => `${type}:${directoryId ? `${directoryId}:` : ''}${normalizeExternalSQLPath(base)}`;

const isExternalSQLFileEntry = (entry: ExternalSQLTreeEntry): boolean => {
  const name = String(entry.name || '').trim();
  const path = normalizeExternalSQLPath(entry.path);
  return /\.sql$/i.test(name) || /\.sql$/i.test(path);
};

const mapExternalSQLTreeEntries = (
  entries: ExternalSQLTreeEntry[],
  context: {
    connectionId: string;
    dbName: string;
    dbNodeKey: string;
    directoryId: string;
    fileBindings?: ExternalSQLFileBinding[];
  },
): ExternalSQLTreeNode[] => entries.flatMap((entry): ExternalSQLTreeNode[] => {
  const entryPath = normalizeExternalSQLPath(entry.path);
  if (entry.isDir) {
    const children = mapExternalSQLTreeEntries(entry.children || [], context);
    return [{
      title: entry.name,
      key: buildExternalSQLNodeKey('external-sql-folder', entryPath, context.directoryId),
      type: 'external-sql-folder',
      isLeaf: children.length === 0,
      children: children.length > 0 ? children : undefined,
      dataRef: {
        connectionId: context.connectionId,
        dbName: context.dbName,
        dbNodeKey: context.dbNodeKey,
        directoryId: context.directoryId,
        path: entry.path,
        name: entry.name,
      },
    }];
  }

  if (!isExternalSQLFileEntry(entry)) {
    return [];
  }

  const fileBinding = findExternalSQLFileBinding(context.fileBindings, entry.path);
  const connectionId = fileBinding
    ? String(fileBinding.connectionId || '').trim()
    : context.connectionId;
  const dbName = fileBinding
    ? String(fileBinding.dbName || '').trim()
    : context.dbName;

  return [{
    title: entry.name,
    key: buildExternalSQLNodeKey('external-sql-file', entryPath, context.directoryId),
    type: 'external-sql-file',
    isLeaf: true,
    dataRef: {
      connectionId,
      dbName,
      ...(fileBinding ? {
        directoryConnectionId: context.connectionId,
        directoryDbName: context.dbName,
        hasExplicitBinding: true,
      } : {}),
      dbNodeKey: context.dbNodeKey,
      directoryId: context.directoryId,
      path: entry.path,
      name: entry.name,
    },
  }];
});

export const buildExternalSQLRootNode = ({
  dbNodeKey = 'external-sql-root',
  connectionId = '',
  dbName = '',
  directories,
  directoryTrees,
  directoryStatuses = {},
  labels,
}: BuildExternalSQLRootNodeParams): ExternalSQLTreeNode => {
  const resolvedLabels = resolveExternalSQLTreeLabels(labels);
  const sortedDirectories = [...directories].sort((left, right) =>
    resolveDirectoryDisplayName(left, resolvedLabels)
      .toLowerCase()
      .localeCompare(resolveDirectoryDisplayName(right, resolvedLabels).toLowerCase()),
  );

  const children = sortedDirectories.map((directory) => {
    // Global root can carry a fallback context, but an explicitly bound directory
    // must retain its own target so every nested SQL file opens against that DB.
    const directoryConnectionId = String(directory.connectionId || '').trim() || connectionId;
    const directoryDbName = String(directory.dbName || '').trim() || dbName;
    const directoryStatus = directoryStatuses[directory.id];
    const directoryChildren = mapExternalSQLTreeEntries(directoryTrees[directory.id] || [], {
      connectionId: directoryConnectionId,
      dbName: directoryDbName,
      dbNodeKey,
      directoryId: directory.id,
      fileBindings: directory.fileBindings,
    });
    const directoryTitle = resolveDirectoryDisplayName(directory, resolvedLabels);
    return {
      title: directoryStatus === 'missing'
        ? `${directoryTitle} (${resolvedLabels.missingDirectory})`
        : directoryTitle,
      key: buildExternalSQLNodeKey('external-sql-directory', directory.id),
      type: 'external-sql-directory' as const,
      isLeaf: directoryChildren.length === 0,
      children: directoryChildren.length > 0 ? directoryChildren : undefined,
      dataRef: {
        ...directory,
        ...(directoryStatus ? { directoryStatus } : {}),
        connectionId: directoryConnectionId,
        dbName: directoryDbName,
        dbNodeKey,
      },
    };
  });

  return {
    title: children.length > 0 ? `${resolvedLabels.root} (${children.length})` : resolvedLabels.root,
    key: dbNodeKey === 'external-sql-root' ? 'external-sql-root' : `${dbNodeKey}-external-sql`,
    type: 'external-sql-root',
    isLeaf: children.length === 0,
    children: children.length > 0 ? children : undefined,
    dataRef: {
      connectionId,
      dbName,
      dbNodeKey,
    },
  };
};
