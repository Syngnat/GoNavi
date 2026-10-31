import { describe, expect, it, vi } from 'vitest';
import { buildPluginConnectionActionMenuItems } from './pluginConnectionActionMenu';
import type { PluginConnectionActionEntry } from '../../plugins/connectionActions';

const entry = (pluginID: string, title: string, scopes: ('connection' | 'database' | 'collection')[] = ['connection']): PluginConnectionActionEntry => ({
  pluginID,
  pluginName: pluginID,
  action: { id: 'open', title, connectionTypes: ['mongodb'], scopes, target: { type: 'window' } },
});

describe('plugin connection action menu', () => {
  it('renders a direct item for one matching action', () => {
    const run = vi.fn();
    const items = buildPluginConnectionActionMenuItems({
      actions: [entry('com.gonavi.mongo-shell', 'MongoShell')],
      connectionType: 'mongodb',
      scope: 'connection',
      target: { connectionId: 'c1' },
      run,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'plugin-connection-action:com.gonavi.mongo-shell:open', label: 'MongoShell' });
    (items[0] as any).onClick();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ pluginID: 'com.gonavi.mongo-shell' }), { connectionId: 'c1' });
  });

  it('groups multiple actions and filters by type and scope', () => {
    const items = buildPluginConnectionActionMenuItems({
      actions: [entry('a', 'A'), entry('b', 'B', ['connection', 'database'])],
      connectionType: 'mongodb',
      scope: 'connection',
      target: { connectionId: 'c1' },
      run: vi.fn(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'plugin-connection-actions' });
    expect((items[0] as any).children).toHaveLength(2);
    expect(buildPluginConnectionActionMenuItems({
      actions: [entry('a', 'A')], connectionType: 'postgres', scope: 'connection', target: { connectionId: 'c1' }, run: vi.fn(),
    })).toEqual([]);
  });
});
