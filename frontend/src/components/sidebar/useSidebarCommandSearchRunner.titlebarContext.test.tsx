import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { V2CommandSearchItem } from '../sidebarV2Utils';
import { useSidebarCommandSearchRunner } from './useSidebarCommandSearchRunner';

describe('useSidebarCommandSearchRunner title bar context', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('keeps the selected sequence name when command search does not open a tab', () => {
    const setActiveContext = vi.fn();
    let runCommandSearchItem: ReturnType<typeof useSidebarCommandSearchRunner>['runCommandSearchItem'] | undefined;
    const sequenceNode = {
      key: 'conn-1-main-sequence-order_id_seq',
      title: 'order_id_seq',
      type: 'sequence' as const,
      dataRef: {
        id: 'conn-1',
        dbName: 'main',
        sequenceName: 'order_id_seq',
      },
    };
    const item: V2CommandSearchItem = {
      key: `node-${sequenceNode.key}`,
      kind: 'node',
      title: sequenceNode.title,
      meta: '序列',
      icon: null,
      node: sequenceNode,
    };

    const Harness = () => {
      ({ runCommandSearchItem } = useSidebarCommandSearchRunner({
        activeContext: null,
        activeTab: null,
        addTab: vi.fn(),
        clearStaleHostStateOnSelection: vi.fn(),
        closeV2CommandSearch: vi.fn(),
        commandSearchFlatItems: [],
        connectionIds: ['conn-1'],
        queryCapableConnectionIds: new Set(),
        findTreeNodeByKeyRef: { current: () => null },
        locateObjectInSidebar: vi.fn(),
        loadDatabases: vi.fn(),
        mergeExpandedTreeKeys: vi.fn(),
        onDoubleClick: vi.fn(),
        revealCommandSearchNode: vi.fn(),
        scrollSidebarTreeToKey: vi.fn(),
        selectedNodesRef: { current: [] },
        setActiveContext,
        setSelectedKeys: vi.fn(),
        setV2CommandActiveIndex: vi.fn(),
        treeDataRef: { current: [] },
        v2CommandActiveIndex: 0,
      }));
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    act(() => {
      runCommandSearchItem?.(item);
    });

    expect(setActiveContext).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'order_id_seq',
    });
  });

  it('clears a stale Host state before selecting a connection from the rail', async () => {
    const clearStaleHostStateOnSelection = vi.fn();
    const loadDatabases = vi.fn().mockResolvedValue(undefined);
    let runCommandSearchItem: ReturnType<typeof useSidebarCommandSearchRunner>['runCommandSearchItem'] | undefined;
    const connection = {
      id: 'conn-1',
      name: 'Local',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    } as any;
    const connectionNode = {
      key: connection.id,
      title: connection.name,
      type: 'connection' as const,
      dataRef: connection,
    };
    const item: V2CommandSearchItem = {
      key: 'connection-conn-1',
      kind: 'node',
      title: connection.name,
      meta: 'Host',
      icon: null,
      node: connectionNode,
    };

    const Harness = () => {
      ({ runCommandSearchItem } = useSidebarCommandSearchRunner({
        activeContext: null,
        activeTab: null,
        addTab: vi.fn(),
        clearStaleHostStateOnSelection,
        closeV2CommandSearch: vi.fn(),
        commandSearchFlatItems: [],
        connectionIds: ['conn-1'],
        queryCapableConnectionIds: new Set(),
        findTreeNodeByKeyRef: { current: () => connectionNode },
        locateObjectInSidebar: vi.fn(),
        loadDatabases,
        mergeExpandedTreeKeys: vi.fn(),
        onDoubleClick: vi.fn(),
        revealCommandSearchNode: vi.fn(),
        scrollSidebarTreeToKey: vi.fn(),
        selectedNodesRef: { current: [] },
        setActiveContext: vi.fn(),
        setSelectedKeys: vi.fn(),
        setV2CommandActiveIndex: vi.fn(),
        treeDataRef: { current: [connectionNode] },
        v2CommandActiveIndex: 0,
      }));
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      runCommandSearchItem?.(item);
      await Promise.resolve();
    });

    expect(clearStaleHostStateOnSelection).toHaveBeenCalledWith(connectionNode);
    expect(loadDatabases).toHaveBeenCalledWith(connectionNode);
    expect(clearStaleHostStateOnSelection.mock.invocationCallOrder[0])
      .toBeLessThan(loadDatabases.mock.invocationCallOrder[0]);
  });

  it('reveals and locates a table in the sidebar before opening it', () => {
    const revealCommandSearchNode = vi.fn();
    const locateObjectInSidebar = vi.fn().mockResolvedValue(undefined);
    const onDoubleClick = vi.fn();
    let runCommandSearchItem: ReturnType<typeof useSidebarCommandSearchRunner>['runCommandSearchItem'] | undefined;
    const tableNode = {
      key: 'conn-1-main-schema-public-tables-orders',
      title: 'orders',
      type: 'table' as const,
      dataRef: {
        id: 'conn-1',
        dbName: 'main',
        schemaName: 'public',
        tableName: 'orders',
      },
    };
    const item: V2CommandSearchItem = {
      key: `node-${tableNode.key}`,
      kind: 'node',
      title: tableNode.title,
      meta: 'Local · main',
      icon: null,
      node: tableNode,
    };

    const Harness = () => {
      ({ runCommandSearchItem } = useSidebarCommandSearchRunner({
        activeContext: null,
        activeTab: null,
        addTab: vi.fn(),
        clearStaleHostStateOnSelection: vi.fn(),
        closeV2CommandSearch: vi.fn(),
        commandSearchFlatItems: [],
        connectionIds: ['conn-1'],
        queryCapableConnectionIds: new Set(),
        findTreeNodeByKeyRef: { current: () => tableNode },
        locateObjectInSidebar,
        loadDatabases: vi.fn(),
        mergeExpandedTreeKeys: vi.fn(),
        onDoubleClick,
        revealCommandSearchNode,
        scrollSidebarTreeToKey: vi.fn(),
        selectedNodesRef: { current: [] },
        setActiveContext: vi.fn(),
        setSelectedKeys: vi.fn(),
        setV2CommandActiveIndex: vi.fn(),
        treeDataRef: { current: [tableNode] },
        v2CommandActiveIndex: 0,
      }));
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    act(() => {
      runCommandSearchItem?.(item);
    });

    expect(revealCommandSearchNode).toHaveBeenCalledWith(tableNode);
    expect(locateObjectInSidebar).toHaveBeenCalledWith({
      tabId: tableNode.key,
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'orders',
      schemaName: 'public',
      objectGroup: 'tables',
    });
    expect(onDoubleClick).toHaveBeenCalledWith(null, tableNode);
    expect(revealCommandSearchNode.mock.invocationCallOrder[0])
      .toBeLessThan(onDoubleClick.mock.invocationCallOrder[0]);
  });

  it('keeps the selected schema in the active context', () => {
    const setActiveContext = vi.fn();
    let runCommandSearchItem: ReturnType<typeof useSidebarCommandSearchRunner>['runCommandSearchItem'] | undefined;
    const schemaNode = {
      key: 'conn-1-main-schema-anno',
      title: 'anno',
      type: 'object-group' as const,
      dataRef: {
        id: 'conn-1',
        dbName: 'main',
        groupKey: 'schema',
        schemaName: 'anno',
      },
    };
    const item: V2CommandSearchItem = {
      key: `node-${schemaNode.key}`,
      kind: 'node',
      title: schemaNode.title,
      meta: 'Local · main',
      icon: null,
      node: schemaNode,
    };

    const Harness = () => {
      ({ runCommandSearchItem } = useSidebarCommandSearchRunner({
        activeContext: null,
        activeTab: null,
        addTab: vi.fn(),
        clearStaleHostStateOnSelection: vi.fn(),
        closeV2CommandSearch: vi.fn(),
        commandSearchFlatItems: [],
        connectionIds: ['conn-1'],
        queryCapableConnectionIds: new Set(),
        findTreeNodeByKeyRef: { current: () => schemaNode },
        locateObjectInSidebar: vi.fn(),
        loadDatabases: vi.fn(),
        mergeExpandedTreeKeys: vi.fn(),
        onDoubleClick: vi.fn(),
        revealCommandSearchNode: vi.fn(),
        scrollSidebarTreeToKey: vi.fn(),
        selectedNodesRef: { current: [] },
        setActiveContext,
        setSelectedKeys: vi.fn(),
        setV2CommandActiveIndex: vi.fn(),
        treeDataRef: { current: [schemaNode] },
        v2CommandActiveIndex: 0,
      }));
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    act(() => {
      runCommandSearchItem?.(item);
    });

    expect(setActiveContext).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'anno',
    });
  });
});
