import React, { useEffect, useState } from 'react';
import { FolderOutlined } from '@ant-design/icons';
import { TreeSelect, type TreeSelectProps } from 'antd';

import { getDbIcon } from '../DatabaseIcons';
import type {
  DataSyncConnectionTreeItem,
  DataSyncEndpointRef,
  DataSyncSavedConnectionView,
} from './model';

const CONNECTION_VALUE_PREFIX = 'connection:';
const GROUP_VALUE_PREFIX = 'group:';

export type DataSyncConnectionTreeDataNode = {
  key: string;
  value: string;
  title: React.ReactNode;
  searchText: string;
  selectable?: boolean;
  disabled?: boolean;
  children?: DataSyncConnectionTreeDataNode[];
};

const BrowserSafeTreeSelect: React.FC<
  TreeSelectProps<string, DataSyncConnectionTreeDataNode>
> = (props) => {
  // rc-select requires DOM globals during layout effects. Keep non-browser
  // diagnostics renderable while Wails uses the complete Ant TreeSelect.
  if (typeof window === 'undefined' || typeof HTMLElement === 'undefined') {
    return React.createElement('gn-data-sync-tree-select', props);
  }
  return <TreeSelect<string, DataSyncConnectionTreeDataNode> {...props} />;
};

const connectionValue = (connectionId: string): string =>
  `${CONNECTION_VALUE_PREFIX}${connectionId}`;

const groupValue = (groupId: string): string =>
  `${GROUP_VALUE_PREFIX}${groupId}`;

const ConnectionTitle: React.FC<{
  connection: DataSyncSavedConnectionView;
}> = ({ connection }) => (
  <span
    className="gn-data-sync-connection-tree-node"
    data-node-kind="connection"
  >
    <span
      className="gn-data-sync-connection-tree-node__icon"
      aria-hidden="true"
    >
      {getDbIcon(connection.type, undefined, 16)}
    </span>
    <span className="gn-data-sync-connection-tree-node__name">
      {connection.name}
    </span>
    <span className="gn-data-sync-connection-tree-node__type">
      {connection.type}
    </span>
  </span>
);

const GroupTitle: React.FC<{ name: string }> = ({ name }) => (
  <span className="gn-data-sync-connection-tree-node" data-node-kind="group">
    <FolderOutlined
      className="gn-data-sync-connection-tree-node__folder"
      aria-hidden="true"
    />
    <span className="gn-data-sync-connection-tree-node__name">{name}</span>
  </span>
);

export const buildDataSyncConnectionTreeData = (
  layout: DataSyncConnectionTreeItem[],
  visibleConnections: DataSyncSavedConnectionView[],
  disabledConnectionIds: ReadonlySet<string> = new Set(),
): DataSyncConnectionTreeDataNode[] => {
  const connectionById = new Map(
    visibleConnections.map((connection) => [connection.id, connection]),
  );
  const includedConnectionIds = new Set<string>();

  const buildItem = (
    item: DataSyncConnectionTreeItem,
  ): DataSyncConnectionTreeDataNode | null => {
    if (item.kind === 'connection') {
      const connection = connectionById.get(item.connectionId);
      if (!connection || includedConnectionIds.has(connection.id)) return null;
      includedConnectionIds.add(connection.id);
      return {
        key: connectionValue(connection.id),
        value: connectionValue(connection.id),
        title: <ConnectionTitle connection={connection} />,
        searchText: `${connection.name} ${connection.type}`.toLocaleLowerCase(),
        disabled: disabledConnectionIds.has(connection.id),
      };
    }

    const children = item.children
      .map(buildItem)
      .filter((child): child is DataSyncConnectionTreeDataNode =>
        Boolean(child),
      );
    if (children.length === 0) return null;
    return {
      key: groupValue(item.id),
      value: groupValue(item.id),
      title: <GroupTitle name={item.name} />,
      searchText: item.name.toLocaleLowerCase(),
      selectable: false,
      children,
    };
  };

  const treeData = layout
    .map(buildItem)
    .filter((item): item is DataSyncConnectionTreeDataNode => Boolean(item));

  visibleConnections.forEach((connection) => {
    if (includedConnectionIds.has(connection.id)) return;
    treeData.push({
      key: connectionValue(connection.id),
      value: connectionValue(connection.id),
      title: <ConnectionTitle connection={connection} />,
      searchText: `${connection.name} ${connection.type}`.toLocaleLowerCase(),
      disabled: disabledConnectionIds.has(connection.id),
    });
  });
  return treeData;
};

const defaultExpandedGroupValues = (
  treeData: DataSyncConnectionTreeDataNode[],
  selectedValue: string,
): string[] => {
  const expanded = new Set<string>();

  const containsSelected = (node: DataSyncConnectionTreeDataNode): boolean => {
    if (node.value === selectedValue) return true;
    const contains = (node.children || []).some(containsSelected);
    if (contains && node.children) expanded.add(node.value);
    return contains;
  };

  treeData.forEach((node) => {
    containsSelected(node);
  });
  return Array.from(expanded);
};

const firstMatchingConnectionValue = (
  treeData: DataSyncConnectionTreeDataNode[],
  input: string,
): string | null => {
  const normalizedInput = input.trim().toLocaleLowerCase();
  if (!normalizedInput) return null;

  for (const node of treeData) {
    if (node.children) {
      const childMatch = firstMatchingConnectionValue(
        node.children,
        normalizedInput,
      );
      if (childMatch) return childMatch;
      continue;
    }
    if (!node.disabled && node.searchText.includes(normalizedInput)) {
      return node.value;
    }
  }
  return null;
};

export const DataSyncConnectionTreeSelect: React.FC<{
  role: 'source' | 'target';
  endpoint: DataSyncEndpointRef;
  connections: DataSyncSavedConnectionView[];
  connectionTree: DataSyncConnectionTreeItem[];
  loading: boolean;
  placeholder: string;
  emptyText: string;
  onChange: (connection: DataSyncSavedConnectionView | null) => void;
}> = ({
  role,
  endpoint,
  connections,
  connectionTree,
  loading,
  placeholder,
  emptyText,
  onChange,
}) => {
  const selectableConnections = connections.filter((connection) =>
    role === 'source' ? connection.readable : connection.writable,
  );
  const currentConnection = connections.find(
    (connection) => connection.id === endpoint.connectionId,
  );
  const currentConnectionSelectable = selectableConnections.some(
    (connection) => connection.id === endpoint.connectionId,
  );
  const fallbackCurrentConnection =
    endpoint.connectionId && !currentConnection
      ? {
          id: endpoint.connectionId,
          name: endpoint.connectionName || endpoint.connectionId,
          type: endpoint.type,
          readable: false,
          writable: false,
        }
      : null;
  const visibleConnections = currentConnectionSelectable
    ? selectableConnections
    : [
        ...(currentConnection
          ? [currentConnection]
          : fallbackCurrentConnection
            ? [fallbackCurrentConnection]
            : []),
        ...selectableConnections,
      ];
  const treeData = buildDataSyncConnectionTreeData(
    connectionTree,
    visibleConnections,
    !currentConnectionSelectable && endpoint.connectionId
      ? new Set([endpoint.connectionId])
      : undefined,
  );
  const selectedValue = endpoint.connectionId
    ? connectionValue(endpoint.connectionId)
    : undefined;
  const selectedExpandedGroupValues = defaultExpandedGroupValues(
    treeData,
    selectedValue || '',
  );
  const selectedExpandedGroupSignature =
    selectedExpandedGroupValues.join('\u0000');
  const [expandedGroupValues, setExpandedGroupValues] = useState<string[]>(
    selectedExpandedGroupValues,
  );
  const [searchValue, setSearchValue] = useState('');

  useEffect(() => {
    setExpandedGroupValues(selectedExpandedGroupValues);
  }, [selectedValue, selectedExpandedGroupSignature]);

  return (
    <BrowserSafeTreeSelect
      className="gn-data-sync-connection-tree-select"
      classNames={{ popup: { root: 'gn-data-sync-connection-tree-popup' } }}
      data-endpoint-control="connection"
      value={selectedValue}
      placeholder={placeholder}
      disabled={loading}
      allowClear={Boolean(endpoint.connectionId)}
      treeData={treeData}
      treeExpandedKeys={searchValue ? undefined : expandedGroupValues}
      onTreeExpand={(expandedKeys) => {
        if (!searchValue) setExpandedGroupValues(expandedKeys.map(String));
      }}
      treeExpandAction="click"
      showSearch
      treeNodeFilterProp="searchText"
      searchValue={searchValue}
      onSearch={setSearchValue}
      filterTreeNode={(input, node) =>
        Boolean(input.trim()) &&
        node.searchText.includes(input.trim().toLocaleLowerCase())
      }
      notFoundContent={emptyText}
      onInputKeyDown={(event) => {
        if (event.key !== 'Enter' || !searchValue) return;
        const match = firstMatchingConnectionValue(treeData, searchValue);
        if (!match?.startsWith(CONNECTION_VALUE_PREFIX)) return;
        const connectionId = match.slice(CONNECTION_VALUE_PREFIX.length);
        const selected = connections.find(
          (connection) => connection.id === connectionId,
        );
        const selectable =
          selected &&
          (role === 'source' ? selected.readable : selected.writable);
        if (!selectable) return;

        event.preventDefault();
        event.stopPropagation();
        setSearchValue('');
        event.currentTarget.blur();
        onChange(selected);
      }}
      onChange={(value) => {
        if (!value) {
          setSearchValue('');
          onChange(null);
          return;
        }
        if (!value.startsWith(CONNECTION_VALUE_PREFIX)) return;
        const connectionId = value.slice(CONNECTION_VALUE_PREFIX.length);
        const selected = connections.find(
          (connection) => connection.id === connectionId,
        );
        const selectable =
          selected &&
          (role === 'source' ? selected.readable : selected.writable);
        if (selectable) onChange(selected);
      }}
    />
  );
};
