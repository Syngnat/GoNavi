import { describe, expect, it } from 'vitest';
import { decodeMarketPlugin } from './decode';

describe('marketplace AI provider manifest compatibility', () => {
  it('accepts a declared provider icon returned by the marketplace', () => {
    const plugin = decodeMarketPlugin({
      id: 'gh-syngnat.market-e2e-ai-provider',
      name: 'Market E2E AI Provider',
      description: 'End-to-end provider transport fixture.',
      author: 'Syngnat',
      publisherId: 'gh-syngnat',
      official: false,
      version: '1.0.0',
      category: 'ai-provider',
      platforms: ['darwin/arm64'],
      ratingAverage: 0,
      ratingCount: 0,
      downloadCount: 0,
      updatedAt: '2026-10-26T07:25:05.322986Z',
      manifest: {
        schemaVersion: 1,
        apiVersion: 1,
        id: 'gh-syngnat.market-e2e-ai-provider',
        name: 'Market E2E AI Provider',
        version: '1.0.0',
        description: 'End-to-end provider transport fixture.',
        author: 'Syngnat',
        license: 'Apache-2.0',
        permissions: ['ai.providers'],
        backend: { platforms: { 'darwin/arm64': { executable: 'bin/plugin', runtime: 'native' } } },
        contributes: {
          commands: [{ id: 'provider', title: 'HTTP AI provider transport', effect: 'read' }],
          aiProviders: [{
            id: 'http',
            name: 'HTTP/SSE (configured upstream)',
            command: 'provider',
            icon: 'icons/provider.png',
            models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxOutputTokens: 16384 }],
            supportsTools: true,
            supportsImages: false,
          }],
        },
      },
      artifact: {
        url: 'https://plugin.gonavi.org/api/v1/artifacts/7a8923649be23afc8e124d83b1795d7b9a5344f85f52bf0bf6b0b3a8f26b6c2e',
        sha256: '7a8923649be23afc8e124d83b1795d7b9a5344f85f52bf0bf6b0b3a8f26b6c2e',
        sizeBytes: 5608364,
        platform: 'darwin/arm64',
        version: '1.0.0',
      },
    });
    expect(plugin.id).toBe('gh-syngnat.market-e2e-ai-provider');
    expect(plugin.manifest?.contributes?.aiProviders?.[0]?.id).toBe('http');
    expect(plugin.manifest?.contributes?.aiProviders?.[0]?.icon).toBe('icons/provider.png');
  });
});
