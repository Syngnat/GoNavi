import { describe, expect, it } from 'vitest';

import {
  filterV2ExplorerTreeByKind,
  resolveSidebarDatabaseTreePruneKeys,
  resolveSidebarSingleDatabaseExpandedKeys,
  resolveSidebarTableNameForCopy,
  shouldLoadSidebarNodeOnExpand as shouldLoadV2SidebarNodeOnExpand,
  type SidebarTreeNode,
} from './sidebarV2Utils';
import {
  isV2SidebarObjectNode,
  resolveSidebarTableNameForCopy as resolveSidebarHelperObjectNameForCopy,
  shouldLoadSidebarNodeOnExpand,
} from './sidebar/sidebarHelpers';

describe('message queue sidebar utility semantics', () => {
  it('keeps a message namespace lazy until its children are loaded', () => {
    const namespace: SidebarTreeNode = {
      key: 'mqtt-topics',
      title: 'Topic filters',
      type: 'message-namespace',
      isLeaf: false,
      children: [],
    };

    expect(shouldLoadV2SidebarNodeOnExpand(namespace)).toBe(true);
    expect(shouldLoadSidebarNodeOnExpand(namespace)).toBe(true);
    expect(shouldLoadV2SidebarNodeOnExpand({
      ...namespace,
      children: [{
        key: 'mqtt-topic',
        title: 'devices/+/telemetry',
        type: 'message-object',
      }],
    })).toBe(false);
  });

  it('treats a message object as a searchable object and copies its exact broker name', () => {
    const messageObject: SidebarTreeNode = {
      key: 'mqtt-topic',
      title: 'Telemetry',
      type: 'message-object',
      dataRef: {
        messageQueue: true,
        messageObjectName: 'devices/+/telemetry',
        messageObjectKind: 'topic-filter',
        tableName: 'legacy-name',
      },
    };

    expect(isV2SidebarObjectNode(messageObject)).toBe(true);
    expect(resolveSidebarTableNameForCopy(messageObject)).toBe('devices/+/telemetry');
    expect(resolveSidebarHelperObjectNameForCopy(messageObject)).toBe('devices/+/telemetry');
  });

  it('does not apply relational object filters to message queue namespaces', () => {
    const messageTree: SidebarTreeNode[] = [{
      key: 'mqtt-topics',
      title: 'Topic filters',
      type: 'message-namespace',
      children: [{
        key: 'mqtt-topic-filter',
        title: 'devices/+/telemetry',
        type: 'message-object',
        dataRef: {
          messageQueue: true,
          messageObjectKind: 'topic-filter',
          messageObjectName: 'devices/+/telemetry',
        },
      }],
    }];

    for (const filter of ['tables', 'views', 'sequences', 'routines', 'packages', 'events'] as const) {
      expect(filterV2ExplorerTreeByKind(messageTree, filter)).toEqual(messageTree);
    }
  });

  it('includes loaded message namespaces in the bounded sidebar tree cache', () => {
    const namespace = (key: string): SidebarTreeNode => ({
      key,
      title: key,
      type: 'message-namespace',
      children: [{
        key: `${key}-queue`,
        title: 'orders.queue',
        type: 'message-object',
      }],
    });
    const treeData: SidebarTreeNode[] = [{
      key: 'rabbit',
      title: 'RabbitMQ',
      type: 'connection',
      children: [namespace('rabbit-vhost-a'), namespace('rabbit-vhost-b'), namespace('rabbit-vhost-c')],
    }];

    expect(resolveSidebarDatabaseTreePruneKeys({
      treeData,
      expandedKeys: ['rabbit-vhost-c'],
      selectedKeys: [],
      activeDatabaseKey: 'rabbit-vhost-c',
      touchedAtByDatabaseKey: {
        'rabbit-vhost-a': 10,
        'rabbit-vhost-b': 20,
        'rabbit-vhost-c': 30,
      },
      maxLoadedDatabases: 1,
    })).toEqual(['rabbit-vhost-a', 'rabbit-vhost-b']);
  });

  it('applies single-database expansion to sibling RabbitMQ VHosts', () => {
    const treeData: SidebarTreeNode[] = [{
      key: 'rabbit',
      title: 'RabbitMQ',
      type: 'connection',
      dataRef: { id: 'rabbit' },
      children: [
        {
          key: 'rabbit-vhost-a',
          title: '/a',
          type: 'message-namespace',
          dataRef: { id: 'rabbit', dbName: '/a' },
          children: [{ key: 'rabbit-vhost-a-queues', title: 'Queues', type: 'message-object-group' }],
        },
        {
          key: 'rabbit-vhost-b',
          title: '/b',
          type: 'message-namespace',
          dataRef: { id: 'rabbit', dbName: '/b' },
        },
      ],
    }];

    expect(resolveSidebarSingleDatabaseExpandedKeys({
      previousExpandedKeys: ['rabbit', 'rabbit-vhost-a', 'rabbit-vhost-a-queues'],
      nextExpandedKeys: ['rabbit', 'rabbit-vhost-a', 'rabbit-vhost-a-queues', 'rabbit-vhost-b'],
      treeData,
    })).toEqual(['rabbit', 'rabbit-vhost-b']);
  });
});
