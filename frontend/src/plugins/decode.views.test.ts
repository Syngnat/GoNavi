import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';

const inspection = (contributes: Record<string, unknown>, permissions: string[] = ['ui.pages']) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'example.views',
    name: 'Views',
    version: '1.0.0',
    permissions,
    contributes,
  },
  digest: 'a'.repeat(64),
  sourcePath: '/tmp/package',
  sizeBytes: 12,
});

const textPage = (id: string, title: string = id) => ({ id, title, body: { type: 'text', text: 'hello' } });
const view = (over: Record<string, unknown> = {}) =>
  ({ id: 'term', title: 'Terminal', page: 'terminal', location: 'right', ...over });
const rejects = (contributes: Record<string, unknown>, permissions?: string[]) =>
  expect(() => decodeInspection(inspection(contributes, permissions))).toThrow('plugin.error.invalid_response');

describe('manifest views', () => {
  it('accepts a right-dock view backed by a declared page', () => {
    const result = decodeInspection(inspection({ pages: [textPage('terminal')], views: [view()] }));
    expect(result.manifest.contributes?.views?.[0]).toMatchObject({ id: 'term', page: 'terminal', location: 'right' });
  });

  it('rejects views without ui.pages or a declared page', () => {
    rejects({ pages: [textPage('terminal')], views: [view()] }, []);
    rejects({ pages: [textPage('terminal')], views: [view({ page: 'missing' })] });
  });

  it('rejects unsupported or malformed declarations', () => {
    rejects({ pages: [textPage('terminal')], views: [view({ location: 'bottom' })] });
    rejects({ pages: [textPage('terminal')], views: [view({ title: '' })] });
    rejects({ pages: [textPage('terminal')], views: [view(), view()] });
  });

  it('accepts a panel sidebar target that references a declared view', () => {
    const result = decodeInspection(inspection({
      commands: [{ id: 'list', title: 'List' }],
      pages: [textPage('terminal')],
      views: [view()],
      sidebar: [{ id: 'ssh', title: 'SSH', listCommand: 'list', open: { type: 'panel', view: 'term' } }],
    }, ['ui.pages', 'ui.sidebar']));
    expect(result.manifest.contributes?.sidebar?.[0].open).toMatchObject({ type: 'panel', view: 'term' });
  });

  it('rejects a panel target for an undeclared view', () => {
    rejects({
      commands: [{ id: 'list', title: 'List' }],
      pages: [textPage('terminal')],
      views: [view()],
      sidebar: [{ id: 'ssh', title: 'SSH', listCommand: 'list', open: { type: 'panel', view: 'missing' } }],
    }, ['ui.pages', 'ui.sidebar']);
  });
});
