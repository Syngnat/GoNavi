import { describe, expect, it, vi } from 'vitest';

import { buildSidebarLegacyNodeMenuItems } from './sidebarLegacyNodeMenu';

const itemKeys = (items: any[]) => items.map((item) => item?.key || item?.type);

const buildContext = (overrides: Record<string, any> = {}) => ({
  addTab: vi.fn(),
  getMetadataDialect: (dataRef: any) => dataRef?.config?.type || '',
  handleV2DatabaseContextMenuAction: vi.fn(),
  loadTables: vi.fn(),
  getDatabaseNodeRef: vi.fn((dataRef) => ({
    key: `${dataRef.id}-${dataRef.dbName}`,
    type: 'message-namespace',
    dataRef,
  })),
  onDoubleClick: vi.fn(),
  resolveMessagePublishTarget: vi.fn(() => ({ destination: 'orders.events' })),
  openMessageQueueWorkbench: vi.fn(),
  openMessagePublishModal: vi.fn(),
  handleCopyTableName: vi.fn(),
  ...overrides,
});

const buildMessageObject = (kind: string, name: string, type = 'kafka') => ({
  key: `message-${kind}-${name}`,
  title: name,
  type: 'message-object',
  dataRef: {
    id: `conn-${type}`,
    dbName: type === 'rabbitmq' ? '/' : 'topics',
    config: { type },
    messageObjectKind: kind,
    messageObjectName: name,
    tableName: name,
  },
});

describe('message queue sidebar menus', () => {
  it('offers message actions instead of relational table actions for topics and queues', () => {
    const context = buildContext();
    const node = buildMessageObject('topic', 'orders.events');
    const items = buildSidebarLegacyNodeMenuItems(node, context) as any[];

    expect(itemKeys(items)).toEqual([
      'browse-messages',
      'open-message-workbench',
      'publish-message',
      'divider',
      'copy-message-object-name',
      'refresh-message-objects',
    ]);
    expect(itemKeys(items)).not.toEqual(expect.arrayContaining([
      'design-table',
      'copy-structure',
      'rename-table',
      'delete-table',
    ]));

    items.find((item) => item.key === 'browse-messages').onClick();
    items.find((item) => item.key === 'open-message-workbench').onClick();
    items.find((item) => item.key === 'publish-message').onClick();
    items.find((item) => item.key === 'copy-message-object-name').onClick();
    items.find((item) => item.key === 'refresh-message-objects').onClick();
    expect(context.openMessageQueueWorkbench).toHaveBeenNthCalledWith(1, node, 'consume');
    expect(context.openMessageQueueWorkbench).toHaveBeenNthCalledWith(2, node, 'open');
    expect(context.openMessagePublishModal).toHaveBeenCalledWith(node);
    expect(context.handleCopyTableName).toHaveBeenCalledWith(node);
    expect(context.loadTables).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message-namespace' }),
      { ensureFresh: true },
    );
  });

  it('opens and publishes to a RabbitMQ exchange without exposing consume actions', () => {
    const context = buildContext();
    const node = buildMessageObject('exchange', 'events.topic', 'rabbitmq');
    const items = buildSidebarLegacyNodeMenuItems(node, context) as any[];

    expect(itemKeys(items)).toEqual([
      'open-message-workbench',
      'publish-message',
      'divider',
      'copy-message-object-name',
      'refresh-message-objects',
    ]);
    expect(itemKeys(items)).not.toEqual(expect.arrayContaining([
      'browse-messages',
      'consume-messages',
    ]));
    items.find((item) => item.key === 'open-message-workbench').onClick();
    items.find((item) => item.key === 'publish-message').onClick();
    expect(context.openMessageQueueWorkbench).toHaveBeenCalledWith(node, 'open');
    expect(context.openMessagePublishModal).toHaveBeenCalledWith(node);
  });

  it('refreshes a message namespace without exposing database schema actions', () => {
    const context = buildContext();
    const node = {
      key: 'conn-mqtt-topics',
      title: 'Topic filters',
      type: 'message-namespace',
      dataRef: {
        id: 'conn-mqtt',
        dbName: 'topics',
        config: { type: 'mqtt' },
      },
    };
    const items = buildSidebarLegacyNodeMenuItems(node, context) as any[];

    expect(itemKeys(items)).toEqual([
      'open-message-workbench',
      'consume-messages',
      'publish-message',
      'refresh-message-objects',
    ]);
    expect(itemKeys(items)).not.toEqual(expect.arrayContaining([
      'new-table',
      'new-view',
      'delete-database',
      'rename-database',
    ]));
    items.find((item) => item.key === 'open-message-workbench').onClick();
    items.find((item) => item.key === 'consume-messages').onClick();
    expect(context.openMessageQueueWorkbench).toHaveBeenNthCalledWith(1, node, 'open');
    expect(context.openMessageQueueWorkbench).toHaveBeenNthCalledWith(2, node, 'consume');
  });
});
