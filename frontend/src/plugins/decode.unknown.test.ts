import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';
const inspection = (extra: Record<string, unknown>) => ({
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'example.host', name: 'Host', version: '1.0.0', permissions: [], ...extra },
  digest: 'a'.repeat(64), sourcePath: 'fixture', sizeBytes: 10,
});
describe('unknown manifest fields', () => {
  it('rejects a long unknown field without echoing its name', () => {
    const name = '文'.repeat(80);
    expect(() => decodeInspection(inspection({ [name]: 1 }))).toThrowError(expect.objectContaining({ message: 'plugin.error.invalid_response' }));
    try { decodeInspection(inspection({ [name]: 1 })); } catch (error) {
      expect(String(error)).not.toContain('文文文');
    }
    expect(() => decodeInspection(inspection({ contributes: { commands: [{ id: 'run', title: 'Run', [name]: true }] } }))).toThrow('plugin.error.invalid_response');
    expect(() => decodeInspection(inspection({ window: { entry: 'bin/plugin', [name]: true } }))).toThrow('plugin.error.invalid_response');
    expect(() => decodeInspection(inspection({ backend: { default: { executable: 'bin/plugin', [name]: true } } }))).toThrow('plugin.error.invalid_response');
    expect(() => decodeInspection(inspection({ contributes: { panels: [{ id: 'main', title: 'Panel', body: { type: 'text', text: 'ok', [name]: true } }] } }))).toThrow('plugin.error.invalid_response');
    expect(() => decodeInspection(inspection({ contributes: { commands: [{ id: 'ask', title: 'Ask' }], aiProviders: [{ id: 'chat', name: 'Chat', command: 'ask', supportsTools: false, supportsImages: false, models: [{ id: 'm', name: 'M', contextWindow: 1024, maxOutputTokens: 1, [name]: true }] }] } }))).toThrow('plugin.error.invalid_response');
  });
  it('accepts safe package raster icons without rejecting the host response', () => {
    for (const icon of ['frontend/icon.png', 'icon.JPG', 'icon.jpeg', 'icon.webp', 'icon.gif', '']) {
      expect(decodeInspection(inspection({ icon })).manifest.icon).toBe(icon);
    }
    expect(decodeInspection(inspection({})).manifest.icon).toBeUndefined();
  });
  it('keeps the host icon path byte limit', () => {
    const boundary = 'frontend/' + 'a'.repeat(239) + '/img.png';
    expect(decodeInspection(inspection({ icon: boundary })).manifest.icon).toBe(boundary);
    for (const icon of ['frontend/' + 'a'.repeat(239) + '/imgs.png', '图'.repeat(75) + '/' + '图'.repeat(9) + '.png']) {
      expect(() => decodeInspection(inspection({ icon }))).toThrow('plugin.error.invalid_response');
    }
  });
  it('rejects unsafe icon paths and invalid types', () => {
    for (const icon of [null, false, 1, {}, [], 'icon.svg', '/icon.png', '../icon.png', 'frontend/../icon.png',
      './icon.png', 'frontend//icon.png', 'frontend/./icon.png', 'frontend' + String.fromCharCode(92) + 'icon.png', 'C:/icon.png',
      'https://example.com/icon.png', 'data:image/png;base64,AA==', 'icon.png?x=1', 'icon.png#x',
      'icon\u0000.png', 'con.png', 'frontend/ /icon.png']) {
      expect(() => decodeInspection(inspection({ icon }))).toThrow('plugin.error.invalid_response');
    }
  });
  it('still rejects unknown fields when an icon is present', () => {
    expect(() => decodeInspection(inspection({ icon: 'frontend/icon.png', unexpected: true })))
      .toThrow('plugin.error.invalid_response');
  });
});
