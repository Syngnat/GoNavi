import { describe, expect, it } from 'vitest';
import { findInstalledPluginUpdate, preferredInstalledPluginUpdate } from './installedPluginUpdates';
import type { MarketSource } from './types';
import type { MarketVersionChoice } from './versionsApi';

const source: MarketSource = { sourceId: 'a'.repeat(64), baseUrl: 'https://market.test', enabled: true, trustedOfficial: true };
const installed = { id: 'com.gonavi.mongo-shell', version: '1.0.1' };
function choice(version: string): MarketVersionChoice {
  return { compatible: true, reason: '', plugin: {
    id: installed.id, version, sourceId: source.sourceId, name: 'MongoShell', description: '', author: '', publisherId: 'com.gonavi', official: true,
    updatedAt: '', platforms: ['darwin/arm64'], ratingAverage: 0, ratingCount: 0, downloadCount: 0,
    artifact: { version, sha256: 'b'.repeat(64), sizeBytes: 100, platform: 'all', url: 'https://market.test/artifact' },
  } };
}

describe('installed plugin update candidates', () => {
  it('finds the highest compatible stable version, independent of response order', () => {
    const result = findInstalledPluginUpdate(installed, source, [choice('1.0.2'), choice('2.0.0-rc.1'), choice('1.0.4'), choice('1.0.3')]);
    expect(result?.plugin.version).toBe('1.0.4');
    expect(result?.installedVersion).toBe('1.0.1');
    expect(result?.source).toEqual(source);
  });
  it.each(['1.0.1', '1.0.0', '1.0.1+new-build', '2.0.0-rc.1', 'invalid'])('does not offer %s to a stable installation', (version) => {
    expect(findInstalledPluginUpdate(installed, source, [choice(version)])).toBeUndefined();
  });
  it('can update an explicitly installed prerelease without opting stable users into it', () => {
    expect(findInstalledPluginUpdate({ ...installed, version: '2.0.0-rc.1' }, source, [choice('2.0.0-rc.2')])?.plugin.version).toBe('2.0.0-rc.2');
  });
  it.each(['disabled source', 'foreign source', 'foreign id', 'incompatible', 'missing artifact', 'wrong artifact version', 'bad digest', 'empty package', 'invalid url'])('does not offer an unverified %s candidate', (mode) => {
    const candidate = choice('1.0.2');
    const configured = { ...source };
    if (mode === 'disabled source') configured.enabled = false;
    if (mode === 'foreign source') candidate.plugin.sourceId = 'c'.repeat(64);
    if (mode === 'foreign id') candidate.plugin.id = 'another.plugin';
    if (mode === 'incompatible') { candidate.compatible = false; candidate.reason = 'host_version'; }
    if (mode === 'missing artifact') candidate.plugin.artifact = undefined;
    if (mode === 'wrong artifact version') candidate.plugin.artifact!.version = '1.0.1';
    if (mode === 'bad digest') candidate.plugin.artifact!.sha256 = 'invalid';
    if (mode === 'empty package') candidate.plugin.artifact!.sizeBytes = 0;
    if (mode === 'invalid url') candidate.plugin.artifact!.url = 'javascript:alert(1)';
    expect(findInstalledPluginUpdate(installed, configured, [candidate])).toBeUndefined();
  });
  it('prefers the configured official source without trusting another source official claim', () => {
    const official = findInstalledPluginUpdate(installed, source, [choice('1.0.2')])!;
    const privateSource = { ...source, sourceId: 'c'.repeat(64), baseUrl: 'https://private.test', trustedOfficial: false };
    const newer = choice('9.0.0'); newer.plugin.sourceId = privateSource.sourceId;
    const privateUpdate = findInstalledPluginUpdate(installed, privateSource, [newer])!;
    expect(preferredInstalledPluginUpdate([privateUpdate, official])).toEqual(official);
    expect(preferredInstalledPluginUpdate([privateUpdate])?.source.trustedOfficial).toBe(false);
  });
});
