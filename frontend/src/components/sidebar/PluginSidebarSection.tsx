import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaretDownOutlined, CaretRightOutlined, ReloadOutlined } from '@ant-design/icons';
import { pluginAPI } from '../../plugins/api';
import { pluginErrorText } from '../../plugins/apiResult';
import { subscribePluginContributionInvalidation } from '../../plugins/invalidation';
import { openPluginPageTab } from '../../pluginPages/openPluginPageTab';
import { openPluginView } from '../../pluginViews/store';
import { loadPluginSidebarNodes, openPluginSidebarWindow, type PluginSidebarNode } from '../../plugins/sidebarApi';
import { t } from '../../i18n';
import type { PluginSidebarGroup, PluginStatus } from '../../plugins/types';
import './PluginSidebarSection.css';

// One bounded node tree per declared group, cached briefly; plugin changes clear it.
const CACHE_MS = 30_000;

interface GroupState {
  loading: boolean;
  error: string;
  items: PluginSidebarNode[];
  fetchedAt: number;
}

interface GroupEntry {
  plugin: PluginStatus;
  group: PluginSidebarGroup;
  key: string;
}

/**
 * Renders `contributes.sidebar` groups above the connection tree. The host owns
 * rendering and launch; node data only ever comes from the plugin's listCommand
 * and is validated again by the backend before it reaches this component.
 */
export function PluginSidebarSection({ darkMode }: { darkMode: boolean }) {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [nodeExpanded, setNodeExpanded] = useState<Record<string, boolean>>({});
  const [groups, setGroups] = useState<Record<string, GroupState>>({});
  const alive = useRef(false);
  const cache = useRef(new Map<string, GroupState>());

  const refresh = useCallback(async () => {
    try {
      const [items, runtime] = await Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]);
      if (!alive.current) return;
      const allowed = !runtime.safeMode && runtime.managementAllowed;
      setPlugins(allowed ? items.filter((plugin) => plugin.desiredEnabled && plugin.state === 'running'
        && (plugin.manifest.contributes?.sidebar?.length ?? 0) > 0) : []);
    } catch {
      if (alive.current) setPlugins([]);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = subscribePluginContributionInvalidation(() => {
      cache.current.clear();
      void refresh();
    });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const entries = useMemo<GroupEntry[]>(() => {
    const list: GroupEntry[] = [];
    for (const plugin of plugins) {
      for (const group of plugin.manifest.contributes?.sidebar ?? []) {
        list.push({ plugin, group, key: plugin.manifest.id + ':' + group.id });
      }
    }
    return list.sort((left, right) =>
      (left.group.order ?? 0) - (right.group.order ?? 0) || left.key.localeCompare(right.key));
  }, [plugins]);

  const load = useCallback(async (pluginID: string, groupID: string, force: boolean) => {
    const key = pluginID + ':' + groupID;
    const cached = cache.current.get(key);
    if (!force && cached && !cached.error && Date.now() - cached.fetchedAt < CACHE_MS) return;
    setGroups((prev) => ({
      ...prev,
      [key]: { loading: true, error: '', items: prev[key]?.items ?? [], fetchedAt: prev[key]?.fetchedAt ?? 0 },
    }));
    try {
      const items = await loadPluginSidebarNodes(pluginID, groupID);
      if (!alive.current) return;
      const next: GroupState = { loading: false, error: '', items, fetchedAt: Date.now() };
      cache.current.set(key, next);
      setGroups((prev) => ({ ...prev, [key]: next }));
    } catch (cause) {
      if (!alive.current) return;
      const next: GroupState = { loading: false, error: pluginErrorText(cause), items: [], fetchedAt: Date.now() };
      cache.current.set(key, next);
      setGroups((prev) => ({ ...prev, [key]: next }));
    }
  }, []);

  const toggleGroup = (entry: GroupEntry) => {
    const open = !expanded[entry.key];
    setExpanded((prev) => ({ ...prev, [entry.key]: open }));
    if (open) void load(entry.plugin.manifest.id, entry.group.id, false);
  };

  const openNode = (entry: GroupEntry, node: PluginSidebarNode) => {
    const target = node.open ?? entry.group.open;
    if (!target) return;
    const args = node.open?.arguments;
    if (target.type === 'panel') {
      const view = entry.plugin.manifest.contributes?.views?.find((candidate) => candidate.id === target.view);
      if (!view) return;
      openPluginView({
        key: entry.plugin.manifest.id + ':' + view.id,
        pluginID: entry.plugin.manifest.id,
        viewID: view.id,
        pageID: view.page,
        title: node.label || view.title,
        launch: {
          kind: 'sidebar',
          pluginId: entry.plugin.manifest.id,
          groupId: entry.group.id,
          nodeId: node.id,
          arguments: args,
        },
      });
      return;
    }
    if (target.type === 'page') {
      if (!target.page) return;
      openPluginPageTab({
        pluginID: entry.plugin.manifest.id,
        pageID: target.page,
        title: node.label,
        instanceKey: entry.group.id + ':' + node.id,
        launch: {
          kind: 'sidebar',
          pluginId: entry.plugin.manifest.id,
          groupId: entry.group.id,
          nodeId: node.id,
          arguments: args,
        },
      });
      return;
    }
    void openPluginSidebarWindow(entry.plugin.manifest.id, entry.group.id, node.id, args).catch(() => {});
  };

  const renderNodes = (entry: GroupEntry, nodes: PluginSidebarNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const key = entry.key + ':' + node.id;
      const hasChildren = (node.children?.length ?? 0) > 0;
      const isOpen = nodeExpanded[key] === true;
      const hasTarget = Boolean(node.open ?? entry.group.open);
      return (
        <div key={key}>
          <button
            type="button"
            className="gn-plugin-sidebar-row"
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => {
              if (hasChildren) setNodeExpanded((prev) => ({ ...prev, [key]: !isOpen }));
              else if (hasTarget) openNode(entry, node);
            }}
            disabled={!hasChildren && !hasTarget}
            title={node.description || node.label}
          >
            <span className="gn-plugin-sidebar-caret" aria-hidden="true">
              {hasChildren ? (isOpen ? <CaretDownOutlined /> : <CaretRightOutlined />) : null}
            </span>
            <span className="gn-plugin-sidebar-label">{node.label}</span>
            {node.description && <span className="gn-plugin-sidebar-desc">{node.description}</span>}
            {node.badge && <span className="gn-plugin-sidebar-badge">{node.badge}</span>}
          </button>
          {hasChildren && isOpen && renderNodes(entry, node.children ?? [], depth + 1)}
        </div>
      );
    });

  if (entries.length === 0) return null;

  return (
    <div className={`gn-plugin-sidebar${darkMode ? ' is-dark' : ''}`} data-plugin-sidebar="true">
      {entries.map((entry) => {
        const state = groups[entry.key];
        const isOpen = expanded[entry.key] === true;
        return (
          <section key={entry.key} className="gn-plugin-sidebar-group">
            <button
              type="button"
              className="gn-plugin-sidebar-group-title"
              onClick={() => toggleGroup(entry)}
              aria-expanded={isOpen}
            >
              <span className="gn-plugin-sidebar-caret" aria-hidden="true">
                {isOpen ? <CaretDownOutlined /> : <CaretRightOutlined />}
              </span>
              <span className="gn-plugin-sidebar-label">{entry.group.title}</span>
              {state?.loading && <span className="gn-plugin-sidebar-meta">{t('common.loading')}</span>}
            </button>
            {isOpen && (
              <div className="gn-plugin-sidebar-body">
                {state?.error ? (
                  <div className="gn-plugin-sidebar-error">
                    <span className="gn-plugin-sidebar-error-text">{state.error}</span>
                    <button
                      type="button"
                      className="gn-plugin-sidebar-retry"
                      onClick={() => void load(entry.plugin.manifest.id, entry.group.id, true)}
                      aria-label={t('common.retry')}
                      title={t('common.retry')}
                    >
                      <ReloadOutlined />
                    </button>
                  </div>
                ) : (state?.items.length ?? 0) === 0 ? (
                  <div className="gn-plugin-sidebar-empty">{entry.group.emptyText || '—'}</div>
                ) : (
                  renderNodes(entry, state?.items ?? [], 0)
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
