import React, { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import type { SidebarTreeNode } from '../sidebarV2Utils';
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

  it('finds loaded Nacos config and service groups by name in command and object searches', () => {
    const connection = {
      id: 'nacos-1', name: 'Nacos', config: { type: 'nacos', host: '127.0.0.1', port: 8848 },
    } as SavedConnection;
    const groups: SidebarTreeNode[] = [
      { key: 'config-group', title: 'CONFIG_GROUP', type: 'nacos-config-group', isLeaf: true,
        dataRef: { ...connection, nacosNamespaceId: 'dev', nacosNamespaceName: 'Development', nacosGroup: 'CONFIG_GROUP' } },
      { key: 'service-group', title: 'SERVICE_GROUP', type: 'nacos-service-group', isLeaf: true,
        dataRef: { ...connection, nacosNamespaceId: 'dev', nacosNamespaceName: 'Development', nacosGroup: 'SERVICE_GROUP' } },
    ];
    const treeData: SidebarTreeNode[] = [{ key: connection.id, title: connection.name, type: 'connection', dataRef: connection,
      children: [{ key: 'namespace-dev', title: 'Development', type: 'nacos-namespace', dataRef: { ...connection, nacosNamespaceId: 'dev' },
        children: [{ key: 'configs', title: 'Configs', type: 'nacos-config-entry', dataRef: connection, children: [groups[0]] },
          { key: 'services', title: 'Services', type: 'nacos-services-entry', dataRef: connection, children: [groups[1]] }] }],
    }];
    const renderSearch = (keyword: string, scopes: Array<'smart' | 'object'>) => {
      let model: ReturnType<typeof useSidebarSearchModel> | undefined;
      const Harness = () => {
        model = useSidebarSearchModel({
          searchScopes: scopes, setSearchScopes: () => undefined, setSearchValue: () => undefined,
          deferredSearchValue: keyword.replace(/^@/, ''), deferredV2CommandSearchValue: keyword,
          v2CommandSearchValue: keyword, setV2CommandActiveIndex: () => undefined,
          v2ExplorerFilter: 'all', treeData, treeHeight: 400, isV2CommandSearchOpen: true,
          connections: [connection], connectionIds: [connection.id], selectedKeys: [],
          selectedNodesRef: useRef<any[]>([]), activeContext: null, activeTab: null,
          recentSqlLogs: [], shortcutOptions: {}, activeShortcutPlatform: 'mac',
          overlayTheme: { sectionBorder: '1px solid #ddd', mutedText: '#666', titleText: '#111', shellBg: '#fff', divider: '#eee' },
          darkMode: false, setAIPanelVisible: () => undefined, extractObjectName: (name) => name,
        });
        return null;
      };
      act(() => { renderer = create(<Harness />); });
      const result = {
        treeKeys: collectTreeNodes(model?.displayTreeData || []).map((node) => node.key),
        items: model?.filteredCommandSearchTreeItems || [],
      };
      act(() => renderer?.unmount());
      renderer = null;
      return result;
    };

    for (const group of groups) {
      const defaultSearch = renderSearch(group.title.toLowerCase(), ['smart']);
      expect(defaultSearch.treeKeys).toContain(group.key);
      expect(defaultSearch.items.map((item) => item.key)).toContain(`node-${group.key}`);
      expect(defaultSearch.items.find((item) => item.key === `node-${group.key}`)?.meta).toContain('Development');
      expect(defaultSearch.items.find((item) => item.key === `node-${group.key}`)?.meta)
        .toContain(t(group.type === 'nacos-config-group'
          ? 'sidebar.command_search.object_kind.nacos_configs'
          : 'sidebar.command_search.object_kind.nacos_services'));
      expect(renderSearch(`@${group.title}`, ['object']).items.map((item) => item.key)).toContain(`node-${group.key}`);
      expect(renderSearch(group.title, ['object']).treeKeys).toContain(group.key);
    }
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
        treeData,
        treeHeight: 400,
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
        treeData,
        treeHeight: 400,
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
        treeData,
        treeHeight: 400,
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

  it('matches tables by comment in smart scope and command search', () => {
    const connection = {
      id: 'conn-1',
      name: 'MySQL',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    } as SavedConnection;
    const userTable = {
      title: 'sys_user',
      key: 'conn-1-app-tables-sys_user',
      type: 'table' as const,
      dataRef: {
        ...connection,
        dbName: 'app',
        tableName: 'sys_user',
        tableComment: '系统用户表',
      },
    };
    const orderTable = {
      title: 't_order',
      key: 'conn-1-app-tables-t_order',
      type: 'table' as const,
      dataRef: {
        ...connection,
        dbName: 'app',
        tableName: 't_order',
        tableComment: '订单主表',
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
          children: [userTable, orderTable],
        }],
      }],
    }];

    const buildHarness = (args: {
      deferredSearchValue: string;
      searchScopes?: any[];
      isV2CommandSearchOpen?: boolean;
      v2CommandSearchValue?: string;
    }) => {
      let model: ReturnType<typeof useSidebarSearchModel> | undefined;
      const Harness = () => {
        model = useSidebarSearchModel({
          searchScopes: args.searchScopes ?? ['smart'],
          setSearchScopes: () => undefined,
          setSearchValue: () => undefined,
          deferredSearchValue: args.deferredSearchValue,
          deferredV2CommandSearchValue: args.v2CommandSearchValue ?? '',
          v2CommandSearchValue: args.v2CommandSearchValue ?? '',
          setV2CommandActiveIndex: () => undefined,
          v2ExplorerFilter: 'all',
          treeData,
          treeHeight: 400,
          isV2CommandSearchOpen: args.isV2CommandSearchOpen ?? false,
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
      return model;
    };

    // Smart scope: comment keyword surfaces the table in the filtered tree.
    const smartModel = buildHarness({ deferredSearchValue: '订单主表' });
    const smartMatchedKeys = collectTreeNodes(smartModel?.displayTreeData || []).map((node) => node.key);
    expect(smartMatchedKeys).toContain(orderTable.key);
    expect(smartMatchedKeys).not.toContain(userTable.key);

    // Object scope: comment keyword also matches through the scoped filter.
    const objectModel = buildHarness({ deferredSearchValue: '系统用户', searchScopes: ['object'] });
    const objectMatchedKeys = collectTreeNodes(objectModel?.displayTreeData || []).map((node) => node.key);
    expect(objectMatchedKeys).toContain(userTable.key);
    expect(objectMatchedKeys).not.toContain(orderTable.key);

    // Command search: comment keyword matches via the default node index.
    const commandModel = buildHarness({
      deferredSearchValue: '订单主表',
      isV2CommandSearchOpen: true,
      v2CommandSearchValue: '订单主表',
    });
    expect(commandModel?.filteredCommandSearchTreeItems.map((item) => item.key))
      .toContain(`node-${orderTable.key}`);
    expect(commandModel?.filteredCommandSearchTreeItems.map((item) => item.key))
      .not.toContain(`node-${userTable.key}`);

    // Command palette rows surface the comment in meta next to connection · database.
    const orderItem = commandModel?.commandSearchTreeItems.find((item) => item.key === `node-${orderTable.key}`);
    expect(orderItem?.meta).toBe('MySQL · app — 订单主表');

    const underscoreTree = collectTreeNodes(
      buildHarness({ deferredSearchValue: '_user' })?.displayTreeData || [],
    ).map((node) => node.key);
    expect(underscoreTree).toContain(userTable.key);
    expect(underscoreTree).not.toContain(orderTable.key);

    const fullwidthTree = collectTreeNodes(
      buildHarness({ deferredSearchValue: 'sys＿user' })?.displayTreeData || [],
    ).map((node) => node.key);
    expect(fullwidthTree).toContain(userTable.key);

    const commandUnderscore = buildHarness({
      deferredSearchValue: '',
      isV2CommandSearchOpen: true,
      v2CommandSearchValue: 't_order',
    });
    expect(commandUnderscore?.filteredCommandSearchTreeItems.map((item) => item.key))
      .toContain(`node-${orderTable.key}`);
    expect(commandUnderscore?.filteredCommandSearchTreeItems.map((item) => item.key))
      .not.toContain(`node-${userTable.key}`);
  });
});
