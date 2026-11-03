import { describe, expect, it } from 'vitest';
import { validatePages } from '../src/pagesDeclaration.js';
import { parseManifest } from '../src/manifestParse.js';
import type { Manifest, Page } from '../src/types.js';

function manifest(permissions: string[]): Manifest {
  return {
    schemaVersion: 1, apiVersion: 1, id: 'example.pages', name: 'Pages', version: '1.0.0',
    permissions, contributes: { commands: [{ id: 'refresh', title: 'Refresh', effect: 'read' }] },
  };
}

const textPage = (id: string, title: string): Page => ({ id, title, body: { type: 'text', text: 'hello' } });

describe('page declarations', () => {
  it('accepts declarative and html pages with tools navigation', () => {
    const value = manifest(['ui.pages', 'ui.html-panel']);
    value.contributes!.pages = [
      { id: 'overview', title: 'Overview', body: { type: 'column', children: [{ type: 'text', text: 'hello' }, { type: 'button', title: 'Refresh', command: 'refresh' }] } },
      { id: 'dashboard', title: 'Dashboard', html: { source: '<h1>Dashboard</h1>' } },
    ];
    value.contributes!.navigation = [
      { id: 'overview-tools', title: 'Overview', page: 'overview', location: 'tools', order: -1000 },
      { id: 'dashboard-tools', title: 'Dashboard', page: 'dashboard', location: 'tools', order: 1000 },
    ];
    expect(() => validatePages(value)).not.toThrow();
  });

  it('keeps manifests without pages valid', () => {
    expect(() => validatePages(manifest([]))).not.toThrow();
  });

  it('requires ui.pages and ui.html-panel', () => {
    const value = manifest([]);
    value.contributes!.pages = [textPage('overview', 'Overview')];
    expect(() => validatePages(value)).toThrow(/ui\.pages/);
    value.permissions = ['ui.pages'];
    expect(() => validatePages(value)).not.toThrow();
    value.contributes!.pages.push({ id: 'dashboard', title: 'Dashboard', html: { source: '<h1>Dashboard</h1>' } });
    expect(() => validatePages(value)).toThrow(/ui\.html-panel/);
  });

  it('rejects duplicate, exclusive and unknown declarations', () => {
    const cases: [string, (value: Manifest) => void, RegExp][] = [
      ['duplicate page id', (value) => { value.contributes!.pages = [textPage('overview', 'Overview'), textPage('overview', 'Again')]; }, /duplicate page/],
      ['duplicate navigation id', (value) => {
        value.contributes!.pages = [textPage('overview', 'Overview')];
        value.contributes!.navigation = [
          { id: 'entry', title: 'One', page: 'overview', location: 'tools' },
          { id: 'entry', title: 'Two', page: 'overview', location: 'tools' },
        ];
      }, /duplicate navigation/],
      ['body and html', (value) => { value.contributes!.pages = [{ id: 'overview', title: 'Overview', body: { type: 'text', text: 'x' }, html: { source: '<h1>x</h1>' } }]; }, /both/],
      ['no body', (value) => { value.contributes!.pages = [{ id: 'overview', title: 'Overview' }]; }, /no body/],
      ['empty title', (value) => { value.contributes!.pages = [textPage('overview', '  ')]; }, /invalid or duplicate page/],
      ['oversized title', (value) => { value.contributes!.pages = [textPage('overview', 'a'.repeat(257))]; }, /invalid or duplicate page/],
      ['bad id', (value) => { value.contributes!.pages = [textPage('../escape', 'Escape')]; }, /invalid or duplicate page/],
      ['empty html', (value) => { value.contributes!.pages = [{ id: 'dashboard', title: 'Dashboard', html: { source: ' ' } }]; }, /empty/],
      ['unknown page', (value) => {
        value.contributes!.pages = [textPage('overview', 'Overview')];
        value.contributes!.navigation = [{ id: 'entry', title: 'One', page: 'missing', location: 'tools' }];
      }, /undeclared page/],
      ['unsupported location', (value) => {
        value.contributes!.pages = [textPage('overview', 'Overview')];
        value.contributes!.navigation = [{ id: 'entry', title: 'One', page: 'overview', location: 'statusbar' as 'tools' }];
      }, /location/],
      ['order below range', (value) => {
        value.contributes!.pages = [textPage('overview', 'Overview')];
        value.contributes!.navigation = [{ id: 'entry', title: 'One', page: 'overview', location: 'tools', order: -1001 }];
      }, /order/],
      ['order above range', (value) => {
        value.contributes!.pages = [textPage('overview', 'Overview')];
        value.contributes!.navigation = [{ id: 'entry', title: 'One', page: 'overview', location: 'tools', order: 1001 }];
      }, /order/],
      ['undeclared button command', (value) => { value.contributes!.pages = [{ id: 'overview', title: 'Overview', body: { type: 'button', title: 'Run', command: 'missing' } }]; }, /undeclared command/],
      ['unsupported node', (value) => { value.contributes!.pages = [{ id: 'overview', title: 'Overview', body: { type: 'iframe' } as unknown as Page['body'] }]; }, /unsupported page element/],
    ];
    for (const [name, mutate, expected] of cases) {
      const value = manifest(['ui.pages', 'ui.html-panel']);
      mutate(value);
      expect(() => validatePages(value), name).toThrow(expected);
    }
  });

  it('rejects more than 32 pages or navigation entries', () => {
    const value = manifest(['ui.pages']);
    value.contributes!.pages = Array.from({ length: 32 }, (_, index) => textPage(`page${index}`, 'Page'));
    value.contributes!.navigation = [{ id: 'entry', title: 'Entry', page: 'page0', location: 'tools' }];
    expect(() => validatePages(value)).not.toThrow();
    value.contributes!.pages.push(textPage('extra', 'Extra'));
    expect(() => validatePages(value)).toThrow(/too many pages/);
    value.contributes!.pages.pop();
    value.contributes!.navigation = Array.from({ length: 33 }, (_, index) => ({ id: `entry${index}`, title: 'Entry', page: 'page0', location: 'tools' as const }));
    expect(() => validatePages(value)).toThrow(/too many pages/);
  });

  it('treats an empty navigation target as the page target', () => {
    const value = manifest(['ui.pages']);
    value.contributes!.pages = [textPage('overview', 'Overview')];
    value.contributes!.navigation = [{ id: 'entry', title: 'Entry', target: '' as 'page', page: 'overview', location: 'tools' }];
    expect(() => validatePages(value)).not.toThrow();
  });

  it('accepts a window target only when the manifest declares the window', () => {
    const windowed = manifest([]);
    windowed.window = { entry: 'index.html' };
    windowed.contributes!.navigation = [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }];
    expect(() => validatePages(windowed)).not.toThrow();

    const missingWindow = manifest([]);
    missingWindow.contributes!.navigation = [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }];
    expect(() => validatePages(missingWindow)).toThrow(/window navigation requires a window/);

    const withPage = manifest([]);
    withPage.window = { entry: 'index.html' };
    withPage.contributes!.navigation = [{ id: 'ssh', title: 'SSH', target: 'window', page: 'overview', location: 'tools' }];
    expect(() => validatePages(withPage)).toThrow(/window navigation cannot declare a page/);

    const unknown = manifest(['ui.pages']);
    unknown.window = { entry: 'index.html' };
    unknown.contributes!.navigation = [{ id: 'ssh', title: 'SSH', target: 'popover' as 'page', location: 'tools' }];
    expect(() => validatePages(unknown)).toThrow(/unsupported navigation target/);

    expect(() => parseManifest({
      schemaVersion: 1, apiVersion: 1, id: 'example.pages', name: 'Pages', version: '1.0.0',
      permissions: [], window: { entry: 'index.html' },
      contributes: { navigation: [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }] },
    })).not.toThrow();
  });

  it('rejects page nodes the renderer cannot draw and reserved-command buttons', () => {
    const reserved = manifest(['ui.pages', 'data.sources']);
    reserved.backend = { default: { executable: 'backend' } };
    reserved.contributes!.commands = [{ id: 'query', title: 'Query', effect: 'read' }];
    reserved.contributes!.dataSources = [{ id: 'db', name: 'DB', dialect: 'mysql', command: 'query', readOnly: true }];
    reserved.contributes!.pages = [{ id: 'main', title: 'Main', body: { type: 'button', title: 'Run', command: 'query' } }];
    expect(() => validatePages(reserved)).toThrow(/undeclared command/);

    const fields = manifest(['ui.pages']);
    fields.contributes!.pages = [{ id: 'text', title: 'Text', body: { type: 'text', text: 'x', children: [{ type: 'text', text: 'y' }] } as unknown as Page['body'] }];
    expect(() => validatePages(fields)).toThrow(/element field/);
  });

  it('parses shipped page fields and rejects unknown nested keys', () => {
    const value = { schemaVersion: 1, apiVersion: 1, id: 'example.pages', name: 'Pages', version: '1.0.0', permissions: ['ui.pages'], contributes: { pages: [textPage('overview', 'Overview')], navigation: [{ id: 'entry', title: 'Entry', page: 'overview', location: 'tools' }] } };
    const parsed = parseManifest(value);
    expect(parsed.contributes?.pages).toHaveLength(1);
    expect(parsed.contributes?.navigation?.[0].location).toBe('tools');
    expect(() => parseManifest({ ...value, contributes: { pages: [{ ...textPage('overview', 'Overview'), extra: true }] } })).toThrow(/^unknown manifest field/);
    expect(() => parseManifest({ ...value, contributes: { navigation: [{ id: 'entry', title: 'Entry', page: 'overview', location: 'tools', extra: true }] } })).toThrow(/^unknown manifest field/);
    expect(() => parseManifest({ ...value, contributes: { pages: [{ id: 'dashboard', title: 'Dashboard', html: { source: '<h1>x</h1>', extra: true } }] } })).toThrow(/^unknown manifest field/);
  });
});
