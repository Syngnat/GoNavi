import { describe, expect, it } from 'vitest';
import { decodeManifest } from './decode';

const manifest = (panel: unknown, permissions: string[] = ['ui.html-panel']) => ({
  schemaVersion: 1,
  apiVersion: 1,
  id: 'com.example.dashboard',
  name: 'Dashboard',
  version: '1.0.0',
  permissions,
  contributes: { panels: [panel] },
});

describe('custom HTML panel decoding', () => {
  it('keeps a bounded HTML source for the sandboxed main-window frame', () => {
    const parsed = decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: '<h1>Hello</h1>' } }));
    expect(parsed.contributes?.panels?.[0].html?.source).toBe('<h1>Hello</h1>');
  });

  it('requires the declared permission and exactly one panel body', () => {
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: '<p>x</p>' } }, []))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: '<p>x</p>' }, body: { type: 'text', text: 'x' } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview' }))).toThrow();
  });

  it('tolerates the zero-value body older hosts still serialize for HTML-only panels', () => {
    const parsed = decodeManifest(manifest({ id: 'overview', title: 'Overview', body: { type: '' }, html: { source: '<p>x</p>' } }));
    expect(parsed.contributes?.panels?.[0].html?.source).toBe('<p>x</p>');
    expect(parsed.contributes?.panels?.[0].body).toBeUndefined();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', body: { type: '' } }))).toThrow();
  });

  it('rejects malformed, empty, NUL-containing and oversized markup', () => {
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: '<p>x</p>', extra: true } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: '   ' } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: 'a\u0000b' } }))).toThrow();
    expect(() => decodeManifest(manifest({ id: 'overview', title: 'Overview', html: { source: 'a'.repeat((256 << 10) + 1) } }))).toThrow();
  });
});
