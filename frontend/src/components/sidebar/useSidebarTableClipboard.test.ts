import { describe, expect, it, vi } from 'vitest';

import {
  canCopySidebarTableDirectly,
  isSameSidebarTableDatabase,
  resolveSidebarTableClipboardCopyEventCommand,
  resolveSidebarTableClipboardCommand,
  resolveSidebarTableClipboardEntry,
  resolveSidebarTableClipboardPasteEventCommand,
  resolveSidebarTableClipboardTarget,
} from './useSidebarTableClipboard';

const connectionIds = ['conn-a', 'conn-b'];

const createKeyEvent = (
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent => ({
  key: 'c',
  code: 'KeyC',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  keyCode: 67,
  which: 67,
  target: null,
  preventDefault: vi.fn(),
  ...overrides,
} as unknown as KeyboardEvent);

const createClipboardEvent = (
  overrides: Partial<ClipboardEvent> = {},
): ClipboardEvent => ({
  defaultPrevented: false,
  target: null,
  preventDefault: vi.fn(),
  ...overrides,
} as unknown as ClipboardEvent);

const createTableNode = (overrides: Record<string, unknown> = {}) => ({
  key: 'conn-a-shop-table-orders',
  title: 'orders',
  type: 'table',
  dataRef: {
    id: 'conn-a',
    dbName: 'shop',
    schemaName: '',
    tableName: 'orders',
    config: { type: 'mysql' },
  },
  ...overrides,
});

const createDatabaseNode = (
  connectionId: string,
  database: string,
  overrides: Record<string, unknown> = {},
) => ({
  key: `${connectionId}-${database}`,
  title: database,
  type: 'database',
  dataRef: {
    id: connectionId,
    dbName: database,
    schemaName: '',
    config: { type: 'mysql' },
  },
  ...overrides,
});

describe('sidebar table clipboard resolution', () => {
  it('copies a selected table with its connection, database, schema and name', () => {
    const node = createTableNode();
    expect(resolveSidebarTableClipboardEntry(node, connectionIds)).toEqual({
      node,
      connectionId: 'conn-a',
      database: 'shop',
      schema: '',
      table: 'orders',
    });
  });

  it('resolves database, schema group and table nodes as paste targets', () => {
    const database = createDatabaseNode('conn-a', 'shop');
    expect(resolveSidebarTableClipboardTarget(database, connectionIds)).toEqual({
      connectionId: 'conn-a',
      database: 'shop',
      schema: '',
    });

    const schema = {
      key: 'conn-a-app-schema-public',
      title: 'public',
      type: 'object-group',
      dataRef: {
        id: 'conn-a',
        dbName: 'app',
        schemaName: 'public',
        groupKey: 'schema',
      },
    };
    expect(resolveSidebarTableClipboardTarget(schema, connectionIds)).toEqual({
      connectionId: 'conn-a',
      database: 'app',
      schema: 'public',
    });

    expect(resolveSidebarTableClipboardTarget(createTableNode(), connectionIds)).toEqual({
      connectionId: 'conn-a',
      database: 'shop',
      schema: '',
    });
  });

  it('treats the same connection and database as a direct copy even without a schema target', () => {
    const entry = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds)!;
    const target = resolveSidebarTableClipboardTarget(
      createDatabaseNode('conn-a', 'shop'),
      connectionIds,
    )!;
    expect(isSameSidebarTableDatabase(entry, target)).toBe(true);
  });

  it('requires the same schema when the paste target is schema-scoped', () => {
    const source = resolveSidebarTableClipboardEntry(
      createTableNode({
        dataRef: {
          id: 'conn-a',
          dbName: 'app',
          schemaName: 'public',
          tableName: 'orders',
          config: { type: 'postgres' },
        },
      }),
      connectionIds,
    )!;
    const sameSchema = resolveSidebarTableClipboardTarget({
      key: 'conn-a-app-schema-public',
      type: 'object-group',
      dataRef: { id: 'conn-a', dbName: 'app', schemaName: 'public', groupKey: 'schema' },
    }, connectionIds)!;
    const otherSchema = resolveSidebarTableClipboardTarget({
      key: 'conn-a-app-schema-sales',
      type: 'object-group',
      dataRef: { id: 'conn-a', dbName: 'app', schemaName: 'sales', groupKey: 'schema' },
    }, connectionIds)!;

    expect(isSameSidebarTableDatabase(source, sameSchema)).toBe(true);
    expect(isSameSidebarTableDatabase(source, otherSchema)).toBe(false);
  });
});

describe('sidebar table clipboard shortcuts', () => {
  it.each([
    ['mac', { metaKey: true }],
    ['windows', { ctrlKey: true }],
  ] as const)('copies a single selected table on %s', (shortcutPlatform, modifiers) => {
    const table = createTableNode();
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent(modifiers),
      shortcutPlatform,
      selectedNodes: [table],
      clipboard: null,
      connectionIds,
    });

    expect(command.kind).toBe('copy');
    expect(command.kind === 'copy' && command.entry.table).toBe('orders');
  });

  it('does not intercept copy while typing in an input', () => {
    const target = {
      tagName: 'INPUT',
      isContentEditable: false,
      closest: () => null,
    };
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ metaKey: true, target: target as unknown as EventTarget }),
      shortcutPlatform: 'mac',
      selectedNodes: [createTableNode()],
      clipboard: null,
      connectionIds,
    });
    expect(command.kind).toBe('none');
  });

  it('does not copy when multiple nodes are selected', () => {
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createTableNode(), createTableNode({ title: 'customers' })],
      clipboard: null,
      connectionIds,
    });
    expect(command.kind).toBe('none');
  });

  it('routes same-database paste to the existing copy-table action', () => {
    const entry = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds)!;
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: entry,
      connectionIds,
    });

    expect(command.kind).toBe('paste-copy-table');
  });

  it('opens the data sync wizard with source and target prefilled for cross-instance paste', () => {
    const entry = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds)!;
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', ctrlKey: true }),
      shortcutPlatform: 'windows',
      selectedNodes: [createDatabaseNode('conn-b', 'analytics')],
      clipboard: entry,
      connectionIds,
    });

    expect(command.kind).toBe('paste-via-data-sync');
    if (command.kind !== 'paste-via-data-sync') return;
    expect(command.prefill).toEqual({
      source: { connectionId: 'conn-a', database: 'shop', table: 'orders' },
      target: { connectionId: 'conn-b', database: 'analytics' },
    });
  });

  it('opens the data sync wizard for a different database on the same connection', () => {
    const entry = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds)!;
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createDatabaseNode('conn-a', 'archive')],
      clipboard: entry,
      connectionIds,
    });

    expect(command.kind).toBe('paste-via-data-sync');
  });

  it('falls back to the wizard when the source dialect cannot copy a table directly', () => {
    const oracleNode = createTableNode({
      dataRef: {
        id: 'conn-a',
        dbName: 'shop',
        schemaName: 'SALES',
        tableName: 'ORDERS',
        config: { type: 'oracle' },
      },
    });
    const entry = resolveSidebarTableClipboardEntry(oracleNode, connectionIds)!;
    expect(canCopySidebarTableDirectly(entry)).toBe(false);

    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: entry,
      connectionIds,
    });

    expect(command.kind).toBe('paste-via-data-sync');
  });

  it('warns instead of pasting when the selected node cannot be a target', () => {
    const entry = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds)!;
    const command = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [{ key: 'tag-1', type: 'tag', dataRef: {} }],
      clipboard: entry,
      connectionIds,
    });

    expect(command.kind).toBe('paste-target-missing');
  });

  it('ignores paste when nothing was copied or the event was already handled', () => {
    const noClipboard = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: null,
      connectionIds,
    });
    const handled = resolveSidebarTableClipboardCommand({
      event: createKeyEvent({ key: 'v', code: 'KeyV', metaKey: true, defaultPrevented: true }),
      shortcutPlatform: 'mac',
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: resolveSidebarTableClipboardEntry(createTableNode(), connectionIds),
      connectionIds,
    });

    expect(noClipboard.kind).toBe('none');
    expect(handled.kind).toBe('none');
  });
});

describe('sidebar table clipboard DOM events', () => {
  it('copies the selected table from the native copy event used by the macOS edit menu', () => {
    const command = resolveSidebarTableClipboardCopyEventCommand({
      event: createClipboardEvent({ type: 'copy' }),
      selectedNodes: [createTableNode()],
      connectionIds,
    });

    expect(command.kind).toBe('copy');
    expect(command.kind === 'copy' && command.entry.table).toBe('orders');
  });

  it('leaves native text copy alone when the copy event comes from an editable target', () => {
    const target = {
      tagName: 'TEXTAREA',
      isContentEditable: false,
      closest: () => null,
    };
    const command = resolveSidebarTableClipboardCopyEventCommand({
      event: createClipboardEvent({ type: 'copy', target: target as unknown as EventTarget }),
      selectedNodes: [createTableNode()],
      connectionIds,
    });

    expect(command.kind).toBe('none');
  });

  it('routes the native paste event to the same-database table copy action', () => {
    const command = resolveSidebarTableClipboardPasteEventCommand({
      event: createClipboardEvent({ type: 'paste' }),
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: resolveSidebarTableClipboardEntry(createTableNode(), connectionIds),
      connectionIds,
    });

    expect(command.kind).toBe('paste-copy-table');
  });

  it('opens the migration workbench from a native paste event across instances', () => {
    const command = resolveSidebarTableClipboardPasteEventCommand({
      event: createClipboardEvent({ type: 'paste' }),
      selectedNodes: [createDatabaseNode('conn-b', 'archive')],
      clipboard: resolveSidebarTableClipboardEntry(createTableNode(), connectionIds),
      connectionIds,
    });

    expect(command.kind).toBe('paste-via-data-sync');
    if (command.kind !== 'paste-via-data-sync') return;
    expect(command.prefill.target.connectionId).toBe('conn-b');
  });

  it('does not intercept a native paste event inside an input or without a queued table', () => {
    const inputTarget = {
      tagName: 'INPUT',
      isContentEditable: false,
      closest: () => null,
    };
    const clipboard = resolveSidebarTableClipboardEntry(createTableNode(), connectionIds);

    expect(resolveSidebarTableClipboardPasteEventCommand({
      event: createClipboardEvent({ type: 'paste', target: inputTarget as unknown as EventTarget }),
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard,
      connectionIds,
    }).kind).toBe('none');

    expect(resolveSidebarTableClipboardPasteEventCommand({
      event: createClipboardEvent({ type: 'paste' }),
      selectedNodes: [createDatabaseNode('conn-a', 'shop')],
      clipboard: null,
      connectionIds,
    }).kind).toBe('none');
  });
});
