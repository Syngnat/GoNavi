import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/manifestParse.js';
const base = { schemaVersion: 1, apiVersion: 1, id: 'example.host', name: 'Host', version: '1.0.0', permissions: [] };
describe('manifest parse', () => {
  it('accepts a small manifest and rejects nested unknown fields without echoing them', () => {
    expect(parseManifest(base).id).toBe('example.host');
    const name = '文'.repeat(80);
    expect(() => parseManifest({ ...base, contributes: { panels: [{ id: 'main', title: 'Panel', body: { type: 'text', text: 'ok', [name]: true } }] } })).toThrow(/^unknown manifest field$/);
    expect(() => parseManifest({ ...base, contributes: { aiProviders: [{ id: 'chat', name: 'Chat', command: 'ask', supportsTools: false, supportsImages: false, models: [{ id: 'm', name: 'M', contextWindow: 1024, maxOutputTokens: 1, [name]: true }] }] } })).toThrow(/^unknown manifest field$/);
    expect(() => parseManifest({ ...base, description: '文'.repeat(400000) })).toThrow(/^manifest exceeds size limit$/);
  });

  it('accepts the optional top-level plugin icon', () => {
    expect(parseManifest({ ...base, icon: 'icons/logo.png' }).icon).toBe('icons/logo.png');
    expect(parseManifest(base).icon).toBeUndefined();
  });
});
