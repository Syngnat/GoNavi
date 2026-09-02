import React, { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Checkbox } from 'antd';
import {
  BarsOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloudOutlined,
  CodeOutlined,
  DatabaseOutlined,
  EyeOutlined,
  FilterOutlined,
  KeyOutlined,
  PlusOutlined,
  RobotOutlined,
  TableOutlined,
  TagOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import { type SqlLog, useStore } from '../../store';
import type { SavedConnection } from '../../types';
import { getCurrentLanguage, t } from '../../i18n';
import { resolveShortcutDisplay } from '../../utils/shortcuts';
import type { SidebarTableMetadataField } from '../../utils/sidebarTableMetadata';
import { resolveConnectionHostSummary, resolveConnectionHostTokens } from '../../utils/tabDisplay';
import { resolveConnectionAccentColor, resolveConnectionIconType } from '../../utils/connectionVisual';
import { getDbIcon } from '../DatabaseIcons';
import {
  isV2SidebarObjectNode,
  parseV2CommandSearchQuery,
  type V2ExplorerFilter,
} from './sidebarHelpers';
import type { SearchScope } from '../sidebarCoreUtils';
import {
  buildV2CommandSearchTreeIndex,
  dedupeSidebarTreeNodesByKey,
  estimateV2TreeHorizontalScrollWidth,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  resolveSidebarNodeConnectionId,
  resolveSidebarTreeVirtualHeight,
  resolveV2ActiveConnectionId,
  type SidebarTreeNode as TreeNode,
  type V2CommandSearchItem,
} from '../sidebarV2Utils';

const SEARCH_SCOPE_OPTIONS: Array<{ value: SearchScope; labelKey: string }> = [
  { value: 'smart', labelKey: 'sidebar.command_search.scope.smart' },
  { value: 'object', labelKey: 'sidebar.command_search.scope.object' },
  { value: 'database', labelKey: 'sidebar.command_search.scope.database' },
  { value: 'host', labelKey: 'sidebar.command_search.scope.host' },
  { value: 'tag', labelKey: 'sidebar.command_search.scope.tag' },
];

const SEARCH_SCOPE_LABEL_KEY_MAP: Record<SearchScope, string> = SEARCH_SCOPE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.labelKey;
  return acc;
}, {} as Record<SearchScope, string>);

const SEARCH_SCOPE_ICON_MAP: Record<SearchScope, React.ReactNode> = {
  smart: <ThunderboltOutlined />,
  object: <TableOutlined />,
  database: <DatabaseOutlined />,
  host: <CloudOutlined />,
  tag: <TagOutlined />,
};

type SidebarSearchModelArgs = {
  searchScopes: SearchScope[];
  setSearchScopes: Dispatch<SetStateAction<SearchScope[]>>;
  setSearchValue: Dispatch<SetStateAction<string>>;
  deferredSearchValue: string;
  deferredV2CommandSearchValue: string;
  v2CommandSearchValue: string;
  setV2CommandActiveIndex: Dispatch<SetStateAction<number>>;
  v2ExplorerFilter: V2ExplorerFilter;
  sidebarTableMetadataFields: SidebarTableMetadataField[];
  treeData: TreeNode[];
  treeViewportWidth: number;
  treeHeight: number;
  isV2Ui: boolean;
  isV2CommandSearchOpen: boolean;
  connections: SavedConnection[];
  connectionIds: string[];
  selectedKeys: React.Key[];
  selectedNodesRef: MutableRefObject<any[]>;
  activeContext: any;
  activeTab: any;
  recentSqlLogs: SqlLog[];
  shortcutOptions: any;
  activeShortcutPlatform: any;
  overlayTheme: {
    sectionBorder: string;
    mutedText: string;
    titleText: string;
    shellBg: string;
    divider: string;
  };
  darkMode: boolean;
  onCreateConnection?: () => void;
  onToggleAI?: () => void;
  onToggleLogPanel?: () => void;
  setAIPanelVisible: (visible: boolean) => void;
  extractObjectName: (fullName: string) => string;
};

export const useSidebarSearchModel = ({
  searchScopes,
  setSearchScopes,
  setSearchValue,
  deferredSearchValue,
  deferredV2CommandSearchValue,
  v2CommandSearchValue,
  setV2CommandActiveIndex,
  v2ExplorerFilter,
  sidebarTableMetadataFields,
  treeData,
  treeViewportWidth,
  treeHeight,
  isV2Ui,
  isV2CommandSearchOpen,
  connections,
  connectionIds,
  selectedKeys,
  selectedNodesRef,
  activeContext,
  activeTab,
  recentSqlLogs,
  shortcutOptions,
  activeShortcutPlatform,
  overlayTheme,
  darkMode,
  onCreateConnection,
  onToggleAI,
  onToggleLogPanel,
  setAIPanelVisible,
  extractObjectName,
}: SidebarSearchModelArgs) => {
  const onSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target;
    setSearchValue(value);
  };

  const toggleSearchScope = (scope: SearchScope) => {
    setSearchScopes((prev) => {
      if (scope === 'smart') {
        return ['smart'];
      }
      const withoutSmart = prev.filter((item) => item !== 'smart');
      if (withoutSmart.includes(scope)) {
        const next = withoutSmart.filter((item) => item !== scope);
        return next.length > 0 ? next : ['smart'];
      }
      return [...withoutSmart, scope];
    });
  };

  const setSearchScopeChecked = (scope: SearchScope, checked: boolean) => {
    if (scope === 'smart') {
      if (checked) {
        setSearchScopes(['smart']);
      } else if (searchScopes.length === 1 && searchScopes[0] === 'smart') {
        setSearchScopes(['smart']);
      } else {
        setSearchScopes((prev) => {
          const next = prev.filter((item) => item !== 'smart');
          return next.length > 0 ? next : ['smart'];
        });
      }
      return;
    }

    if (checked) {
      setSearchScopes((prev) => {
        const withoutSmart = prev.filter((item) => item !== 'smart');
        if (withoutSmart.includes(scope)) {
          return withoutSmart;
        }
        return [...withoutSmart, scope];
      });
    } else {
      setSearchScopes((prev) => {
        const next = prev.filter((item) => item !== scope && item !== 'smart');
        return next.length > 0 ? next : ['smart'];
      });
    }
  };

  const currentLanguage = getCurrentLanguage();
  const connectionById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );

  const searchScopeSummary = useMemo(() => {
    if (searchScopes.includes('smart')) {
      return t('sidebar.command_search.scope.summary_smart');
    }
    return searchScopes.map((scope) => t(SEARCH_SCOPE_LABEL_KEY_MAP[scope])).join(' + ');
  }, [searchScopes, currentLanguage]);

  const searchScopePopoverContent = useMemo(() => {
    const smartSelected = searchScopes.includes('smart');
    const scopedOptions = SEARCH_SCOPE_OPTIONS.filter((option) => option.value !== 'smart');
    const borderColor = overlayTheme.sectionBorder.replace('1px solid ', '');
    const mutedTextColor = overlayTheme.mutedText;
    const titleColor = overlayTheme.titleText;
    const panelBg = overlayTheme.shellBg;
    const smartBg = smartSelected
      ? (darkMode ? 'linear-gradient(135deg, rgba(255,214,102,0.22) 0%, rgba(255,179,71,0.16) 100%)' : 'linear-gradient(135deg, rgba(255,214,102,0.26) 0%, rgba(255,244,204,0.92) 100%)')
      : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.72)');
    const smartBorder = smartSelected
      ? (darkMode ? 'rgba(255,214,102,0.42)' : 'rgba(245,176,65,0.34)')
      : borderColor;
    const getOptionCardStyle = (checked: boolean) => ({
      display: 'flex',
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 12,
      padding: '10px 12px',
      borderRadius: 12,
      border: `1px solid ${checked ? (darkMode ? 'rgba(118,169,250,0.44)' : 'rgba(24,144,255,0.32)') : borderColor}`,
      background: checked
        ? (darkMode ? 'rgba(64,124,255,0.18)' : 'rgba(24,144,255,0.08)')
        : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.76)'),
      transition: 'all 120ms ease',
    });
    return (
      <div style={{ minWidth: 280, display: 'flex', flexDirection: 'column', background: panelBg, padding: 14, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: mutedTextColor, textTransform: 'uppercase' }}>{t('sidebar.command_search.scope.title')}</div>
            <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: mutedTextColor }}>{t('sidebar.command_search.scope.description')}</div>
          </div>
          <div style={{ width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center', background: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.06)', color: darkMode ? '#ffd666' : '#1677ff', flexShrink: 0 }}>
            <FilterOutlined />
          </div>
        </div>

        <label style={{ display: 'block', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: `1px solid ${smartBorder}`, background: smartBg, boxShadow: smartSelected ? (darkMode ? '0 10px 24px rgba(0,0,0,0.24)' : '0 10px 24px rgba(245,176,65,0.14)') : 'none' }}>
            <Checkbox
              checked={smartSelected}
              onChange={(e) => setSearchScopeChecked('smart', e.target.checked)}
            />
            <div style={{ width: 30, height: 30, borderRadius: 10, display: 'grid', placeItems: 'center', background: darkMode ? 'rgba(255,214,102,0.16)' : 'rgba(255,214,102,0.3)', color: darkMode ? '#ffd666' : '#ad6800', flexShrink: 0 }}>
              {SEARCH_SCOPE_ICON_MAP.smart}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: titleColor }}>{t('sidebar.command_search.scope.smart')}</span>
                <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: darkMode ? '#ffe58f' : '#ad6800', background: darkMode ? 'rgba(255,214,102,0.16)' : 'rgba(255,214,102,0.35)' }}>{t('sidebar.command_search.scope.recommended')}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 12, lineHeight: 1.5, color: mutedTextColor }}>{t('sidebar.command_search.scope.smart_help')}</div>
            </div>
          </div>
        </label>

        <div style={{ height: 1, background: overlayTheme.divider, opacity: 0.9 }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: mutedTextColor, textTransform: 'uppercase' }}>{t('sidebar.command_search.scope.manual_title')}</div>
          <div style={{ fontSize: 12, color: mutedTextColor }}>{t('sidebar.command_search.scope.multi_select')}</div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {scopedOptions.map((option) => {
            const checked = searchScopes.includes(option.value);
            return (
              <label key={option.value} style={{ display: 'block', cursor: 'pointer' }}>
                <div style={getOptionCardStyle(checked)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <Checkbox
                      checked={checked}
                      onChange={(e) => setSearchScopeChecked(option.value, e.target.checked)}
                    />
                    <div style={{ width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center', background: checked ? (darkMode ? 'rgba(118,169,250,0.2)' : 'rgba(24,144,255,0.12)') : (darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.06)'), color: checked ? (darkMode ? '#91caff' : '#1677ff') : mutedTextColor, flexShrink: 0 }}>
                      {SEARCH_SCOPE_ICON_MAP[option.value]}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: titleColor, whiteSpace: 'nowrap' }}>{t(option.labelKey)}</span>
                  </div>
                  <div style={{ width: 18, display: 'flex', justifyContent: 'center', color: checked ? (darkMode ? '#91caff' : '#1677ff') : 'transparent', flexShrink: 0 }}>
                    <CheckOutlined />
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div style={{ padding: '10px 12px', borderRadius: 12, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(17,24,39,0.04)', color: mutedTextColor, fontSize: 12, lineHeight: 1.6 }}>
          {t('sidebar.command_search.scope.manual_help')}
        </div>
      </div>
    );
  }, [darkMode, overlayTheme, searchScopes, currentLanguage]);

  const getConnectionHostSearchText = (node: TreeNode): string => {
    if (node.type !== 'connection') return '';
    const config = node.dataRef?.config || {};
    return resolveConnectionHostTokens(config).join(' ');
  };

  const getConnectionNameSearchText = (node: TreeNode): string => {
    if (node.type !== 'connection') return '';
    const name = node.dataRef?.name ?? node.title;
    return String(name || '').toLowerCase();
  };

  const matchByScopes = (node: TreeNode, keyword: string, scopes: SearchScope[]): boolean => {
    const title = String(node.title || '').toLowerCase();
    if (
      scopes.includes('database')
      && (node.type === 'database' || node.type === 'message-namespace')
      && title.includes(keyword)
    ) {
      return true;
    }
    if (scopes.includes('tag') && node.type === 'tag' && title.includes(keyword)) {
      return true;
    }
    if (scopes.includes('host') && node.type === 'connection' && getConnectionHostSearchText(node).includes(keyword)) {
      return true;
    }
    if (
      scopes.includes('object')
      && (isV2SidebarObjectNode(node) || node.type === 'object-group' || node.type === 'message-object-group')
      && title.includes(keyword)
    ) {
      return true;
    }
    if (node.type === 'external-sql-root' || node.type === 'external-sql-directory' || node.type === 'external-sql-folder' || node.type === 'external-sql-file') {
      const pathText = String(node?.dataRef?.path || '').toLowerCase();
      return title.includes(keyword) || pathText.includes(keyword);
    }
    return false;
  };

  // Metadata refreshes can briefly expose the same keyed node more than once.
  // Normalize before filtering so rc-tree's virtual list never receives
  // duplicate keys (which otherwise appear as an endlessly repeated row).
  const normalizedTreeData = useMemo(
    () => dedupeSidebarTreeNodesByKey(treeData),
    [treeData],
  );

  const loop = (data: TreeNode[], keyword: string): TreeNode[] => {
    const isSmartMode = searchScopes.includes('smart');
    const result: TreeNode[] = [];
    data.forEach((item) => {
      const titleMatch = String(item.title || '').toLowerCase().includes(keyword);
      const smartMatch = item.type === 'connection'
        ? getConnectionNameSearchText(item).includes(keyword) || getConnectionHostSearchText(item).includes(keyword)
        : titleMatch;
      const scopedMatch = matchByScopes(item, keyword, searchScopes);
      const selfMatch = isSmartMode ? smartMatch : scopedMatch;
      const filteredChildren = item.children ? loop(item.children, keyword) : [];

      if (selfMatch) {
        const shouldKeepFullSubtree = isSmartMode
          || item.type === 'connection'
          || item.type === 'database'
          || item.type === 'message-namespace'
          || item.type === 'tag'
          || item.type === 'external-sql-root'
          || item.type === 'external-sql-directory'
          || item.type === 'external-sql-folder';
        if (item.children && shouldKeepFullSubtree) {
          result.push(item);
        } else if (item.children && filteredChildren.length > 0) {
          result.push({ ...item, children: filteredChildren });
        } else {
          result.push(item);
        }
        return;
      }

      if (filteredChildren.length > 0) {
        result.push({ ...item, children: filteredChildren });
      }
    });
    return result;
  };

  const displayTreeData = useMemo(() => {
    const keyword = deferredSearchValue.trim().toLowerCase();
    if (!keyword) return normalizedTreeData;
    return loop(normalizedTreeData, keyword);
  }, [deferredSearchValue, normalizedTreeData, searchScopes]);

  const commandSearchTreeItems = useMemo(() => {
    if (!isV2CommandSearchOpen) {
      return [];
    }
    const result: V2CommandSearchItem[] = [];
    const visit = (nodes: TreeNode[]) => {
      nodes.forEach((node) => {
        const dataRef = node.dataRef || {};
        if (node.type === 'connection') {
          const conn = dataRef as SavedConnection;
          result.push({
            key: `node-${node.key}`,
            kind: 'node',
            title: String(node.title || conn.name || t('connection.unnamed')),
            meta: resolveConnectionHostSummary(conn.config) || conn.config?.type || t('connection.sidebar.menu.section'),
            icon: getDbIcon(resolveConnectionIconType(conn), resolveConnectionAccentColor(conn), 16),
            node,
          });
        } else if (node.type === 'database' || node.type === 'message-namespace') {
          const conn = connectionById.get(String(dataRef.id || ''));
          result.push({
            key: `node-${node.key}`,
            kind: 'node',
            title: String(node.title || dataRef.dbName || t('database.unnamed')),
            meta: conn?.name || dataRef.id || t('database.label'),
            icon: <DatabaseOutlined />,
            node,
          });
        } else if (isV2SidebarObjectNode(node)) {
          const conn = connectionById.get(String(dataRef.id || ''));
          const objectName = String(
            dataRef.messageObjectName
            || dataRef.topicName
            || dataRef.queueName
            || dataRef.exchangeName
            || dataRef.tableName
            || dataRef.viewName
            || dataRef.sequenceName
            || dataRef.triggerName
            || dataRef.eventName
            || dataRef.routineName
            || dataRef.packageName
            || node.title
            || '',
          ).trim();
          const displayName = String(node.title || extractObjectName(objectName) || objectName).trim();
          result.push({
            key: `node-${node.key}`,
            kind: 'node',
            title: displayName,
            meta: [conn?.name || dataRef.id, dataRef.dbName].filter(Boolean).join(' · '),
            icon: node.type === 'table'
              ? <TableOutlined />
              : (node.type === 'sequence'
                ? <KeyOutlined />
                : (node.type === 'db-event' ? <ClockCircleOutlined /> : ((node.type === 'routine' || node.type === 'package') ? <CodeOutlined /> : <EyeOutlined />))),
            node,
          });
        }
        if (node.children) visit(node.children);
      });
    };

    visit(normalizedTreeData);
    return result;
  }, [connectionById, extractObjectName, isV2CommandSearchOpen, normalizedTreeData]);
  const commandSearchTreeIndex = useMemo(
    () => buildV2CommandSearchTreeIndex(commandSearchTreeItems),
    [commandSearchTreeItems],
  );

  const commandSearchRecentItems = useMemo<V2CommandSearchItem[]>(() => {
    return recentSqlLogs.map((log) => ({
      key: `recent-${log.id}`,
      kind: 'recent',
      title: log.sql.replace(/\s+/g, ' ').trim() || t('sidebar.command_search.recent_sql_fallback'),
      meta: `${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${log.duration}ms${log.dbName ? ` · ${log.dbName}` : ''}`,
      icon: <ClockCircleOutlined />,
      logId: log.id,
      sql: log.sql,
      dbName: log.dbName,
    }));
  }, [recentSqlLogs]);

  const commandSearchActionItems = useMemo<V2CommandSearchItem[]>(() => [
    {
      key: 'action-new-query',
      kind: 'action',
      title: t('query.new'),
      meta: t('sidebar.command_search.action.new_query.meta'),
      shortcut: resolveShortcutDisplay(shortcutOptions, 'newQueryTab', activeShortcutPlatform),
      icon: <PlusOutlined />,
      onRun: () => window.dispatchEvent(new CustomEvent('gonavi:create-query-tab')),
    },
    {
      key: 'action-new-connection',
      kind: 'action',
      title: t('sidebar.command_search.action.new_connection.title'),
      meta: t('sidebar.command_search.action.new_connection.meta'),
      shortcut: resolveShortcutDisplay(shortcutOptions, 'newConnection', activeShortcutPlatform),
      icon: <ThunderboltOutlined />,
      onRun: () => onCreateConnection?.(),
    },
    {
      key: 'action-open-ai',
      kind: 'action',
      title: t('sidebar.command_search.action.open_ai.title'),
      meta: t('sidebar.command_search.action.open_ai.meta'),
      shortcut: resolveShortcutDisplay(shortcutOptions, 'toggleAIPanel', activeShortcutPlatform),
      icon: <RobotOutlined />,
      onRun: () => onToggleAI?.(),
    },
    {
      key: 'action-open-sql-log',
      kind: 'action',
      title: t('sidebar.command_search.action.open_sql_log.title'),
      meta: t('sidebar.command_search.action.open_sql_log.meta'),
      shortcut: resolveShortcutDisplay(shortcutOptions, 'toggleLogPanel', activeShortcutPlatform),
      icon: <BarsOutlined />,
      onRun: () => onToggleLogPanel?.(),
    },
  ], [activeShortcutPlatform, onCreateConnection, onToggleAI, onToggleLogPanel, shortcutOptions]);

  const v2CommandSearchQuery = useMemo(
    () => parseV2CommandSearchQuery(deferredV2CommandSearchValue),
    [deferredV2CommandSearchValue],
  );
  const normalizedV2CommandSearchValue = v2CommandSearchQuery.normalizedKeyword;
  const v2CommandSearchObjectMode = v2CommandSearchQuery.mode === 'object';
  const v2CommandSearchAiMode = v2CommandSearchQuery.mode === 'ai';
  const filteredCommandSearchTreeItems = useMemo(() => {
    return filterV2CommandSearchTreeItems(commandSearchTreeIndex, v2CommandSearchQuery);
  }, [commandSearchTreeIndex, v2CommandSearchQuery]);

  const filteredCommandSearchActionItems = useMemo(() => {
    if (v2CommandSearchObjectMode || v2CommandSearchAiMode) return [];
    if (!normalizedV2CommandSearchValue) return commandSearchActionItems;
    return commandSearchActionItems.filter((item) => {
      const haystack = `${item.title} ${item.meta}`.toLowerCase();
      return haystack.includes(normalizedV2CommandSearchValue);
    });
  }, [commandSearchActionItems, normalizedV2CommandSearchValue, v2CommandSearchAiMode, v2CommandSearchObjectMode]);

  const filteredCommandSearchRecentItems = useMemo(() => {
    if (v2CommandSearchObjectMode || v2CommandSearchAiMode) return [];
    if (!normalizedV2CommandSearchValue) return commandSearchRecentItems;
    return commandSearchRecentItems.filter((item) => {
      const haystack = `${item.title} ${item.meta}`.toLowerCase();
      return haystack.includes(normalizedV2CommandSearchValue);
    });
  }, [commandSearchRecentItems, normalizedV2CommandSearchValue, v2CommandSearchAiMode, v2CommandSearchObjectMode]);

  const commandSearchAiItem = useMemo<V2CommandSearchItem[]>(() => {
    if (!v2CommandSearchAiMode || !v2CommandSearchQuery.aiPrompt) return [];
    return [{
      key: 'action-ask-ai',
      kind: 'action',
      title: t('sidebar.command_search.action.ask_ai.title'),
      meta: v2CommandSearchQuery.aiPrompt,
      shortcut: '↵',
      icon: <RobotOutlined />,
      onRun: () => {
        const wasClosed = !useStore.getState().aiPanelVisible;
        if (wasClosed) setAIPanelVisible(true);
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', {
            detail: { prompt: v2CommandSearchQuery.aiPrompt },
          }));
        }, wasClosed ? 350 : 0);
      },
    }];
  }, [setAIPanelVisible, v2CommandSearchAiMode, v2CommandSearchQuery.aiPrompt]);

  const commandSearchFlatItems = useMemo(
    () => [
      ...commandSearchAiItem,
      ...filteredCommandSearchTreeItems,
      ...filteredCommandSearchActionItems,
      ...filteredCommandSearchRecentItems,
    ],
    [commandSearchAiItem, filteredCommandSearchActionItems, filteredCommandSearchRecentItems, filteredCommandSearchTreeItems],
  );

  useEffect(() => {
    setV2CommandActiveIndex(0);
  }, [setV2CommandActiveIndex, v2CommandSearchValue, commandSearchFlatItems.length]);

  const flattenConnectionNodes = useCallback((nodes: TreeNode[]): TreeNode[] => {
    const result: TreeNode[] = [];
    nodes.forEach((node) => {
      if (node.type === 'connection') {
        result.push(node);
      }
      if (node.children) {
        result.push(...flattenConnectionNodes(node.children));
      }
    });
    return result;
  }, []);

  const activeConnectionId = resolveV2ActiveConnectionId({
    activeContextConnectionId: activeContext?.connectionId,
    activeTabConnectionId: activeTab?.connectionId,
    selectedKeys,
    connectionIds,
    fallbackConnectionId: selectedNodesRef.current
      .map((node) => resolveSidebarNodeConnectionId(node, connectionIds))
      .find(Boolean),
  });
  const activeConnection = connections.find((conn) => conn.id === activeConnectionId) || null;
  const activeConnectionDisplayName = String(activeConnection?.name || '').trim() || t('sidebar.active_connection.no_host_selected');
  const activeDatabaseDisplayName = useMemo(() => {
    if (activeContext && typeof activeContext === 'object' && 'dbName' in activeContext) {
      return String(activeContext.dbName || '').trim();
    }
    return String(activeTab?.dbName || '').trim();
  }, [activeContext, activeTab?.dbName]);
  const activeConnectionTreeData = useMemo(() => {
    const externalSQLNodes = displayTreeData.filter((node) => node.type === 'external-sql-root');
    if (!activeConnection) return displayTreeData;
    const activeConnectionNode = displayTreeData.find((node) => node.type === 'connection' && node.key === activeConnection.id);
    if (activeConnectionNode) {
      return dedupeSidebarTreeNodesByKey([
        ...(activeConnectionNode.children && activeConnectionNode.children.length > 0 ? activeConnectionNode.children : []),
        ...externalSQLNodes,
      ]);
    }
    const filterTree = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((node) => {
      if (node.type === 'tag') {
        return filterTree(node.children || []);
      }
      if (node.type === 'connection') {
        if (node.key !== activeConnection.id) return [];
        return node.children && node.children.length > 0 ? filterTree(node.children) : [];
      }
      return [{ ...node, children: node.children ? filterTree(node.children) : undefined }];
    });

    const filtered = filterTree(displayTreeData);
    return dedupeSidebarTreeNodesByKey([...filtered, ...externalSQLNodes]);
  }, [activeConnection, displayTreeData]);
  const v2VisibleTreeData = useMemo(() => {
    if (v2ExplorerFilter === 'all') {
      return displayTreeData;
    }
    return filterV2ExplorerTreeByKind(activeConnectionTreeData, v2ExplorerFilter);
  }, [activeConnectionTreeData, displayTreeData, v2ExplorerFilter]);
  const v2TreeHorizontalScrollWidth = useMemo(
    () => estimateV2TreeHorizontalScrollWidth(
      v2VisibleTreeData,
      treeViewportWidth,
      sidebarTableMetadataFields,
    ),
    [sidebarTableMetadataFields, treeViewportWidth, v2VisibleTreeData],
  );
  const effectiveTreeHeight = resolveSidebarTreeVirtualHeight(treeHeight, isV2Ui);
  const v2TreeMetrics = useMemo(() => {
    const databaseTableCounts = new Map<React.Key, number>();
    const objectGroupCounts = new Map<React.Key, number>();
    let activeObjectCount = 0;

    const visitAndCount = (node: TreeNode): number => {
      const childCount = (node.children || []).reduce((total, child) => total + visitAndCount(child), 0);
      const totalCount = (isV2SidebarObjectNode(node) ? 1 : 0) + childCount;
      if (node.type === 'database') {
        const tableCount = (node.children || []).reduce((total, child) => {
          if (child.type === 'object-group' && child?.dataRef?.groupKey === 'tables') {
            return total + (Array.isArray(child.children) ? child.children.filter((item) => item.type === 'table').length : 0);
          }
          if (child?.dataRef?.groupKey === 'schema' && Array.isArray(child.children)) {
            return total + child.children.reduce((schemaTotal, schemaChild) => {
              if (schemaChild.type === 'object-group' && schemaChild?.dataRef?.groupKey === 'tables') {
                return schemaTotal + (Array.isArray(schemaChild.children) ? schemaChild.children.filter((item) => item.type === 'table').length : 0);
              }
              return schemaTotal;
            }, 0);
          }
          return total;
        }, 0);
        databaseTableCounts.set(node.key, tableCount);
      } else if (node.type === 'message-namespace') {
        databaseTableCounts.set(node.key, childCount);
      } else if (node.type === 'object-group' || node.type === 'message-object-group') {
        objectGroupCounts.set(node.key, childCount);
      }
      return totalCount;
    };

    activeObjectCount = v2VisibleTreeData.reduce((total, node) => total + visitAndCount(node), 0);

    return {
      activeObjectCount,
      databaseTableCounts,
      objectGroupCounts,
    };
  }, [v2VisibleTreeData]);

  return {
    onSearch,
    toggleSearchScope,
    setSearchScopeChecked,
    searchScopeSummary,
    searchScopePopoverContent,
    displayTreeData,
    commandSearchTreeItems,
    commandSearchRecentItems,
    commandSearchActionItems,
    v2CommandSearchQuery,
    normalizedV2CommandSearchValue,
    v2CommandSearchObjectMode,
    v2CommandSearchAiMode,
    filteredCommandSearchTreeItems,
    filteredCommandSearchActionItems,
    filteredCommandSearchRecentItems,
    commandSearchAiItem,
    commandSearchFlatItems,
    flattenConnectionNodes,
    activeConnectionId,
    activeConnection,
    activeConnectionDisplayName,
    activeDatabaseDisplayName,
    activeConnectionTreeData,
    v2VisibleTreeData,
    v2TreeHorizontalScrollWidth,
    effectiveTreeHeight,
    v2TreeMetrics,
    activeConnectionObjectCount: v2TreeMetrics.activeObjectCount,
  };
};
