import { describe, expect, it } from 'vitest';
import { collectPluginConnectionActions, filterPluginConnectionActions } from './connectionActions';
import type { PluginStatus } from './types';

const status = (id: string, state: PluginStatus['state'], desiredEnabled: boolean, connectionActions: any[]): PluginStatus => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    description: '',
    author: 'test',
    license: 'Apache-2.0',
    permissions: [],
    contributes: { connectionActions },
  },
  digest: 'x',
  state,
  desiredEnabled,
  generation: 1,
  installedAt: '2026-10-27T00:00:00Z',
});

describe('plugin connection actions', () => {
  it('collects only running desired plugins with window targets', () => {
    const entries = collectPluginConnectionActions([
      status('a', 'running', true, [{ id: 'open', title: 'MongoShell', connectionTypes: ['mongodb'], scopes: ['connection'], target: { type: 'window' } }]),
      status('b', 'disabled', true, [{ id: 'open', title: 'Stopped', connectionTypes: ['mongodb'], target: { type: 'window' } }]),
      status('c', 'running', false, [{ id: 'open', title: 'Disabled', connectionTypes: ['mongodb'], target: { type: 'window' } }]),
      status('d', 'running', true, [{ id: 'open', title: 'Page', connectionTypes: ['mongodb'], target: { type: 'page', page: 'shell' } }]),
    ]);
    expect(entries.map((entry) => entry.pluginID)).toEqual(['a', 'd']);
  });

  it('filters by connection type and scope', () => {
    const entries = collectPluginConnectionActions([
      status('a', 'running', true, [{
        id: 'open',
        title: 'MongoShell',
        connectionTypes: ['mongodb'],
        scopes: ['connection', 'database'],
        target: { type: 'window' },
      }]),
    ]);
    expect(filterPluginConnectionActions(entries, 'MongoDB', 'connection')).toHaveLength(1);
    expect(filterPluginConnectionActions(entries, 'mongodb', 'database')).toHaveLength(1);
    expect(filterPluginConnectionActions(entries, 'mongodb', 'collection')).toHaveLength(0);
    expect(filterPluginConnectionActions(entries, 'postgres', 'connection')).toHaveLength(0);
  });
});
