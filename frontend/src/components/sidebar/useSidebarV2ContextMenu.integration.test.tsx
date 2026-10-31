// @vitest-environment jsdom
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useSidebarV2ContextMenu, type SidebarContextMenuState } from './useSidebarV2ContextMenu';
import type { PluginConnectionActionEntry } from '../../plugins/connectionActions';
const entry: PluginConnectionActionEntry = {
  pluginID: 'test.shell', pluginName: 'Shell',
  action: { id: 'open', title: 'Open plugin shell', connectionTypes: ['mongodb'], scopes: ['connection', 'database', 'collection'], target: { type: 'window' } },
};
const run = vi.fn();
const options: Parameters<typeof useSidebarV2ContextMenu>[0] = {
  connections: [], connectionTags: [], activeShortcutPlatform: 'mac', flattenConnectionNodes: (nodes) => nodes,
  v2TreeMetrics: { databaseTableCounts: new Map(), objectGroupCounts: new Map() },
  tableSortPreference: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [],
  getConnectionNodeForAction: vi.fn(), buildRuntimeConfig: vi.fn(), extractObjectName: (name) => name,
  isPostgresSchemaDialect: () => false, loadTables: vi.fn(), getDatabaseNodeRef: vi.fn(),
  handleExportSchemaSQL: vi.fn(), handleDeleteSchema: vi.fn(), openRenameSchemaModal: vi.fn(),
  openSchemaVisibilitySettings: vi.fn(), supportsConnectionVisibility: () => false,
  resolveMessagePublishTarget: () => undefined, pluginConnectionActions: [entry], runPluginConnectionAction: run,
  addSqlLog: vi.fn(), handleV2TableContextMenuAction: vi.fn(), handleV2TableGroupContextMenuAction: vi.fn(),
  handleV2DatabaseContextMenuAction: vi.fn(), handleV2ConnectionContextMenuAction: vi.fn(), handleV2ConnectionGroupContextMenuAction: vi.fn(),
  selectedNodesRef: { current: [] }, handleV2MultiTableContextMenuAction: vi.fn(),
};
let menu: ReturnType<typeof useSidebarV2ContextMenu>;
let renderer: ReturnType<typeof create> | undefined;
function Harness() {
  menu = useSidebarV2ContextMenu(options);
  return menu.contextMenu ? menu.renderV2SidebarContextMenuContent(menu.contextMenu) : null;
}
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; run.mockClear(); });
it.each([
  ['v2-table', { connectionId: 'mongo', database: 'shop', collection: 'orders' }],
  ['v2-database', { connectionId: 'mongo', database: 'shop', collection: undefined }],
  ['v2-connection', { connectionId: 'mongo', database: undefined, collection: undefined }],
] as const)('routes a real %s plugin menu click through the sidebar hook', async (kind, target) => {
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    menu.setContextMenu({ kind, x: 10, y: 10, items: [], node: {
      key: 'mongo', title: 'orders', dataRef: { id: 'mongo', name: 'Mongo', dbName: 'shop', tableName: 'orders', config: { type: 'mongodb' } },
    } });
  });
  const titles = renderer!.root.findAll((node) => node.type === 'span' && node.props.className === 'gn-v2-context-menu-item-title' && node.children.includes(entry.action.title));
  expect(titles).toHaveLength(1);
  act(() => { titles[0].parent!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }); });
  expect(run).toHaveBeenCalledWith(entry, target);
  expect(menu.contextMenu).toBeNull();
});
it('filters actions for other engines and scopes before rendering the real table menu', async () => {
  const original = options.pluginConnectionActions;
  options.pluginConnectionActions = [
    { ...entry, action: { ...entry.action, connectionTypes: ['mysql'] } },
    { ...entry, action: { ...entry.action, scopes: ['connection'] } },
  ];
  try {
    await act(async () => { renderer = create(<Harness />); });
    const state: SidebarContextMenuState = { kind: 'v2-table', x: 0, y: 0, items: [], node: { title: 'orders', dataRef: { config: { type: 'mongodb' } } } };
    await act(async () => { menu.setContextMenu(state); });
    expect(renderer!.root.findAll((node) => node.type === 'span' && node.children.includes(entry.action.title))).toHaveLength(0);
  } finally { options.pluginConnectionActions = original; }
});
