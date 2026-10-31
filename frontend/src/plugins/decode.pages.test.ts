import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';

const inspection = (contributes: Record<string, unknown>, permissions: string[] = ['ui.pages'], window?: unknown) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'example.pages',
    name: 'Pages',
    version: '1.0.0',
    permissions,
    ...(window === undefined ? {} : { window }),
    contributes,
  },
  digest: 'a'.repeat(64),
  sourcePath: '/tmp/package',
  sizeBytes: 12,
});

const textPage = (id: string, title: string = id) =>
  ({ id, title, body: { type: 'text', text: 'hello' } });
const htmlPage = (id: string, title: string = id, source: string = '<h1>Hi</h1>') =>
  ({ id, title, html: { source } });
const nav = (id: string, page: string, over: Record<string, unknown> = {}) =>
  ({ id, title: id, page, location: 'tools', ...over });
const rejects = (contributes: Record<string, unknown>, permissions?: string[], window?: unknown) =>
  expect(() => decodeInspection(inspection(contributes, permissions, window))).toThrow('plugin.error.invalid_response');

describe('manifest pages', () => {
  it('accepts declared pages with navigation to a declared page', () => {
    const result = decodeInspection(inspection({
      pages: [textPage('overview'), htmlPage('dashboard')],
      navigation: [nav('overview-tools', 'overview')],
    }, ['ui.pages', 'ui.html-panel']));
    expect(result.manifest.contributes?.pages).toHaveLength(2);
    expect(result.manifest.contributes?.navigation?.[0]).toMatchObject({ page: 'overview', location: 'tools' });
  });

  it('requires ui.pages before a manifest may declare pages or navigation', () => {
    rejects({ pages: [textPage('overview')] }, []);
    rejects({ navigation: [nav('overview-tools', 'overview')] }, []);
    expect(decodeInspection(inspection({ pages: [], navigation: [] }, [])).manifest.contributes?.pages).toEqual([]);
  });

  it('requires ui.html-panel for an html page', () => {
    rejects({ pages: [htmlPage('dashboard')] }, ['ui.pages']);
  });

  it('requires exactly one of body and html', () => {
    rejects({ pages: [{ id: 'both', title: 'Both', body: { type: 'text', text: 'x' }, html: { source: '<p>x</p>' } }] },
      ['ui.pages', 'ui.html-panel']);
    rejects({ pages: [{ id: 'neither', title: 'Neither' }] }, ['ui.pages']);
  });

  it('rejects duplicate page ids but allows the same id in navigation', () => {
    rejects({ pages: [textPage('overview'), textPage('overview')] });
    const result = decodeInspection(inspection({
      pages: [textPage('overview')],
      navigation: [nav('overview', 'overview')],
    }));
    expect(result.manifest.contributes?.navigation).toHaveLength(1);
  });

  it('rejects unknown keys, empty titles and over-limit counts', () => {
    rejects({ pages: [{ ...textPage('overview'), extra: true }] });
    rejects({ pages: [textPage('overview', '  ')] });
    rejects({ pages: [textPage('overview', 'x'.repeat(257))] });
    rejects({ pages: Array.from({ length: 33 }, (_, index) => textPage('page' + index)) });
    rejects({ navigation: [nav('n', 'missing')] });
  });

  it('rejects an invalid declarative body and unsafe html', () => {
    rejects({ pages: [{ id: 'bad', title: 'Bad', body: { type: 'text', text: 'x', extra: true } }] });
    rejects({ pages: [htmlPage('empty', 'Empty', '   ')], }, ['ui.pages', 'ui.html-panel']);
    rejects({ pages: [htmlPage('nul', 'Nul', 'a\u0000b')] }, ['ui.pages', 'ui.html-panel']);
  });
});

describe('manifest navigation', () => {
  it('rejects references to undeclared pages, unknown locations and out-of-range order', () => {
    const pages = [textPage('overview')];
    rejects({ pages, navigation: [nav('a', 'missing')] });
    rejects({ pages, navigation: [nav('b', 'overview', { location: 'sidebar' })] });
    rejects({ pages, navigation: [nav('c', 'overview', { order: 1001 })] });
    rejects({ pages, navigation: [nav('d', 'overview', { order: -1001 })] });
    rejects({ pages, navigation: [nav('e', 'overview', { order: 1.5 })] });
  });

  it('accepts the inclusive order bounds and a missing order', () => {
    const pages = [textPage('overview')];
    const result = decodeInspection(inspection({
      pages,
      navigation: [nav('a', 'overview', { order: -1000 }), nav('b', 'overview', { order: 1000 }), nav('c', 'overview')],
    }));
    expect(result.manifest.contributes?.navigation).toHaveLength(3);
  });

  it('rejects navigation without any pages, duplicate ids and unknown keys', () => {
    rejects({ navigation: [nav('a', 'overview')] });
    rejects({ pages: [textPage('overview')], navigation: [nav('a', 'overview'), nav('a', 'overview')] });
    rejects({ pages: [textPage('overview')], navigation: [{ ...nav('a', 'overview'), extra: true }] });
    rejects({ pages: [textPage('overview')], navigation: Array.from({ length: 33 }, (_, index) => nav('n' + index, 'overview')) });
  });

  it('accepts a window target only when the manifest declares the window', () => {
    const window = { entry: 'index.html' };
    const result = decodeInspection(inspection({ navigation: [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }] }, [], window));
    expect(result.manifest.contributes?.navigation?.[0]).toMatchObject({ target: 'window' });
    // 窗口目标不开页面，因此不要求 ui.pages。
    rejects({ navigation: [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }] }, [], undefined);
    rejects({ navigation: [{ id: 'ssh', title: 'SSH', target: 'window', page: 'overview', location: 'tools' }] }, [], window);
    rejects({ pages: [textPage('overview')], navigation: [{ id: 'ssh', title: 'SSH', target: 'window2', location: 'tools' }] }, ['ui.pages'], window);
  });
});

