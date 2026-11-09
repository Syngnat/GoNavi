import { describe, expect, it } from 'vitest';
import { marketInspectionRequest, marketInstallConfirmationMatches, marketInstallIdentity, marketInstallRepository } from './installIdentity';
import type { MarketPlugin } from './types';

const sourceId = 'a'.repeat(64);
const plugin: MarketPlugin = {
  id: 'com.gonavi.tool', name: 'Tool', description: '', author: 'GoNavi', publisherId: 'com.gonavi', official: true,
  version: '1.2.3', platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
  sourceId, sourceUrl: ' https://github.com/gonavi/tool ',
  artifact: { url: 'https://market.example/artifact', sha256: 'b'.repeat(64), sizeBytes: 1024, platform: 'any', version: '1.2.3' },
};

describe('market install identity', () => {
  it('prefers the published repository and trims it', () => {
    expect(marketInstallRepository(plugin, ' https://market.example/ ')).toBe('https://github.com/gonavi/tool');
  });
  it('falls back to the market source when no repository is published', () => {
    expect(marketInstallRepository({ ...plugin, sourceUrl: undefined }, ' https://market.example/ ')).toBe('https://market.example/');
  });
  it('compares the typed repository after trimming', () => {
    const expected = marketInstallIdentity(plugin, 'https://market.example');
    expect(marketInstallConfirmationMatches(expected, '  https://github.com/gonavi/tool ')).toBe(true);
    expect(marketInstallConfirmationMatches(expected, 'https://github.com/other/tool')).toBe(false);
    expect(marketInstallConfirmationMatches(expected, '   ')).toBe(false);
  });
  it('builds an inspection request bound to the source and artifact', () => {
    expect(marketInspectionRequest(plugin, sourceId)).toEqual({ id: 'com.gonavi.tool', version: '1.2.3',
      artifactDigest: 'b'.repeat(64), sourceId, sizeBytes: 1024 });
  });
  it('rejects a request that cannot be bound to the inspected source', () => {
    expect(marketInspectionRequest(plugin, 'c'.repeat(64))).toBeNull();
    expect(marketInspectionRequest({ ...plugin, sourceId: 'c'.repeat(64) }, sourceId)).toBeNull();
    expect(marketInspectionRequest({ ...plugin, artifact: undefined }, sourceId)).toBeNull();
    expect(marketInspectionRequest({ ...plugin, artifact: { ...plugin.artifact!, version: '1.2.2' } }, sourceId)).toBeNull();
    expect(marketInspectionRequest({ ...plugin, artifact: { ...plugin.artifact!, sizeBytes: 0 } }, sourceId)).toBeNull();
  });
});
