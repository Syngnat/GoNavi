import type { ExternalSQLDirectory, SavedConnection, TabData } from '../../types';
import { resolveExternalSQLFileBinding } from '../../utils/externalSqlTree';
import {
  findBestMatchingExternalSQLDirectory,
  normalizeExternalSQLPath,
} from './aiExternalSqlPathUtils';

const normalizePreviewCharLimit = (input: unknown): number => {
  const value = Math.floor(Number(input) || 12000);
  if (value < 1) return 1;
  if (value > 40000) return 40000;
  return value;
};

const normalizeFileReadPayload = (
  readResult: unknown,
): {
  content: string;
  filePath: string;
  name: string;
  isLargeFile: boolean;
  fileSize: number;
  fileSizeMB: string;
} => {
  if (typeof readResult === 'string') {
    return {
      content: readResult,
      filePath: '',
      name: '',
      isLargeFile: false,
      fileSize: 0,
      fileSizeMB: '',
    };
  }
  if (!readResult || typeof readResult !== 'object') {
    return {
      content: '',
      filePath: '',
      name: '',
      isLargeFile: false,
      fileSize: 0,
      fileSizeMB: '',
    };
  }
  const payload = readResult as Record<string, unknown>;
  return {
    content: typeof payload.content === 'string' ? payload.content : '',
    filePath: String(payload.filePath || '').trim(),
    name: String(payload.name || '').trim(),
    isLargeFile: payload.isLargeFile === true,
    fileSize: Number(payload.fileSize || 0),
    fileSizeMB: String(payload.fileSizeMB || '').trim(),
  };
};

export const buildExternalSQLFileSnapshot = (params: {
  filePath: unknown;
  previewCharLimit?: unknown;
  readResult?: unknown;
  externalSQLDirectories?: ExternalSQLDirectory[];
  connections: SavedConnection[];
  tabs?: TabData[];
}) => {
  const {
    filePath,
    previewCharLimit,
    readResult,
    externalSQLDirectories = [],
    connections,
    tabs = [],
  } = params;

  const requestedFilePath = normalizeExternalSQLPath(filePath);
  const payload = normalizeFileReadPayload(readResult);
  const resolvedFilePath = normalizeExternalSQLPath(payload.filePath || requestedFilePath);
  const matchedDirectory = findBestMatchingExternalSQLDirectory(resolvedFilePath, externalSQLDirectories);
  const fileBinding = resolveExternalSQLFileBinding(
    externalSQLDirectories,
    resolvedFilePath,
    matchedDirectory
      ? { connectionId: matchedDirectory.connectionId, dbName: matchedDirectory.dbName }
      : undefined,
  );
  const effectiveConnectionId = fileBinding
    ? fileBinding.connectionId
    : matchedDirectory?.connectionId || '';
  const matchedConnection = connections.find((item) => item.id === effectiveConnectionId);
  const matchingTabs = tabs.filter(
    (tab) => normalizeExternalSQLPath(tab.filePath || '').toLowerCase() === resolvedFilePath.toLowerCase(),
  );
  const previewLimit = normalizePreviewCharLimit(previewCharLimit);
  const previewContent = payload.content.slice(0, previewLimit);
  const inferredName = payload.name || resolvedFilePath.split('/').filter(Boolean).pop() || '';

  return {
    requestedFilePath,
    resolvedFilePath,
    fileName: inferredName,
    previewCharLimit: previewLimit,
    hasMatchedDirectory: Boolean(matchedDirectory),
    directory: matchedDirectory ? {
      id: matchedDirectory.id,
      name: matchedDirectory.name,
      path: matchedDirectory.path,
      connectionId: effectiveConnectionId,
      connectionName: matchedConnection?.name || '',
      connectionType: matchedConnection?.config?.type || '',
      dbName: fileBinding ? fileBinding.dbName : matchedDirectory.dbName || '',
      ...(fileBinding ? { bindingSource: 'file' } : {}),
    } : null,
    hasOpenTab: matchingTabs.length > 0,
    openTabCount: matchingTabs.length,
    openTabs: matchingTabs.slice(0, 5).map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      dbName: tab.dbName || '',
      connectionId: tab.connectionId || '',
      isActiveFileTab: true,
    })),
    isLargeFile: payload.isLargeFile,
    fileSize: payload.fileSize,
    fileSizeMB: payload.fileSizeMB,
    hasContentPreview: previewContent.length > 0,
    truncated: payload.content.length > previewContent.length,
    contentPreview: previewContent,
    contentLength: payload.content.length,
  };
};
