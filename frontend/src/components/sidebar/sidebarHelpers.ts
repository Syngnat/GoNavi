// Sidebar 工具函数集合（第一期：纯函数 + 共享常量/类型）。
//
// 本文件是 Sidebar.tsx 拆分的第一步，只搬迁完全独立、无内部类型依赖的工具函数。
// 后续 PR 会继续搬迁更多工具函数和子组件。
//
// 设计原则：
//   - 只放纯函数（无副作用、无 React state）
//   - 不依赖 Sidebar.tsx 内部的 TreeNode 类型（用结构化类型参数代替）
//   - 共享常量和类型集中管理，便于跨文件复用

import { t } from '../../i18n';
import type {
  SidebarTableMetadataField,
  SidebarTableMetadataSnapshot,
} from '../../utils/sidebarTableMetadata';

// === 共享常量 ===

/** V2 Rail 中"未分组连接"组的固定 ID */
export const V2_RAIL_UNGROUPED_CONNECTION_GROUP_ID = '__gonavi-v2-ungrouped-connections__';

// === 共享类型 ===

/** V2 资源管理器过滤维度 */
export type V2ExplorerFilter = 'all' | 'tables' | 'views' | 'sequences' | 'routines' | 'packages' | 'events';

// === 纯函数 ===

/**
 * formatSidebarRowCount 把行数格式化为人类可读的简短形式。
 * - >= 1M 显示为 "1.2M"
 * - >= 1K 显示为 "1.2K"
 * - 否则显示原数字
 * - 非法值（NaN/负数）返回空字符串
 */
export const formatSidebarRowCount = (count: number): string => {
  if (!Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(Math.round(count));
};

/**
 * formatSidebarTableSize 把字节数格式化为适合侧栏展示的短文本。
 */
export const formatSidebarTableSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const padSidebarTimestampPart = (value: number): string => String(value).padStart(2, '0');

/**
 * formatSidebarTableTimestamp 把数据库返回的时间值格式化为
 * `YYYY-MM-DD HH:mm:ss`；若源值带小数秒（毫秒/微秒），则原样保留小数部分。
 * 例：
 *   2026-04-26T18:06:08+08:00     → 2026-04-26 18:06:08
 *   2026-05-10T09:12:33.456+08:00 → 2026-05-10 09:12:33.456
 * 若无法被 Date 可靠解析，则尽量保留原始文本的可读部分。
 */
export const formatSidebarTableTimestamp = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return [
      date.getFullYear(),
      '-',
      padSidebarTimestampPart(date.getMonth() + 1),
      '-',
      padSidebarTimestampPart(date.getDate()),
      ' ',
      padSidebarTimestampPart(date.getHours()),
      ':',
      padSidebarTimestampPart(date.getMinutes()),
      ':',
      padSidebarTimestampPart(date.getSeconds()),
    ].join('');
  }
  const text = String(value ?? '').trim();
  if (!text) return '';

  // 优先用正则剥离时区，保留秒与小数秒（避免 Date 丢弃微秒精度）
  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/i,
  );
  if (match) {
    return `${match[1]} ${match[2]}${match[3] || ''}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    // 无法解析时去掉 T/时区噪音，尽量给出可读截断
    const fallback = text
      .replace('T', ' ')
      .replace(/([+-]\d{2}:?\d{2}|Z)\s*$/i, '')
      .trim();
    return fallback.length > 23 ? fallback.slice(0, 23) : fallback;
  }

  const base = [
    parsed.getFullYear(),
    '-',
    padSidebarTimestampPart(parsed.getMonth() + 1),
    '-',
    padSidebarTimestampPart(parsed.getDate()),
    ' ',
    padSidebarTimestampPart(parsed.getHours()),
    ':',
    padSidebarTimestampPart(parsed.getMinutes()),
    ':',
    padSidebarTimestampPart(parsed.getSeconds()),
  ].join('');

  const ms = parsed.getMilliseconds();
  if (ms > 0) {
    return `${base}.${String(ms).padStart(3, '0')}`;
  }
  return base;
};

export interface SidebarTableMetadataDisplayItem {
  key: SidebarTableMetadataField;
  text: string;
  className: string;
}

export const buildSidebarTableMetadataSnapshot = (
  value: Partial<SidebarTableMetadataSnapshot> | null | undefined,
): SidebarTableMetadataSnapshot => {
  const rowCount = Number(value?.rowCount);
  const tableSize = Number(value?.tableSize);
  const tableComment = String(value?.tableComment || '').trim();
  const createdAt = String(value?.createdAt || '').trim();
  const updatedAt = String(value?.updatedAt || '').trim();
  return {
    ...(tableComment ? { tableComment } : {}),
    ...(Number.isFinite(rowCount) && rowCount >= 0 ? { rowCount } : {}),
    ...(Number.isFinite(tableSize) && tableSize >= 0 ? { tableSize } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
};

export const buildSidebarTableMetadataDisplayItems = (
  metadataFields: SidebarTableMetadataField[],
  snapshot: SidebarTableMetadataSnapshot,
): SidebarTableMetadataDisplayItem[] => {
  const items: SidebarTableMetadataDisplayItem[] = [];
  metadataFields.forEach((field) => {
    if (field === 'comment' && snapshot.tableComment) {
      items.push({
        key: 'comment',
        text: snapshot.tableComment,
        className: 'gn-v2-tree-table-comment',
      });
      return;
    }
    if (field === 'rows' && snapshot.rowCount !== undefined) {
      const count = formatSidebarRowCount(snapshot.rowCount);
      if (count) {
        items.push({
          key: 'rows',
          text: t('sidebar.v2_table_group_menu.metadata_value.rows', { count }),
          className: 'gn-v2-tree-count',
        });
      }
      return;
    }
    if (field === 'size' && snapshot.tableSize !== undefined) {
      const size = formatSidebarTableSize(snapshot.tableSize);
      if (size) {
        items.push({
          key: 'size',
          text: t('sidebar.v2_table_group_menu.metadata_value.size', { size }),
          className: 'gn-v2-tree-count',
        });
      }
      return;
    }
    if (field === 'createdAt' && snapshot.createdAt) {
      const time = formatSidebarTableTimestamp(snapshot.createdAt);
      if (time) {
        items.push({
          key: 'createdAt',
          text: t('sidebar.v2_table_group_menu.metadata_value.created_at', { time }),
          className: 'gn-v2-tree-count',
        });
      }
      return;
    }
    if (field === 'updatedAt' && snapshot.updatedAt) {
      const time = formatSidebarTableTimestamp(snapshot.updatedAt);
      if (time) {
        items.push({
          key: 'updatedAt',
          text: t('sidebar.v2_table_group_menu.metadata_value.updated_at', { time }),
          className: 'gn-v2-tree-count',
        });
      }
    }
  });
  return items;
};

/**
 * hasSidebarLazyChildren 判断树节点的 children 是否已加载（用于按需展开）。
 */
export const hasSidebarLazyChildren = (children: unknown): boolean => {
  return Array.isArray(children) && children.length > 0;
};

/**
 * shouldClearSidebarActiveContextOnEmptySelect 判断在空选择时是否清空激活上下文。
 * 仅 legacy UI 需要清空；V2 UI 保留上下文。
 */
export const shouldClearSidebarActiveContextOnEmptySelect = (isV2Ui: boolean): boolean => !isV2Ui;

/**
 * getV2RailConnectionGroupBadgeText 从组名生成 1-2 字符的徽章文本。
 * 中文取首字；英文取前两个 token 的首字母大写；其他取前 2 字符。
 */
export const getV2RailConnectionGroupBadgeText = (
  name: unknown,
  fallback = t('connection.sidebar.group.badge'),
): string => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return fallback;
  const cjkParts = trimmed.match(/[一-龥]/g);
  if (cjkParts && cjkParts.length > 0) {
    return cjkParts.slice(0, 1).join('');
  }
  const latinTokens = trimmed.match(/[a-z0-9]+/gi) || [];
  if (latinTokens.length >= 2) {
    const firstToken = latinTokens[0] || '';
    const secondToken = latinTokens[1] || '';
    return `${firstToken[0] || ''}${secondToken[0] || ''}`.toUpperCase();
  }
  if (latinTokens.length === 1) {
    const token = latinTokens[0] || '';
    const alphaPrefix = token.match(/^[a-z]+/i)?.[0] || '';
    if (alphaPrefix) {
      return alphaPrefix.slice(0, 2).toUpperCase();
    }
    const trailingDigits = token.match(/(\d{2,})$/)?.[1];
    if (trailingDigits) {
      return trailingDigits.slice(-2).toUpperCase();
    }
    return token.slice(0, 2).toUpperCase();
  }
  return trimmed.slice(0, 2);
};

/**
 * isV2SidebarObjectNode 判断节点是否是 SQL 对象类型（表/视图/触发器/事件/存储过程）。
 * 接收结构化类型而非 TreeNode，避免对 Sidebar 内部类型的硬依赖。
 */
export const isV2SidebarObjectNode = (
  node: { type?: string } | null | undefined,
): boolean => {
  return node?.type === 'message-object'
      || node?.type === 'table'
      || node?.type === 'view'
      || node?.type === 'materialized-view'
      || node?.type === 'sequence'
      || node?.type === 'db-trigger'
      || node?.type === 'db-event'
      || node?.type === 'routine'
      || node?.type === 'package';
};

// === 第二期：依赖 i18n 但不依赖 TreeNode 内部类型的工具函数 ===

/**
 * SidebarNodeLike 是 TreeNode 的结构化子集，用于工具函数签名。
 * 让 sidebarHelpers 不依赖 Sidebar.tsx 内部的 TreeNode 定义，避免循环依赖。
 */
export interface SidebarNodeLike {
  key?: string;
  type?: string;
  dataRef?: any;
  title?: string;
  children?: SidebarNodeLike[];
  isLeaf?: boolean;
}

/**
 * resolveV2ObjectGroupTitle 解析 V2 资源管理器中"对象分组"节点的本地化标题。
 * 仅对 type === 'object-group' 的节点有效，其他返回 null。
 */
export const resolveV2ObjectGroupTitle = (
  node: Pick<SidebarNodeLike, 'type' | 'dataRef'> | null | undefined,
): string | null => {
  if (node?.type !== 'object-group') return null;
  const groupKey = String(node?.dataRef?.groupKey || '');
  if (groupKey === 'tables') return t('sidebar.v2_table_group_menu.title');
  if (groupKey === 'views') return t('sidebar.object_group.views');
  if (groupKey === 'sequences') return t('sidebar.object_group.sequences');
  if (groupKey === 'routines') return t('sidebar.object_group.routines');
  if (groupKey === 'packages') return t('sidebar.object_group.packages');
  if (groupKey === 'triggers') return t('sidebar.object_group.triggers');
  if (groupKey === 'events') return t('sidebar.object_group.events');
  if (groupKey === 'materializedViews') return t('sidebar.object_group.materialized_views');
  return null;
};

/**
 * resolveSidebarTableNameForCopy 从节点提取用于复制的表名。
 * 优先级：dataRef.tableName > dataRef.viewName > dataRef.eventName > title。
 */
export const resolveSidebarTableNameForCopy = (
  node: Pick<SidebarNodeLike, 'title' | 'dataRef'> | null | undefined,
): string => {
  return String(
    node?.dataRef?.messageObjectName
    || node?.dataRef?.topicName
    || node?.dataRef?.queueName
    || node?.dataRef?.exchangeName
    || node?.dataRef?.tableName
    || node?.dataRef?.viewName
    || node?.dataRef?.sequenceName
    || node?.dataRef?.packageName
    || node?.dataRef?.eventName
    || node?.title
    || '',
  ).trim();
};

const SIDEBAR_TITLEBAR_OBJECT_TYPES = new Set([
  'table',
  'message-object',
  'view',
  'materialized-view',
  'sequence',
  'package',
  'db-trigger',
  'db-event',
  'routine',
]);

/** Extracts the selected object's own name for compact context displays. */
export const resolveSidebarTitlebarObjectName = (
  node: Pick<SidebarNodeLike, 'title' | 'type' | 'dataRef'> | null | undefined,
): string => {
  // Folder, schema, and namespace rows carry a display title too, but they
  // are database context rather than a selected table/object. Only mirror
  // names for rows that the workbench opens as an object.
  if (!SIDEBAR_TITLEBAR_OBJECT_TYPES.has(String(node?.type || ''))) {
    return '';
  }
  const dataRef = node?.dataRef;
  const objectName = node?.type === 'db-trigger'
    ? dataRef?.triggerName
    : node?.type === 'routine'
      ? dataRef?.routineName
      : node?.type === 'db-event'
        ? dataRef?.eventName
        : node?.type === 'sequence'
          ? dataRef?.sequenceName
          : node?.type === 'package'
            ? dataRef?.packageName
            : undefined;

  return String(objectName || resolveSidebarTableNameForCopy(node) || '').trim();
};

/**
 * Remove a stale Host result before the row is selected again. An active
 * loading result is intentionally retained so selecting the row does not
 * cancel or hide an in-flight metadata request.
 */
export const clearSidebarHostConnectionState = <T>(
  states: Readonly<Record<string, T>>,
  connectionId: unknown,
): Record<string, T> => {
  const key = String(connectionId ?? '').trim();
  if (!key || !Object.prototype.hasOwnProperty.call(states, key)) {
    return states;
  }
  const currentState = String(states[key] ?? '').trim();
  if (currentState === 'loading') {
    return states;
  }
  const next = { ...states };
  delete next[key];
  return next;
};

/**
 * Keep a previously published title-bar selection while the tree is being
 * rebuilt. A non-empty selected key that still belongs to a saved Host can
 * briefly have no node during an async subtree refresh; publishing `null` in
 * that window would erase the useful Host/database/table summary. Keys that
 * no longer belong to any saved Host are allowed to clear stale context.
 */
export const shouldDeferSidebarTitlebarSelection = ({
  selectedKey,
  selectedNode,
  connectionIds,
}: {
  selectedKey?: unknown;
  selectedNode?: { key?: unknown } | null;
  connectionIds: readonly string[];
}): boolean => {
  if (selectedNode) return false;
  const key = String(selectedKey ?? '').trim();
  if (!key) return false;

  return connectionIds.some((connectionId) => {
    const hostId = String(connectionId ?? '').trim();
    return Boolean(hostId && (key === hostId || key.startsWith(`${hostId}-`)));
  });
};

export const resolveSidebarQueriesFolderTitle = (
  node: Pick<SidebarNodeLike, 'type'> | null | undefined,
): string | null => {
  if (node?.type !== 'queries-folder') return null;
  return t('sidebar.tree.saved_queries');
};

/** resolveSidebarDatabaseNameForCopy extracts the exact database identifier shown by the node. */
export const resolveSidebarDatabaseNameForCopy = (
  node: Pick<SidebarNodeLike, 'title' | 'dataRef'> | null | undefined,
): string => String(node?.dataRef?.dbName || node?.title || '').trim();

// === 命令搜索相关类型与解析（V2 Command Search）===

/** 命令搜索模式：default（默认）/ object（@前缀，对象搜索）/ ai（?或？前缀，AI 提问） */
export type V2CommandSearchMode = 'default' | 'object' | 'ai';

/** 命令搜索查询解析结果 */
export interface V2CommandSearchQuery {
  mode: V2CommandSearchMode;
  rawValue: string;
  keyword: string;
  normalizedKeyword: string;
  aiPrompt: string;
}

/**
 * parseV2CommandSearchQuery 解析命令搜索框的输入。
 * - "@" 或 "＠" 前缀：对象搜索模式
 * - "?" 或 "？" 前缀：AI 提问模式
 * - 无前缀：默认模式
 */
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
      normalizedKeyword: keyword.toLowerCase(),
      aiPrompt: '',
    };
  }

  if (firstChar === '?' || firstChar === '？') {
    const aiPrompt = trimmedValue.slice(1).trim();
    return {
      mode: 'ai',
      rawValue,
      keyword: aiPrompt,
      normalizedKeyword: aiPrompt.toLowerCase(),
      aiPrompt,
    };
  }

  return {
    mode: 'default',
    rawValue,
    keyword: trimmedValue,
    normalizedKeyword: trimmedValue.toLowerCase(),
    aiPrompt: '',
  };
};

/**
 * shouldLoadSidebarNodeOnExpand 判断节点展开时是否需要懒加载子节点。
 * 仅可懒加载的目录类型且无已加载 children 时返回 true。
 */
export const shouldLoadSidebarNodeOnExpand = (
  node: Pick<SidebarNodeLike, 'type' | 'children' | 'isLeaf'> | null | undefined,
): boolean => {
  if (!node || node.isLeaf === true || hasSidebarLazyChildren(node.children)) return false;
  return node.type === 'connection'
      || node.type === 'database'
      || node.type === 'message-namespace'
      || node.type === 'external-sql-root'
      || node.type === 'table'
      || node.type === 'jvm-mode'
      || node.type === 'jvm-resource'
      || node.type === 'nacos-config-entry'
      || node.type === 'nacos-services-entry';
};
