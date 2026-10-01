import React from 'react';
import { Tooltip } from 'antd';

import { t } from '../../i18n';
import { isRedisConnection } from './redisSidebarOverview';
import {
  resolveExplorerFilterFamily,
  V2_EXPLORER_FILTER_LABEL_KEYS,
  V2_EXPLORER_FILTER_ORDER,
  type V2ExplorerFilter,
} from './sidebarExplorerFilter';
import RedisSidebarOverviewBar from './RedisSidebarOverviewBar';
import { renderSidebarObjectIcon } from './sidebarObjectIcons';

type SidebarFilterSlotProps = {
  /** The active connection, used to decide what (if anything) this slot carries. */
  activeConnection: { id?: unknown; config?: any } | null | undefined;
  /** The sidebar tree; the Redis summary reads its connection children out of it. */
  treeData: ReadonlyArray<any> | null | undefined;
  /** True when any connection in the sidebar supports relational object-kind filters. */
  hasRelationalFilterConnection: boolean;
  activeFilter: V2ExplorerFilter;
  onFilterChange: (filter: V2ExplorerFilter) => void;
};

const V2_EXPLORER_FILTER_ICONS: Record<V2ExplorerFilter, React.ReactNode> = {
  all: renderSidebarObjectIcon('all'),
  tables: renderSidebarObjectIcon('table'),
  views: renderSidebarObjectIcon('view'),
  sequences: renderSidebarObjectIcon('sequence'),
  routines: renderSidebarObjectIcon('routine'),
  packages: renderSidebarObjectIcon('package'),
  events: renderSidebarObjectIcon('event'),
  // A Nacos workbench filters between its two explorer branches, so the icons echo
  // those rather than reusing the relational ones.
  'nacos-services': renderSidebarObjectIcon('nacosService'),
  'nacos-configs': renderSidebarObjectIcon('nacosConfig'),
};

/**
 * The fixed-height strip between the sidebar toolbar and the tree.
 *
 * It exists so switching connections never moves the tree's vertical origin: the
 * slot keeps its height even when it has no buttons to show. Three contents live
 * here — the relational object-kind tabs, a dedicated workbench's own tabs (Nacos
 * filters between its service and config explorers), or the Redis key summary.
 *
 * Extracted out of Sidebar.tsx, which is far past the repo's size limit and must
 * shrink rather than grow (AGENTS.md §1.1).
 */
const SidebarFilterSlot = React.memo(({
  activeConnection,
  treeData,
  hasRelationalFilterConnection,
  activeFilter,
  onFilterChange,
}: SidebarFilterSlotProps) => {
  // Derived here rather than passed in, so the slot and the reset hook cannot
  // disagree about which family is active — a disagreement is what lets a stale
  // filter empty the tree.
  const family = resolveExplorerFilterFamily(activeConnection);
  const options = family ? V2_EXPLORER_FILTER_ORDER[family] : [];
  // With no host selected the slot still previews the relational tabs, matching
  // the behaviour it had before dedicated workbenches existed.
  const showTabs = options.length > 0 || (!activeConnection && hasRelationalFilterConnection);
  const effectiveOptions = options.length > 0 ? options : V2_EXPLORER_FILTER_ORDER.relational;

  if (!hasRelationalFilterConnection && !isRedisConnection(activeConnection) && !family) {
    return null;
  }

  return (
    <div
      className="gn-v2-explorer-filter-slot"
      data-object-kind-filter-slot="true"
      data-object-kind-filter-visible={showTabs ? 'true' : 'false'}
    >
      <RedisSidebarOverviewBar connection={activeConnection} treeData={treeData} />
      {showTabs && (
        <div className="gn-v2-explorer-filter-tabs" aria-label={t('sidebar.command_search.object_kind.filter_aria')}>
          {effectiveOptions.map((key) => {
            const label = t(V2_EXPLORER_FILTER_LABEL_KEYS[key]);
            return (
              <Tooltip key={key} title={label} mouseEnterDelay={0.25}>
                <button
                  type="button"
                  className={activeFilter === key ? 'is-active' : undefined}
                  aria-label={label}
                  aria-pressed={activeFilter === key}
                  data-object-kind-filter={key}
                  onClick={() => onFilterChange(key)}
                >
                  {V2_EXPLORER_FILTER_ICONS[key]}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
});

SidebarFilterSlot.displayName = 'SidebarFilterSlot';

export default SidebarFilterSlot;
