import { normalizeDriverType } from './useSidebarTreeLoaders';
import React, { useEffect, useLayoutEffect } from 'react';
import { Input } from 'antd';
import { SavedConnection, SavedQuery } from '../../types';
import { t } from '../../i18n';

// Keep the titlebar snapshot synchronous in the browser without emitting an
// SSR warning when the Sidebar is rendered to HTML in tests or web tooling.
export const useSidebarLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const { Search } = Input;
export const SIDEBAR_CACHED_DATABASE_TREE_LIMIT = 12;
export const NACOS_SERVICES_CHANGED_EVENT = 'gonavi:nacos-services-changed';
export const SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS = 500;
export const SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS = 2000;

export const buildOptionalSchemaContext = (value: unknown): { schemaName?: string } => {
  const schemaName = String(value ?? '').trim();
  return schemaName ? { schemaName } : {};
};

type NacosServiceRefreshTreeNode = {
  key: React.Key;
  children?: NacosServiceRefreshTreeNode[];
};

export const resolveNacosServiceGroupsRefreshTarget = (
  detail: unknown,
  treeData: readonly NacosServiceRefreshTreeNode[],
  expandedKeys: readonly React.Key[],
): { key: string; node: NacosServiceRefreshTreeNode; shouldReload: boolean } | null => {
  if (!detail || typeof detail !== 'object') return null;
  const eventDetail = detail as Record<string, unknown>;
  const connectionId = String(eventDetail.connectionId || '').trim();
  if (!connectionId) return null;
  const namespaceId = String(eventDetail.namespaceId ?? '').trim();
  const key = `${connectionId}-nacos-ns-${namespaceId || 'public'}-services`;

  const findNode = (nodes: readonly NacosServiceRefreshTreeNode[]): NacosServiceRefreshTreeNode | null => {
    for (const node of nodes) {
      if (String(node.key) === key) return node;
      const child = node.children?.length ? findNode(node.children) : null;
      if (child) return child;
    }
    return null;
  };

  const node = findNode(treeData);
  if (!node) return null;
  return {
    key,
    node,
    shouldReload: expandedKeys.some((expandedKey) => String(expandedKey) === key),
  };
};

// resolveV2ObjectGroupTitle 已迁移到 ./sidebar/sidebarHelpers

// shouldLoadSidebarNodeOnExpand 已迁移到 ./sidebar/sidebarHelpers

// resolveSidebarTableNameForCopy 已迁移到 ./sidebar/sidebarHelpers

export const buildConnectionRootQueryTabTitle = () => t('query.new');

export const buildConnectionRootRedisCommandTabTitle = (redisDbLabel = 'db0') =>
  t('sidebar.tab.redis_command', { database: redisDbLabel });

export const buildConnectionRootRedisMonitorTabTitle = (redisDbLabel = 'db0') =>
  t('sidebar.tab.redis_monitor', { database: redisDbLabel });

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

export const isConnectionTreeKey = (key: React.Key, connectionId: string): boolean => {
  const text = String(key);
  return text === connectionId || text.startsWith(`${connectionId}-`);
};

export const isPostgresSchemaDialect = (dialect: string): boolean => (
  ['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss'].includes(normalizeDriverType(dialect))
);

export const isSavedQueryUnmatchedForConnectionIds = (query: SavedQuery, connectionIds: Set<string>): boolean => (
  query.bindingStatus === 'orphan' || !connectionIds.has(query.connectionId)
);
