import type { ReactNode } from 'react';
import {
  normalizeSidebarSearchText,
  isSidebarCommandSearchObjectNode,
  matchesSidebarSearchText,
} from './sidebarHelpers';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';

export const V2_TREE_HORIZONTAL_SCROLL_BOTTOM_RESERVE = 0;

export type V2CommandSearchItem =
  | {
      key: string;
      kind: 'node';
      title: string;
      meta: string;
      icon: ReactNode;
      node: SidebarTreeNode;
    }
  | {
      key: string;
      kind: 'action';
      title: string;
      meta: string;
      shortcut?: string;
      icon: ReactNode;
      onRun: () => void;
    }
  | {
      key: string;
      kind: 'recent';
      title: string;
      meta: string;
      icon: ReactNode;
      logId: string;
      sql: string;
      connectionId?: string;
      dbName?: string;
    };

export interface V2CommandSearchTreeIndexEntry {
  item: Extract<V2CommandSearchItem, { kind: 'node' }>;
  normalizedSearchText: string;
  normalizedObjectText: string;
  objectNode: boolean;
}

export type V2CommandSearchMode = 'default' | 'object' | 'ai';

export interface V2CommandSearchQuery {
  mode: V2CommandSearchMode;
  rawValue: string;
  keyword: string;
  normalizedKeyword: string;
  aiPrompt: string;
}

export const parseV2CommandSearchQuery = (value: unknown): V2CommandSearchQuery => {
  const rawValue = String(value ?? '');
  const trimmedValue = rawValue.trim();
  const firstChar = trimmedValue.charAt(0);

  if (firstChar === '@' || firstChar === '＠') {
    const keyword = trimmedValue.slice(1).trim();
    return {
      mode: 'object',
      rawValue,
      keyword,
      normalizedKeyword: normalizeSidebarSearchText(keyword),
      aiPrompt: '',
    };
  }

  if (firstChar === '?' || firstChar === '？') {
    const aiPrompt = trimmedValue.slice(1).trim();
    return {
      mode: 'ai',
      rawValue,
      keyword: aiPrompt,
      normalizedKeyword: normalizeSidebarSearchText(aiPrompt),
      aiPrompt,
    };
  }

  return {
    mode: 'default',
    rawValue,
    keyword: trimmedValue,
    normalizedKeyword: normalizeSidebarSearchText(trimmedValue),
    aiPrompt: '',
  };
};

export const V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT = 24;
export const V2_COMMAND_SEARCH_MAX_TREE_RESULTS = 120;

export const buildV2CommandSearchTreeIndex = (
  items: V2CommandSearchItem[],
): V2CommandSearchTreeIndexEntry[] => {
  const seenKeys = new Set<string>();
  return items.flatMap((item) => {
    if (item.kind !== 'node') {
      return [];
    }
    const nodeKey = item.node?.key == null ? '' : String(item.node.key).trim();
    const dedupeKey = nodeKey || item.key;
    if (seenKeys.has(dedupeKey)) {
      return [];
    }
    seenKeys.add(dedupeKey);
    const dataRef = item.node.dataRef || {};
    const normalizedTitle = normalizeSidebarSearchText(item.title);
    const normalizedPrimaryObjectText = normalizeSidebarSearchText(
      dataRef.messageObjectName
      || dataRef.topicName
      || dataRef.queueName
      || dataRef.exchangeName
      || dataRef.tableName
      || dataRef.viewName
      || dataRef.sequenceName
      || dataRef.packageName || dataRef.databaseLinkName
      || item.title
      || '',
    );

    return [{
      item,
      normalizedSearchText: normalizeSidebarSearchText([
        item.title,
        item.meta,
        dataRef.messageObjectName,
        dataRef.topicName,
        dataRef.queueName,
        dataRef.exchangeName,
        dataRef.tableName,
        dataRef.viewName,
        dataRef.sequenceName,
        dataRef.packageName,
        dataRef.tableComment,
        dataRef.dbName,
        dataRef.name,
        dataRef.config?.host,
      ].filter(Boolean).join(' ')),
      normalizedObjectText: normalizeSidebarSearchText(
        `${normalizedPrimaryObjectText} ${String(dataRef.tableComment || '').trim()} ${normalizedTitle}`,
      ),
      objectNode: isSidebarCommandSearchObjectNode(item.node),
    }];
  });
};

export const filterV2CommandSearchTreeItems = (
  items: V2CommandSearchItem[] | V2CommandSearchTreeIndexEntry[],
  query: V2CommandSearchQuery,
): V2CommandSearchItem[] => {
  if (query.mode === 'ai') return [];
  const index = items.length > 0 && 'item' in items[0]
    ? items as V2CommandSearchTreeIndexEntry[]
    : buildV2CommandSearchTreeIndex(items as V2CommandSearchItem[]);
  const normalizedKeyword = query.normalizedKeyword;
  const objectMode = query.mode === 'object';
  const result: V2CommandSearchItem[] = [];
  const maxResults = normalizedKeyword
    ? V2_COMMAND_SEARCH_MAX_TREE_RESULTS
    : V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT;

  for (const entry of index) {
    if (objectMode && !entry.objectNode) {
      continue;
    }
    if (!normalizedKeyword) {
      result.push(entry.item);
    } else if (objectMode
      ? matchesSidebarSearchText(entry.normalizedObjectText, normalizedKeyword)
      : matchesSidebarSearchText(entry.normalizedSearchText, normalizedKeyword)) {
      result.push(entry.item);
    }
    if (result.length >= maxResults) {
      break;
    }
  }

  return result;
};

export interface V2CommandSearchEnterState {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  activeItemCount: number;
}

export const shouldRunV2CommandSearchEnter = ({
  key,
  isComposing,
  keyCode,
  activeItemCount,
}: V2CommandSearchEnterState): boolean => {
  if (key !== 'Enter') return false;
  if (isComposing || keyCode === 229) return false;
  return activeItemCount > 0;
};

export interface V2CommandSearchGlobalKeyState {
  key: string;
  isOpen: boolean;
}

export const shouldCloseV2CommandSearchOnGlobalKey = ({
  key,
  isOpen,
}: V2CommandSearchGlobalKeyState): boolean => {
  if (!isOpen) return false;
  const normalizedKey = String(key || '').toLowerCase();
  return normalizedKey === 'escape' || normalizedKey === 'esc';
};
