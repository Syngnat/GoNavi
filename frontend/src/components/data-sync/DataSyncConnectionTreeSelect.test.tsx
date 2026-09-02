import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  DataSyncConnectionTreeSelect,
  type DataSyncConnectionTreeDataNode,
} from './DataSyncConnectionTreeSelect';
import type {
  DataSyncConnectionTreeItem,
  DataSyncEndpointRef,
  DataSyncSavedConnectionView,
} from './model';

const EMPTY_ENDPOINT: DataSyncEndpointRef = {
  connectionId: '',
  connectionName: '',
  type: '',
  database: '',
  schema: '',
};

const CONNECTIONS: DataSyncSavedConnectionView[] = [
  {
    id: 'elastic',
    name: 'Elasticsearch',
    type: 'elasticsearch',
    readable: true,
    writable: false,
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    type: 'sqlserver',
    readable: true,
    writable: true,
  },
  {
    id: 'target-only',
    name: 'Target only',
    type: 'postgresql',
    readable: false,
    writable: true,
  },
  {
    id: 'sqlite',
    name: 'SQLite DB',
    type: 'sqlite',
    readable: true,
    writable: true,
  },
  {
    id: 'hidden',
    name: 'Hidden host',
    type: 'mysql',
    readable: false,
    writable: false,
  },
];

const CONNECTION_TREE: DataSyncConnectionTreeItem[] = [
  {
    kind: 'group',
    id: 'bero',
    name: 'BeroHost-测试',
    children: [
      { kind: 'connection', connectionId: 'elastic' },
      {
        kind: 'group',
        id: 'databases',
        name: 'Databases',
        children: [
          { kind: 'connection', connectionId: 'sqlserver' },
          { kind: 'connection', connectionId: 'target-only' },
        ],
      },
    ],
  },
  { kind: 'connection', connectionId: 'sqlite' },
  {
    kind: 'group',
    id: 'empty-after-filter',
    name: 'Hidden group',
    children: [{ kind: 'connection', connectionId: 'hidden' }],
  },
];

const outline = (nodes: DataSyncConnectionTreeDataNode[]): unknown[] =>
  nodes.map((node) =>
    node.children
      ? {
          value: node.value,
          selectable: node.selectable,
          children: outline(node.children),
        }
      : node.value,
  );

const renderControl = (
  role: 'source' | 'target',
  endpoint: DataSyncEndpointRef = EMPTY_ENDPOINT,
  onChange = vi.fn(),
) => {
  const renderer = TestRenderer.create(
    <DataSyncConnectionTreeSelect
      role={role}
      endpoint={endpoint}
      connections={CONNECTIONS}
      connectionTree={CONNECTION_TREE}
      loading={false}
      placeholder="Choose a connection"
      emptyText="No eligible connections"
      onChange={onChange}
    />,
  );
  return {
    renderer,
    control: renderer.root.findByProps({
      'data-endpoint-control': 'connection',
    }),
  };
};

describe('DataSyncConnectionTreeSelect', () => {
  it('keeps nested sidebar groups and ungrouped hosts while filtering each role', () => {
    const source = renderControl('source').control;
    const target = renderControl('target').control;

    expect(outline(source.props.treeData)).toEqual([
      {
        value: 'group:bero',
        selectable: false,
        children: [
          'connection:elastic',
          {
            value: 'group:databases',
            selectable: false,
            children: ['connection:sqlserver'],
          },
        ],
      },
      'connection:sqlite',
    ]);
    expect(outline(target.props.treeData)).toEqual([
      {
        value: 'group:bero',
        selectable: false,
        children: [
          {
            value: 'group:databases',
            selectable: false,
            children: ['connection:sqlserver', 'connection:target-only'],
          },
        ],
      },
      'connection:sqlite',
    ]);
  });

  it('keeps the selected ineligible host visible and only selects connection leaves', () => {
    const onChange = vi.fn();
    const { renderer, control } = renderControl(
      'target',
      {
        connectionId: 'elastic',
        connectionName: 'Elasticsearch',
        type: 'elasticsearch',
        database: 'remembered-index',
        schema: '',
      },
      onChange,
    );
    const currentControl = () =>
      renderer.root.findByProps({
        'data-endpoint-control': 'connection',
      });
    const group = control.props.treeData[0] as DataSyncConnectionTreeDataNode;
    const selectedLeaf = group.children![0];

    expect(control.props.value).toBe('connection:elastic');
    expect(control.props.showSearch).toBe(true);
    expect(control.props.treeNodeFilterProp).toBe('searchText');
    expect(control.props.treeExpandedKeys).toEqual(['group:bero']);
    expect(outline(control.props.treeData)).toEqual([
      {
        value: 'group:bero',
        selectable: false,
        children: [
          'connection:elastic',
          {
            value: 'group:databases',
            selectable: false,
            children: ['connection:sqlserver', 'connection:target-only'],
          },
        ],
      },
      'connection:sqlite',
    ]);
    expect(selectedLeaf.disabled).toBe(true);
    expect(control.props.filterTreeNode('bero', group)).toBe(true);
    expect(control.props.filterTreeNode('ELASTICSEARCH', selectedLeaf)).toBe(
      true,
    );

    act(() => control.props.onSearch('elastic'));
    expect(currentControl().props.treeExpandedKeys).toBeUndefined();
    act(() => currentControl().props.onSearch(''));
    expect(currentControl().props.treeExpandedKeys).toEqual(['group:bero']);

    act(() => control.props.onChange('group:bero'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => control.props.onChange('connection:elastic'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => control.props.onChange('connection:sqlserver'));
    expect(onChange).toHaveBeenCalledWith(CONNECTIONS[1]);
  });

  it('expands the selected connection ancestors after tree layout arrives', () => {
    const endpoint: DataSyncEndpointRef = {
      connectionId: 'target-only',
      connectionName: 'Target only',
      type: 'postgresql',
      database: '',
      schema: '',
    };
    const props = {
      role: 'target' as const,
      endpoint,
      connections: CONNECTIONS,
      loading: false,
      placeholder: 'Choose a connection',
      emptyText: 'No eligible connections',
      onChange: vi.fn(),
    };
    const renderer = TestRenderer.create(
      <DataSyncConnectionTreeSelect {...props} connectionTree={[]} />,
    );
    const findControl = () =>
      renderer.root.findByProps({
        'data-endpoint-control': 'connection',
      });

    expect(findControl().props.treeExpandedKeys).toEqual([]);

    act(() => {
      renderer.update(
        <DataSyncConnectionTreeSelect
          {...props}
          connectionTree={CONNECTION_TREE}
        />,
      );
    });

    expect(findControl().props.treeExpandedKeys).toEqual([
      'group:databases',
      'group:bero',
    ]);
  });

  it('selects the first eligible grouped search result when Enter is pressed', () => {
    const onChange = vi.fn();
    const { renderer, control } = renderControl(
      'source',
      EMPTY_ENDPOINT,
      onChange,
    );
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const blur = vi.fn();

    act(() => control.props.onSearch('sql server'));
    act(() =>
      renderer.root
        .findByProps({
          'data-endpoint-control': 'connection',
        })
        .props.onInputKeyDown({
          key: 'Enter',
          preventDefault,
          stopPropagation,
          currentTarget: { blur },
        }),
    );

    expect(onChange).toHaveBeenCalledWith(CONNECTIONS[1]);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
  });
});
