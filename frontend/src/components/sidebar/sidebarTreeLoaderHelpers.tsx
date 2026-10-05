import React from 'react';
import { LinkOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import { GnFolderOpenIcon } from '../icons/gnIcons';
import type {
  SidebarMessageObjectKind,
  SidebarMessageQueueProfile,
} from './sidebarMessageProfiles';
import {
  getSidebarTableName,
  parseMetadataRowCount,
  getCaseInsensitiveValue,
} from './sidebarMetadataLoaders';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import type { SidebarTableMetadataSnapshot } from '../../utils/sidebarTableMetadata';

export type DriverStatusSnapshot = {
  type: string;
  name: string;
  connectable: boolean;
  expectedRevision?: string;
  needsUpdate?: boolean;
  updateReason?: string;
  message?: string;
};

export type SidebarLoadedTableMetadata = SidebarTableMetadataSnapshot & {
  schemaName?: string;
  partitionParentTableName?: string;
};

export type SidebarLoadedTableEntry = {
  tableName: string;
  schemaName: string;
  displayName: string;
  rowCount?: number;
  tableSize?: number;
  createdAt?: string;
  updatedAt?: string;
  tableComment?: string;
  partitionParentTableName?: string;
  partitionTables?: SidebarLoadedTableEntry[];
};

export const applyRefreshedSQLiteStatsToTree = (
  nodes: TreeNode[],
  rows: Record<string, any>[],
): TreeNode[] => {
  const statsByTable = new Map<string, { rowCount?: number; tableSize?: number }>();
  rows.forEach((row) => {
    const tableName = getSidebarTableName(row).trim().toLowerCase();
    if (!tableName) return;
    const rowCount = parseMetadataRowCount(row);
    const rawTableSize = getCaseInsensitiveValue(row, ['Data_length', 'data_length', 'DATA_LENGTH']);
    const parsedTableSize = rawTableSize === undefined || rawTableSize === null || rawTableSize === ''
      ? undefined
      : Number(rawTableSize);
    statsByTable.set(tableName, {
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(parsedTableSize !== undefined && Number.isFinite(parsedTableSize) ? { tableSize: parsedTableSize } : {}),
    });
  });

  const updateNode = (node: TreeNode): TreeNode => {
    const dataRef = node.dataRef as Record<string, any> | undefined;
    const tableName = String(dataRef?.tableName || '').trim().toLowerCase();
    const stat = tableName ? statsByTable.get(tableName) : undefined;
    const children = Array.isArray(node.children) ? node.children.map(updateNode) : node.children;
    return {
      ...node,
      ...(stat && dataRef ? {
        dataRef: {
          ...dataRef,
          ...(stat.rowCount !== undefined ? { rowCount: stat.rowCount } : {}),
          ...(stat.tableSize !== undefined ? { tableSize: stat.tableSize } : {}),
        },
      } : {}),
      ...(children ? { children } : {}),
    };
  };

  return nodes.map(updateNode);
};

export type SidebarTreeLoadOptions = {
  ensureFresh?: boolean;
};

export type TrackedSidebarLoad = {
  promise: Promise<void>;
  signature?: string;
};

export const scheduleSidebarLoad = (
  activeLoads: Map<string, TrackedSidebarLoad>,
  loadKey: string,
  run: () => Promise<void>,
  options: SidebarTreeLoadOptions,
  signature?: string,
): Promise<void> => {
  const activeLoad = activeLoads.get(loadKey);
  const hasDifferentSignature =
    signature !== undefined
    && activeLoad?.signature !== undefined
    && activeLoad.signature !== signature;
  const shouldStartConcurrent = hasDifferentSignature && !options.ensureFresh;

  if (activeLoad && !shouldStartConcurrent) {
    if (!options.ensureFresh) {
      return Promise.resolve();
    }

    let queuedLoad!: Promise<void>;
    queuedLoad = activeLoad.promise
      .catch(() => undefined)
      .then(run)
      .finally(() => {
        if (activeLoads.get(loadKey)?.promise === queuedLoad) {
          activeLoads.delete(loadKey);
        }
      });
    activeLoads.set(loadKey, { promise: queuedLoad, signature });
    return queuedLoad;
  }

  let currentLoad!: Promise<void>;
  currentLoad = run().finally(() => {
    if (activeLoads.get(loadKey)?.promise === currentLoad) {
      activeLoads.delete(loadKey);
    }
  });
  activeLoads.set(loadKey, { promise: currentLoad, signature });
  return currentLoad;
};

export const formatSidebarDriverAgentUpdateWarning = (
  driverName: string,
  status: Pick<DriverStatusSnapshot, 'message' | 'updateReason'>,
): string => {
  const rawMessage = String(status.message || '').trim();
  if (rawMessage) {
    return rawMessage;
  }
  const rawUpdateReason = String(status.updateReason || '').trim();
  if (rawUpdateReason) {
    return rawUpdateReason;
  }
  return t('connection.modal.driver.updateFallback', { name: driverName });
};

export const buildConnectionReloadSignature = (conn?: SavedConnection | null): string => {
  if (!conn) return '';
  return JSON.stringify({
    config: conn.config || {},
    includeDatabases: conn.includeDatabases || [],
    includeDatabasePatterns: conn.includeDatabasePatterns || [],
    excludeDatabasePatterns: conn.excludeDatabasePatterns || [],
    includeRedisDatabases: conn.includeRedisDatabases || [],
    schemaVisibilityByDatabase: conn.schemaVisibilityByDatabase || {},
  });
};

const isConnectionTreeKey = (key: React.Key, connectionId: string): boolean => {
  const text = String(key);
  return text === connectionId || text.startsWith(`${connectionId}-`);
};

export const DRIVER_STATUS_CACHE_TTL_MS = 30_000;

export const normalizeDriverType = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'postgresql' || normalized === 'pg' || normalized === 'pq' || normalized === 'pgx') return 'postgres';
  if (normalized === 'doris') return 'diros';
  if (
    normalized === 'open_gauss' ||
    normalized === 'open-gauss' ||
    normalized === 'opengauss'
  ) return 'opengauss';
  if (
    normalized === 'intersystems' ||
    normalized === 'intersystemsiris' ||
    normalized === 'inter-systems' ||
    normalized === 'inter-systems-iris'
  ) return 'iris';
  if (
    normalized === 'caché' ||
    normalized === 'intersystems cache' ||
    normalized === 'intersystems caché' ||
    normalized === 'intersystems-cache' ||
    normalized === 'intersystems-caché' ||
    normalized === 'intersystemscache' ||
    normalized === 'intersystemscaché' ||
    normalized === 'inter-systems-cache' ||
    normalized === 'inter-systems-caché' ||
    normalized === 'intersystems-cache-database' ||
    normalized === 'cache-db' ||
    normalized === 'cachedb'
  ) return 'cache';
  return normalized;
};

export const resolveSavedConnectionDriverType = (conn: SavedConnection | undefined): string => {
  const type = normalizeDriverType(conn?.config?.type || '');
  if (type !== 'custom') {
    return type;
  }
  return normalizeDriverType(conn?.config?.driver || '');
};

const sidebarMessageObjectIcon = (kind: SidebarMessageObjectKind): React.ReactNode => (
  kind === 'exchange' ? <LinkOutlined /> : <UnorderedListOutlined />
);

export const buildSidebarMessageObjectNodes = (
  profile: SidebarMessageQueueProfile,
  conn: SavedConnection & { dbName?: string },
  parentKey: string,
  rows: Record<string, any>[],
): TreeNode[] => {
  const seenIdentities = new Set<string>();
  const nodes = rows.flatMap((row): TreeNode[] => {
    const name = String(row.name ?? row.Name ?? row.objectName ?? row.ObjectName ?? '').trim();
    const rawType = String(row.type ?? row.Type ?? row.objectType ?? row.ObjectType ?? '').trim();
    const kind = profile.resolveObjectKind(rawType);
    if (!name || !kind) return [];
    const identity = JSON.stringify([kind, name]);
    if (seenIdentities.has(identity)) return [];
    seenIdentities.add(identity);
    return [{
      title: name,
      key: `${parentKey}-message-${kind}-${encodeURIComponent(name)}`,
      icon: sidebarMessageObjectIcon(kind),
      type: 'message-object',
      dataRef: {
        ...conn,
        dbName: conn.dbName,
        messageQueue: true,
        messageQueueType: profile.type,
        messageObjectName: name,
        messageObjectKind: kind,
        messageObjectType: rawType,
        // Existing preview/publish actions already understand tableName. Keep
        // that compatibility field while the node itself uses message semantics.
        tableName: name,
      },
      isLeaf: true,
    }];
  }).sort((left, right) => String(left.title).localeCompare(
    String(right.title),
    undefined,
    { numeric: true, sensitivity: 'base' },
  ));

  if (!profile.groups) return nodes;
  return profile.groups.map((group) => {
    const children = nodes.filter(
      (candidate) => candidate.dataRef?.messageObjectKind === group.kind,
    );
    return {
      title: t(group.titleKey),
      key: `${parentKey}-message-group-${group.groupKey}`,
      icon: <GnFolderOpenIcon />,
      type: 'message-object-group',
      dataRef: {
        ...conn,
        dbName: conn.dbName,
        messageQueue: true,
        messageQueueType: profile.type,
        messageObjectKind: group.kind,
        groupKey: group.groupKey,
      },
      isLeaf: children.length === 0,
      ...(children.length > 0 ? { children } : {}),
    } as TreeNode;
  });
};

/**
 * How long the database loader waits for views/routines/sequences/triggers after the
 * tables are known before committing a tables-only tree. Remote or driver-agent links
 * (strictly serial transport) exceed this and get a progressive render.
 */
export const SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS = 80;

export const dedupeTrimmedDatabaseNames = (databaseNames: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  databaseNames.forEach((databaseName) => {
    const normalizedName = String(databaseName || '').trim();
    if (!normalizedName || seen.has(normalizedName)) return;
    seen.add(normalizedName);
    result.push(normalizedName);
  });
  return result;
};
