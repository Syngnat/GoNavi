import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection, SavedQuery } from '../../types';
import { t } from '../../i18n';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';

const mocks = vi.hoisted(() => ({
  dbGetDatabases: vi.fn(),
  dbGetObjects: vi.fn(),
  dbGetTables: vi.fn(),
  dbRefreshTableStats: vi.fn(),
  dbQuery: vi.fn(),
  getDriverStatusList: vi.fn(),
  jvmProbeCapabilities: vi.fn(),
  replaceTreeNodeChildren: vi.fn(),
  storeState: {
    connections: [] as SavedConnection[],
    tableSortPreference: {} as Record<string, string>,
    tableAccessCount: {} as Record<string, number>,
    pinnedSidebarTables: [] as string[],
    pinnedSidebarDatabases: [] as string[],
  },
}));

vi.mock('antd', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  message: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../store', async () => {
  const actual = await vi.importActual<typeof import('../../store')>('../../store');
  const useStore = Object.assign(vi.fn(), {
    getState: () => mocks.storeState,
  });
  return { ...actual, useStore };
});

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetObjects: mocks.dbGetObjects,
  DBGetTables: mocks.dbGetTables,
  DBRefreshTableStats: mocks.dbRefreshTableStats,
  DBQuery: mocks.dbQuery,
  GetDriverStatusList: mocks.getDriverStatusList,
  JVMProbeCapabilities: mocks.jvmProbeCapabilities,
}));

type MessageQueueCase = {
  type: 'mqtt' | 'kafka' | 'rocketmq' | 'rabbitmq';
  database: string;
  expectedNamespaceTitle: string;
  objects: Array<{ name: string; type: string }>;
  expectedKinds: string[];
};

const messageQueueCases: MessageQueueCase[] = [
  {
    type: 'mqtt',
    database: 'topics',
    expectedNamespaceTitle: t('sidebar.message_queue.namespace.topic_filters'),
    objects: [{ name: 'devices/+/telemetry', type: 'topic' }],
    expectedKinds: ['topic-filter'],
  },
  {
    type: 'kafka',
    database: 'topics',
    expectedNamespaceTitle: t('sidebar.message_queue.namespace.topics'),
    objects: [{ name: 'orders.events.v1', type: 'topic' }],
    expectedKinds: ['topic'],
  },
  {
    type: 'rocketmq',
    database: 'topics',
    expectedNamespaceTitle: t('sidebar.message_queue.namespace.topics'),
    objects: [{ name: 'orders-created', type: 'topic' }],
    expectedKinds: ['topic'],
  },
  {
    type: 'rabbitmq',
    database: '/',
    expectedNamespaceTitle: '/',
    objects: [
      { name: 'orders.queue', type: 'queue' },
      { name: 'events.topic', type: 'exchange' },
    ],
    expectedKinds: ['queue', 'exchange'],
  },
];

const flattenNodes = (nodes: any[]): any[] => nodes.flatMap((node) => [
  node,
  ...(Array.isArray(node.children) ? flattenNodes(node.children) : []),
]);

describe('useSidebarTreeLoaders message queue object model', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [];
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
    mocks.dbRefreshTableStats.mockResolvedValue({ success: false });
    mocks.dbQuery.mockResolvedValue({ success: true, data: [] });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it.each(messageQueueCases)(
    'renders $type metadata as message objects without relational groups',
    async ({ type, database, expectedNamespaceTitle, objects, expectedKinds }) => {
      const connection = {
        id: `conn-${type}`,
        name: type.toUpperCase(),
        config: {
          type,
          host: '127.0.0.1',
          port: type === 'mqtt' ? 1883 : 10000,
        },
      } as SavedConnection;
      const savedQueries = [{
        id: `query-${type}`,
        name: 'inspect messages',
        connectionId: connection.id,
        dbName: database,
        sql: 'SELECT * FROM target LIMIT 100;',
      }] as SavedQuery[];
      mocks.storeState.connections = [connection];
      mocks.dbGetDatabases.mockResolvedValue({
        success: true,
        data: [{ Database: database }],
      });
      mocks.dbGetObjects.mockResolvedValue({
        success: true,
        data: objects.map((object) => ({ ...object, database })),
      });
      // The old relational loader reads this endpoint and creates table/view/routine groups.
      mocks.dbGetTables.mockResolvedValue({
        success: true,
        data: objects
          .filter((object) => object.type === 'topic' || object.type === 'queue')
          .map((object) => ({ Table: object.name })),
      });

      let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
      const Harness = () => {
        loaders = useSidebarTreeLoaders({
          savedQueries,
          tableSortPreference: {},
          tableAccessCount: {},
          pinnedSidebarTables: [],
          pinnedSidebarDatabases: [],
          isV2Ui: true,
          loadingNodesRef: { current: new Set<string>() },
          setConnectionStates: vi.fn(),
          setLoadedKeys: vi.fn(),
          replaceTreeNodeChildren: mocks.replaceTreeNodeChildren,
          buildRuntimeConfig: (conn) => conn.config,
          buildJVMRuntimeConfig: (conn) => conn.config,
          buildJVMDiagnosticTreeNodes: () => [],
          resolveSavedQueryDisplayName: (name) => String(name || ''),
        });
        return null;
      };

      act(() => {
        renderer = create(<Harness />);
      });
      await act(async () => {
        await loaders?.loadDatabases({ key: connection.id, dataRef: connection });
      });

      const namespaceNodes = mocks.replaceTreeNodeChildren.mock.calls[0][1];
      expect(namespaceNodes).toHaveLength(1);
      expect(namespaceNodes[0]).toMatchObject({
        type: 'message-namespace',
        title: expectedNamespaceTitle,
        dataRef: {
          id: connection.id,
          dbName: database,
          messageQueue: true,
          messageQueueType: type,
          config: connection.config,
        },
      });

      mocks.replaceTreeNodeChildren.mockClear();
      await act(async () => {
        await loaders?.loadTables(namespaceNodes[0]);
      });

      expect(mocks.dbGetObjects).toHaveBeenCalledTimes(1);
      expect(mocks.dbGetObjects).toHaveBeenCalledWith(
        expect.objectContaining({ type }),
        database,
      );
      expect(mocks.dbGetTables).not.toHaveBeenCalled();
      const loadedNodes = flattenNodes(mocks.replaceTreeNodeChildren.mock.calls[0][1]);
      const messageObjects = loadedNodes.filter((node) => node.type === 'message-object');
      expect(messageObjects.map((node) => node.dataRef.messageObjectKind))
        .toEqual(expectedKinds);
      expect(messageObjects.map((node) => ({
        title: node.title,
        messageObjectName: node.dataRef.messageObjectName,
        tableName: node.dataRef.tableName,
        messageQueue: node.dataRef.messageQueue,
      }))).toEqual(objects.map((object) => ({
        title: object.name,
        messageObjectName: object.name,
        tableName: object.name,
        messageQueue: true,
      })));
      expect(loadedNodes.find((node) => node.type === 'queries-folder')).toBeUndefined();
      const messageGroups = loadedNodes.filter(
        (node) => node.type === 'message-object-group',
      );
      if (type === 'rabbitmq') {
        expect(messageGroups.map((node) => node.dataRef.groupKey))
          .toEqual(['queues', 'exchanges']);
      } else {
        expect(messageGroups).toHaveLength(0);
      }
      expect(loadedNodes
        .filter((node) => node.type === 'object-group')
        .map((node) => node.dataRef?.groupKey))
        .not.toEqual(expect.arrayContaining(['tables', 'views', 'routines', 'triggers']));
      expect(mocks.dbQuery).not.toHaveBeenCalled();
    },
  );

  it('deduplicates identical kind and name while preserving case-distinct message objects', async () => {
    const connection = {
      id: 'conn-kafka-dedupe',
      name: 'Kafka',
      config: { type: 'kafka', host: '127.0.0.1', port: 9092 },
    } as SavedConnection;
    mocks.storeState.connections = [connection];
    mocks.dbGetObjects.mockResolvedValue({
      success: true,
      data: [
        { database: 'topics', name: 'Orders', type: 'topic' },
        { database: 'topics', name: 'Orders', type: 'TOPIC' },
        { database: 'topics', name: 'orders', type: 'topic' },
      ],
    });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        isV2Ui: true,
        loadingNodesRef: { current: new Set<string>() },
        setConnectionStates: vi.fn(),
        setLoadedKeys: vi.fn(),
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren,
        buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config,
        buildJVMDiagnosticTreeNodes: () => [],
        resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      await loaders?.loadTables({
        key: 'conn-kafka-dedupe-topics',
        type: 'message-namespace',
        dataRef: {
          ...connection,
          dbName: 'topics',
          messageQueue: true,
          messageQueueType: 'kafka',
        },
      });
    });

    const loadedNodes = flattenNodes(mocks.replaceTreeNodeChildren.mock.calls[0][1]);
    const messageObjects = loadedNodes.filter((node) => node.type === 'message-object');
    expect(messageObjects.map((node) => node.title)).toEqual(['Orders', 'orders']);
    expect(new Set(messageObjects.map((node) => node.key)).size).toBe(2);
  });
});
