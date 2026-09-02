import React, { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import type { SavedConnection } from '../../types';
import { useSidebarSearchModel } from './useSidebarSearchModel';

const collectTreeNodes = (nodes: Array<{ key: string; title: string; children?: any[] }>) => {
  const result: Array<{ key: string; title: string }> = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift();
    if (!node) continue;
    result.push({ key: node.key, title: node.title });
    if (Array.isArray(node.children)) pending.push(...node.children);
  }
  return result;
};

describe('useSidebarSearchModel search filtering', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('does not repeat a table when the filtered tree contains duplicate keys', () => {
    const connection = {
      id: 'conn-1',
      name: 'MySQL',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    } as SavedConnection;
    const duplicateTable = {
      title: 'ldf_application_type',
      key: 'conn-1-app-tables-ldf_application_type',
      type: 'table' as const,
      dataRef: {
        ...connection,
        dbName: 'app',
        tableName: 'ldf_application_type',
      },
    };
    const treeData = [{
      title: connection.name,
      key: connection.id,
      type: 'connection' as const,
      dataRef: connection,
      children: [{
        title: 'app',
        key: 'conn-1-app',
        type: 'database' as const,
        dataRef: { ...connection, dbName: 'app' },
        children: [{
          title: 'Tables',
          key: 'conn-1-app-tables',
          type: 'object-group' as const,
          children: [duplicateTable, { ...duplicateTable }],
        }],
      }],
    }];

    let model: ReturnType<typeof useSidebarSearchModel> | undefined;
    const Harness = () => {
      model = useSidebarSearchModel({
        searchScopes: ['smart'],
        setSearchScopes: () => undefined,
        setSearchValue: () => undefined,
        deferredSearchValue: 'type',
        deferredV2CommandSearchValue: '',
        v2CommandSearchValue: '',
        setV2CommandActiveIndex: () => undefined,
        v2ExplorerFilter: 'all',
        sidebarTableMetadataFields: [],
        treeData,
        treeViewportWidth: 320,
        treeHeight: 400,
        isV2Ui: true,
        isV2CommandSearchOpen: false,
        connections: [connection],
        connectionIds: [connection.id],
        selectedKeys: [],
        selectedNodesRef: useRef<any[]>([]),
        activeContext: null,
        activeTab: null,
        recentSqlLogs: [],
        shortcutOptions: {},
        activeShortcutPlatform: 'mac',
        overlayTheme: {
          sectionBorder: '1px solid #ddd',
          mutedText: '#666',
          titleText: '#111',
          shellBg: '#fff',
          divider: '#eee',
        },
        darkMode: false,
        setAIPanelVisible: () => undefined,
        extractObjectName: (name) => name,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    const displayNodes = collectTreeNodes(model?.displayTreeData || []);
    const visibleNodes = collectTreeNodes(model?.v2VisibleTreeData || []);
    expect(displayNodes.filter((node) => node.title === 'ldf_application_type')).toHaveLength(1);
    expect(visibleNodes.filter((node) => node.title === 'ldf_application_type')).toHaveLength(1);
    expect(new Set(displayNodes.map((node) => node.key)).size).toBe(displayNodes.length);
    expect(new Set(visibleNodes.map((node) => node.key)).size).toBe(visibleNodes.length);
  });

  it('includes message objects in explorer object scope and command search', () => {
    const connection = {
      id: 'mqtt-1',
      name: 'MQTT',
      config: { type: 'mqtt', host: '127.0.0.1', port: 1883 },
    } as SavedConnection;
    const messageObject = {
      title: 'devices/+/telemetry',
      key: 'mqtt-1-topics-devices-telemetry',
      type: 'message-object' as const,
      dataRef: {
        ...connection,
        dbName: 'topics',
        messageQueue: true,
        messageObjectName: 'devices/+/telemetry',
        messageObjectKind: 'topic-filter',
        tableName: 'devices/+/telemetry',
      },
    };
    const treeData = [{
      title: connection.name,
      key: connection.id,
      type: 'connection' as const,
      dataRef: connection,
      children: [{
        title: 'Topic filters',
        key: 'mqtt-1-topics',
        type: 'message-namespace' as const,
        dataRef: {
          ...connection,
          dbName: 'topics',
          messageQueue: true,
          messageNamespaceKind: 'topic-filters',
        },
        children: [{
          title: 'Topics',
          key: 'mqtt-1-topics-group',
          type: 'message-object-group' as const,
          dataRef: { ...connection, messageQueue: true, groupKey: 'topics' },
          children: [messageObject],
        }],
      }],
    }];

    let model: ReturnType<typeof useSidebarSearchModel> | undefined;
    const Harness = () => {
      model = useSidebarSearchModel({
        searchScopes: ['object'],
        setSearchScopes: () => undefined,
        setSearchValue: () => undefined,
        deferredSearchValue: 'telemetry',
        deferredV2CommandSearchValue: '@telemetry',
        v2CommandSearchValue: '@telemetry',
        setV2CommandActiveIndex: () => undefined,
        v2ExplorerFilter: 'all',
        sidebarTableMetadataFields: [],
        treeData,
        treeViewportWidth: 320,
        treeHeight: 400,
        isV2Ui: true,
        isV2CommandSearchOpen: true,
        connections: [connection],
        connectionIds: [connection.id],
        selectedKeys: [],
        selectedNodesRef: useRef<any[]>([]),
        activeContext: null,
        activeTab: null,
        recentSqlLogs: [],
        shortcutOptions: {},
        activeShortcutPlatform: 'mac',
        overlayTheme: {
          sectionBorder: '1px solid #ddd',
          mutedText: '#666',
          titleText: '#111',
          shellBg: '#fff',
          divider: '#eee',
        },
        darkMode: false,
        setAIPanelVisible: () => undefined,
        extractObjectName: (name) => name,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    expect(collectTreeNodes(model?.displayTreeData || []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: messageObject.key, title: messageObject.title }),
      ]));
    expect(model?.commandSearchTreeItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: `node-${messageObject.key}`,
          title: messageObject.title,
          node: expect.objectContaining({ type: 'message-object' }),
        }),
      ]));
    expect(model?.filteredCommandSearchTreeItems.map((item) => item.key))
      .toContain(`node-${messageObject.key}`);
  });

  it('finds a RabbitMQ VHost through database scope and command search', () => {
    const connection = {
      id: 'rabbit-1',
      name: 'RabbitMQ',
      config: { type: 'rabbitmq', host: '127.0.0.1', port: 15672 },
    } as SavedConnection;
    const namespace = {
      title: '/orders',
      key: 'rabbit-1-vhost-orders',
      type: 'message-namespace' as const,
      dataRef: {
        ...connection,
        dbName: '/orders',
        messageQueue: true,
        messageNamespaceKind: 'vhost',
      },
      children: [{
        title: 'Queues',
        key: 'rabbit-1-vhost-orders-queues',
        type: 'message-object-group' as const,
        dataRef: { ...connection, messageQueue: true, groupKey: 'queues' },
      }],
    };
    const treeData = [{
      title: connection.name,
      key: connection.id,
      type: 'connection' as const,
      dataRef: connection,
      children: [namespace],
    }];

    let model: ReturnType<typeof useSidebarSearchModel> | undefined;
    const Harness = () => {
      model = useSidebarSearchModel({
        searchScopes: ['database'],
        setSearchScopes: () => undefined,
        setSearchValue: () => undefined,
        deferredSearchValue: 'orders',
        deferredV2CommandSearchValue: 'orders',
        v2CommandSearchValue: 'orders',
        setV2CommandActiveIndex: () => undefined,
        v2ExplorerFilter: 'all',
        sidebarTableMetadataFields: [],
        treeData,
        treeViewportWidth: 320,
        treeHeight: 400,
        isV2Ui: true,
        isV2CommandSearchOpen: true,
        connections: [connection],
        connectionIds: [connection.id],
        selectedKeys: [],
        selectedNodesRef: useRef<any[]>([]),
        activeContext: null,
        activeTab: null,
        recentSqlLogs: [],
        shortcutOptions: {},
        activeShortcutPlatform: 'mac',
        overlayTheme: {
          sectionBorder: '1px solid #ddd',
          mutedText: '#666',
          titleText: '#111',
          shellBg: '#fff',
          divider: '#eee',
        },
        darkMode: false,
        setAIPanelVisible: () => undefined,
        extractObjectName: (name) => name,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    expect(collectTreeNodes(model?.displayTreeData || []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: namespace.key, title: namespace.title }),
      ]));
    expect(model?.commandSearchTreeItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: `node-${namespace.key}`,
          title: namespace.title,
          node: expect.objectContaining({ type: 'message-namespace' }),
        }),
      ]));
  });
});
