import type React from 'react';
import type { SavedConnection } from '../types';
import { t as catalogTranslate } from '../i18n/catalog';
import {
  isPostgresSchemaDialect as resolveIsPostgresSchemaDialect,
  normalizeDriverType as normalizeConnectionDriverType,
  resolveSavedConnectionDriverType as resolveSavedConnectionDriverTypeBase,
} from '../utils/connectionDriverType';

const SIDEBAR_CONTEXT_MENU_SAFE_GAP = 8;
export const SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH = 264;
export const SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT = 420;

export type ExternalSQLFileModalMode = 'create' | 'rename' | 'create-directory' | 'rename-directory';
export type SearchScope = 'smart' | 'object' | 'database' | 'host' | 'tag';

type SidebarCoreTranslate = (key: string) => string;

const translateSidebarCoreZhCN: SidebarCoreTranslate = (key) => catalogTranslate('zh-CN', key);

type SidebarObjectNodeLike = {
  title?: string;
  type?: string;
  dataRef?: any;
};

export const isExternalSQLDirectoryModalMode = (mode: ExternalSQLFileModalMode): boolean =>
  mode === 'create-directory' || mode === 'rename-directory';

export const resolveSidebarContextMenuPosition = (
  x: number,
  y: number,
  options?: {
    width?: number;
    height?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    safeGap?: number;
  },
): { x: number; y: number; maxHeight: number } => {
  const safeGap = options?.safeGap ?? SIDEBAR_CONTEXT_MENU_SAFE_GAP;
  const viewportWidth = options?.viewportWidth ?? (typeof window === 'undefined' ? 1024 : window.innerWidth);
  const viewportHeight = options?.viewportHeight ?? (typeof window === 'undefined' ? 768 : window.innerHeight);
  const width = Math.max(0, options?.width ?? SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH);
  const height = Math.max(0, options?.height ?? SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT);
  const maxX = Math.max(safeGap, viewportWidth - width - safeGap);
  const maxY = Math.max(safeGap, viewportHeight - height - safeGap);
  const nextX = Math.max(safeGap, Math.min(x, maxX));
  const nextY = Math.max(safeGap, Math.min(y, maxY));
  return {
    x: nextX,
    y: nextY,
    maxHeight: Math.max(120, viewportHeight - nextY - safeGap),
  };
};

export const isV2SidebarObjectNode = (node: Pick<SidebarObjectNodeLike, 'type'> | null | undefined): boolean => {
  return node?.type === 'table'
    || node?.type === 'view'
    || node?.type === 'materialized-view'
    || node?.type === 'sequence'
    || node?.type === 'db-trigger'
    || node?.type === 'db-event'
    || node?.type === 'routine'
    || node?.type === 'package';
};

export const resolveSidebarObjectDragText = (
  node: Pick<SidebarObjectNodeLike, 'type' | 'title' | 'dataRef'> | null | undefined,
): string => {
  const dataRef = node?.dataRef || {};
  if (node?.type === 'table') return String(dataRef.tableName || node?.title || '').trim();
  if (node?.type === 'view' || node?.type === 'materialized-view') return String(dataRef.viewName || dataRef.tableName || node?.title || '').trim();
  if (node?.type === 'sequence') return String(dataRef.sequenceName || node?.title || '').trim();
  if (node?.type === 'db-trigger') return String(dataRef.triggerName || node?.title || '').trim();
  if (node?.type === 'routine') return String(dataRef.routineName || node?.title || '').trim();
  if (node?.type === 'package') return String(dataRef.packageName || node?.title || '').trim();
  if (node?.type === 'db-event') return String(dataRef.eventName || node?.title || '').trim();
  return '';
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

export const isConnectionTreeKey = (key: React.Key, connectionId: string): boolean => {
  const text = String(key);
  return text === connectionId || text.startsWith(`${connectionId}-`);
};

export const normalizeDriverType = normalizeConnectionDriverType;
export const resolveSavedConnectionDriverType = resolveSavedConnectionDriverTypeBase;
export const isPostgresSchemaDialect = resolveIsPostgresSchemaDialect;

export const buildSearchScopeOptions = (
  translate: SidebarCoreTranslate = translateSidebarCoreZhCN,
): Array<{ value: SearchScope; label: string }> => [
  { value: 'smart', label: translate('sidebar.search.scope.smart') },
  { value: 'object', label: translate('sidebar.search.scope.object') },
  { value: 'database', label: translate('sidebar.search.scope.database') },
  { value: 'host', label: translate('sidebar.search.scope.host') },
  { value: 'tag', label: translate('sidebar.search.scope.tag') },
];

export const SEARCH_SCOPE_OPTIONS: Array<{ value: SearchScope; label: string }> = buildSearchScopeOptions();

export const SEARCH_SCOPE_LABEL_MAP: Record<SearchScope, string> = SEARCH_SCOPE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {} as Record<SearchScope, string>);

export const normalizeMySQLViewDDLForEditing = (viewName: string, rawDefinition: unknown): string => {
  const text = String(rawDefinition || '').trim();
  if (!text) return '';

  const normalized = text.replace(/\r\n/g, '\n').trim().replace(/;+\s*$/, '');
  const createViewPrefixPattern = /^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:`[^`]+`|\S+)\s*@\s*(?:`[^`]+`|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+/i;
  if (createViewPrefixPattern.test(normalized)) {
    return `${normalized.replace(createViewPrefixPattern, 'CREATE OR REPLACE VIEW ')};`;
  }

  if (/^\s*(select|with)\b/i.test(normalized)) {
    return `CREATE OR REPLACE VIEW ${viewName} AS\n${normalized};`;
  }

  return `${normalized};`;
};
