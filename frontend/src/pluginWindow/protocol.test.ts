import { describe, expect, it } from 'vitest';
import { boundedJSON, maxJSONBytes, newPluginRequestID, parseIdentity, readBridgeResponse } from './protocol';

describe('isolated plugin protocol', () => {
  it('creates bounded random IDs without a secure-context-only UUID API', () => {
    expect(newPluginRequestID()).toMatch(/^[a-f0-9]{32}$/);
    expect(newPluginRequestID()).not.toBe(newPluginRequestID());
  });
  it('accepts only a bounded generation identity', () => {
    const identity = parseIdentity({ pluginId: 'test.one', generation: 3, title: 'Fixture' });
    expect(Object.isFrozen(identity)).toBe(true);
    for (const bad of [null, {}, { pluginId: 'x', generation: -1, title: 'x' }, { pluginId: 'x', generation: Infinity, title: 'x' }]) {
      expect(() => parseIdentity(bad)).toThrow('invalid_identity');
    }
  });
  it('carries an optional frozen launch context', () => {
    const identity = parseIdentity({ pluginId: 'test.one', generation: 3, title: 'Fixture', context: { connectionId: 'c1', readOnly: true } });
    expect(identity.context).toEqual({ connectionId: 'c1', readOnly: true });
    expect(Object.isFrozen(identity.context)).toBe(true);
  });
  it('measures UTF-8 bytes, not only JavaScript code units', () => {
    expect(boundedJSON({ ok: true })).toBe('{"ok":true}');
    expect(() => boundedJSON('界'.repeat(maxJSONBytes / 2))).toThrow('payload_too_large');
  });
  it('bounds response streams before decoding JSON', async () => {
    expect(await readBridgeResponse(new Response('{"ok":true}'))).toEqual({ ok: true });
    await expect(readBridgeResponse(new Response('x'.repeat(maxJSONBytes + 1)))).rejects.toThrow('response_too_large');
    await expect(readBridgeResponse(new Response('secret filesystem path', { status: 410 }))).rejects.toThrow('window_revoked');
  });
});
