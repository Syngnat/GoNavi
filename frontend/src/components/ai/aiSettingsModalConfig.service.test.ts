import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAIService, withoutPromiseAdapters } from './aiSettingsModalConfig';

describe('waitForAIService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not treat a web service proxy as a thenable', async () => {
    const calls: string[] = [];
    const service = new Proxy({}, {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return () => {
          calls.push(property);
          return Promise.resolve(property === 'AIGetProviders' ? [{ id: 'gonavi-ai' }] : 'gonavi-ai');
        };
      },
    });
    vi.stubGlobal('window', { go: { aiservice: { Service: service } } });

    const resolved = await waitForAIService(1, 0);

    expect(calls).not.toContain('then');
    expect(resolved).toBeTruthy();
    await expect(resolved.AIGetProviders()).resolves.toEqual([{ id: 'gonavi-ai' }]);
    expect(calls).toEqual(['AIGetProviders']);
  });

  it('hides promise adapters without dropping real methods', () => {
    const service = {
      then: () => Promise.resolve('stuck'),
      AIGetActiveProvider: () => 'current',
    };

    const resolved = withoutPromiseAdapters(service);

    expect(resolved.then).toBeUndefined();
    expect(resolved.AIGetActiveProvider()).toBe('current');
  });
});
