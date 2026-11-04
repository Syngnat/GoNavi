import React, { useEffect } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import { PluginPageHost } from '../pluginPages/PluginPageHost';
import { subscribePluginContributionInvalidation } from '../plugins/invalidation';
import { usePluginViewStore } from './store';
import './pluginViewDock.css';

/**
 * Right-hand dock for pages declared through `contributes.views`. A view keeps
 * the page bridge and its permissions; the host owns the dock chrome and the
 * lifetime of the entry.
 */
export const PluginViewDock = () => {
  const views = usePluginViewStore((state) => state.views);
  const activeKey = usePluginViewStore((state) => state.activeKey);
  const activate = usePluginViewStore((state) => state.activate);
  const close = usePluginViewStore((state) => state.close);
  const removePlugin = usePluginViewStore((state) => state.removePlugin);
  const closeAll = usePluginViewStore((state) => state.closeAll);

  useEffect(() => subscribePluginContributionInvalidation((event) => {
    if (event.reason === 'root') closeAll();
    else if (event.pluginId) removePlugin(event.pluginId);
  }), [closeAll, removePlugin]);

  if (views.length === 0) return null;
  const active = views.find((view) => view.key === activeKey) ?? views[0];

  return (
    <aside className="gn-plugin-view-dock" data-plugin-view-dock="true" aria-label={active.title}>
      <header className="gn-plugin-view-dock-head">
        <div className="gn-plugin-view-dock-tabs" role="tablist">
          {views.map((view) => (
            <button
              key={view.key}
              type="button"
              role="tab"
              aria-selected={view.key === active.key}
              className={`gn-plugin-view-dock-tab${view.key === active.key ? ' is-active' : ''}`}
              title={view.title}
              onClick={() => activate(view.key)}
            >
              {view.title}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="gn-plugin-view-dock-close"
          aria-label={active.title}
          title={active.title}
          onClick={() => close(active.key)}
        >
          <CloseOutlined />
        </button>
      </header>
      <div className="gn-plugin-view-dock-body">
        <PluginPageHost
          key={active.key + ':' + active.pageID}
          pluginID={active.pluginID}
          pageID={active.pageID}
          launch={active.launch}
        />
      </div>
    </aside>
  );
};

export default PluginViewDock;
