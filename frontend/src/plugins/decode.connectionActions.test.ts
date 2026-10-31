import { describe, expect, it } from 'vitest';
import { decodeManifest } from './decode';

const manifest = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, apiVersion: 1, id: 'com.example.mongo', name: 'Mongo', version: '1.0.0',
  permissions: [], window: { entry: 'ui/index.html' }, ...extra,
  contributes: { connectionActions: [action] },
});

describe('plugin connection action decoding', () => {
  it('keeps a valid window action', () => {
    const decoded = decodeManifest(manifest({
      id: 'open', title: 'MongoShell', connectionTypes: ['mongodb'],
      scopes: ['connection', 'database', 'collection'], target: { type: 'window' },
    }));
    expect(decoded.contributes?.connectionActions?.[0].title).toBe('MongoShell');
  });

  it('rejects unknown targets, uppercase types, and undeclared pages', () => {
    expect(() => decodeManifest(manifest({ id: 'open', title: 'Open', connectionTypes: ['mongodb'], target: { type: 'tab' } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'open', title: 'Open', connectionTypes: ['MongoDB'], target: { type: 'window' } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'open', title: 'Open', connectionTypes: ['mongodb'], target: { type: 'page', page: 'shell' } }))).toThrow();
  });
});
