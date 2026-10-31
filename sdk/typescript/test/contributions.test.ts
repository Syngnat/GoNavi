import { describe, expect, it } from 'vitest';
import type { Manifest } from '../src/types.js';

describe('shipped contribution names', () => {
  it('round-trips data sources, skills, providers, and exporters', () => {
    const manifest: Manifest = {
      schemaVersion: 1, apiVersion: 1, id: 'example.bundle', name: 'Bundle', version: '1.0.0',
      permissions: ['data.sources', 'ai.skills', 'ai.providers', 'data.export'],
      contributes: {
        dataSources: [{ id: 'db', name: 'DB', dialect: 'sqlite', command: 'db', readOnly: true }],
        skills: [{ id: 'guide', name: 'Guide', description: 'Read', entry: 'SKILL.md', resources: ['NOTES.md'] }],
        aiProviders: [{ id: 'chat', name: 'Chat', command: 'chat', models: [{ id: 'm', name: 'M', contextWindow: 8, maxOutputTokens: 2 }], supportsTools: true, supportsImages: false }],
        exporters: [{ id: 'ndjson', name: 'NDJSON', command: 'export', extension: 'ndjson', contentType: 'application/x-ndjson' }],
        pages: [{ id: 'overview', title: 'Overview', body: { type: 'text', text: 'hello' } }],
        navigation: [{ id: 'overview-tools', title: 'Overview', page: 'overview', location: 'tools' }],
      },
    };
    const raw = JSON.stringify(manifest);
    expect(raw).toContain('"dataSources"');
    expect(raw).toContain('"skills"');
    expect(raw).toContain('"resources"');
    expect(raw).toContain('"aiProviders"');
    expect(raw).toContain('"supportsImages":false');
    expect(raw).toContain('"exporters"');
    expect(raw).toContain('"pages"');
    expect(raw).toContain('"navigation"');
    expect(raw).toContain('"location":"tools"');
    const decoded = JSON.parse(raw) as Manifest;
    expect(decoded.contributes?.dataSources?.[0].readOnly).toBe(true);
    expect(decoded.contributes?.exporters).toHaveLength(1);
    expect(decoded.contributes?.aiProviders?.[0].supportsImages).toBe(false);
    expect(decoded.contributes?.pages?.[0].id).toBe('overview');
    expect(decoded.contributes?.navigation?.[0].page).toBe('overview');
  });
});
