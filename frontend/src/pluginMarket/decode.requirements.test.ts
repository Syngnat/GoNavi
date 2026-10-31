import { describe, expect, it } from 'vitest';
import { decodeMarketPlugin } from './decode';
const plugin = { id: 'com.gonavi.nginx-inspector', name: 'Nginx Inspector', description: '', author: 'GoNavi', publisherId: 'com.gonavi',
  official: true, version: '1.0.0', updatedAt: 'now', platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0 };
describe('minimum host requirement boundary', () => {
  it('keeps the published requirement available to the UI', () => {
    expect(decodeMarketPlugin({ ...plugin, minHostVersion: '1.1.5' }).minHostVersion).toBe('1.1.5');
  });
  it('continues to accept entries without a requirement', () => {
    expect(decodeMarketPlugin(plugin).minHostVersion).toBeUndefined();
  });
  it.each([1, true, {}, 'v'.repeat(129)])('rejects malformed requirements: %j', (minHostVersion) => {
    expect(() => decodeMarketPlugin({ ...plugin, minHostVersion })).toThrow();
  });
});
