import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import {
  buildBatchConnectionTreeLayout,
  toBatchConnectionViews,
} from '../BatchConnectionTreeSelect';
import {
  BrowserSafeTreeSelect,
  buildDataSyncConnectionTreeData,
  defaultExpandedGroupValues,
  firstMatchingConnectionValue,
} from '../data-sync/DataSyncConnectionTreeSelect';
import '../data-sync/DataSyncWorkbench.css';

const CONNECTION_VALUE_PREFIX = 'connection:';

export interface SessionConnectionSelectProps {
  connections: SavedConnection[];
  value: string;
  onChange: (connectionId: string) => void;
}

/**
 * Connection picker that mirrors the sidebar's group tree (same groups, order
 * and icons), so a host is found the same way it is in the left-hand tree.
 */
export default function SessionConnectionSelect({
  connections,
  value,
  onChange,
}: SessionConnectionSelectProps) {
  const { t } = useI18n();
  const connectionTags = useStore((state) => state.connectionTags);
  const sidebarRootOrder = useStore((state) => state.sidebarRootOrder);
  const rootSortMode = useStore((state) => state.rootSortMode);
  const rootConnectionSortMode = useStore((state) => state.rootConnectionSortMode);

  const treeData = useMemo(
    () => buildDataSyncConnectionTreeData(
      buildBatchConnectionTreeLayout({
        connections,
        connectionTags,
        sidebarRootOrder,
        rootSortMode,
        rootConnectionSortMode,
      }),
      toBatchConnectionViews(connections),
    ),
    [connectionTags, connections, rootConnectionSortMode, rootSortMode, sidebarRootOrder],
  );
  const selectedValue = value ? `${CONNECTION_VALUE_PREFIX}${value}` : undefined;
  // Groups holding the current host start expanded, like the sidebar does.
  const selectedGroups = useMemo(
    () => defaultExpandedGroupValues(treeData, selectedValue || ''),
    [selectedValue, treeData],
  );
  const selectedGroupsSignature = selectedGroups.join('\u0000');
  const [expandedGroups, setExpandedGroups] = useState<string[]>(selectedGroups);
  const [searchValue, setSearchValue] = useState('');

  useEffect(() => {
    setExpandedGroups(selectedGroups);
    // The signature is the stable identity of `selectedGroups`.
  }, [selectedGroupsSignature]);

  const commit = (nodeValue: string): boolean => {
    if (!nodeValue.startsWith(CONNECTION_VALUE_PREFIX)) return false;
    const connectionId = nodeValue.slice(CONNECTION_VALUE_PREFIX.length);
    if (!connections.some((connection) => connection.id === connectionId)) return false;
    setSearchValue('');
    onChange(connectionId);
    return true;
  };

  return (
    <BrowserSafeTreeSelect
      className="gn-data-sync-connection-tree-select gn-session-workbench-connection-select"
      classNames={{ popup: { root: 'gn-data-sync-connection-tree-popup' } }}
      aria-label={t('session_workbench.connection.label')}
      value={selectedValue}
      placeholder={t('session_workbench.connection.placeholder')}
      treeData={treeData}
      treeExpandedKeys={searchValue ? undefined : expandedGroups}
      onTreeExpand={(expandedKeys) => {
        if (!searchValue) setExpandedGroups(expandedKeys.map(String));
      }}
      treeExpandAction="click"
      listHeight={320}
      popupMatchSelectWidth
      showSearch
      treeNodeFilterProp="searchText"
      searchValue={searchValue}
      onSearch={setSearchValue}
      filterTreeNode={(input, node) => (
        Boolean(input.trim()) && node.searchText.includes(input.trim().toLocaleLowerCase())
      )}
      notFoundContent={t('session_workbench.connection.empty')}
      onInputKeyDown={(event) => {
        if (event.key !== 'Enter' || !searchValue) return;
        const match = firstMatchingConnectionValue(treeData, searchValue);
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.blur();
        commit(match);
      }}
      onChange={(next) => {
        if (next) commit(next);
      }}
    />
  );
}
