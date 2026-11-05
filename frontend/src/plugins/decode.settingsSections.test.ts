import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';

const inspection = (contributes: Record<string, unknown>, permissions: string[] = ['ui.pages']) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'example.settings',
    name: 'Settings',
    version: '1.0.0',
    permissions,
    contributes,
  },
  digest: 'a'.repeat(64),
  sourcePath: '/tmp/package',
  sizeBytes: 12,
});

const textPage = (id: string, title: string = id) => ({ id, title, body: { type: 'text', text: 'hello' } });
const section = (over: Record<string, unknown> = {}) =>
  ({ id: 'background', slot: 'appearance.background', page: 'background', ...over });
const rejects = (contributes: Record<string, unknown>, permissions?: string[]) =>
  expect(() => decodeInspection(inspection(contributes, permissions))).toThrow('plugin.error.invalid_response');

describe('manifest settings sections', () => {
  it('accepts a background section backed by a declared page', () => {
    const result = decodeInspection(inspection({
      pages: [textPage('background')],
      settingsSections: [section({ title: '背景图片', description: '设置背景' })],
    }));
    expect(result.manifest.contributes?.settingsSections?.[0]).toMatchObject({
      id: 'background',
      slot: 'appearance.background',
      page: 'background',
      title: '背景图片',
    });
  });

  it('rejects sections without ui.pages or a declared page', () => {
    rejects({ pages: [textPage('background')], settingsSections: [section()] }, []);
    rejects({ pages: [textPage('background')], settingsSections: [section({ page: 'missing' })] });
  });

  it('rejects unknown slots, duplicate slots and malformed entries', () => {
    rejects({ pages: [textPage('background')], settingsSections: [section({ slot: 'appearance.toolbar' })] });
    rejects({ pages: [textPage('background')], settingsSections: [section(), section({ id: 'second' })] });
    rejects({ pages: [textPage('background')], settingsSections: [section(), section()] });
    rejects({ pages: [textPage('background')], settingsSections: [section({ order: 1001 })] });
    rejects({ pages: [textPage('background')], settingsSections: [section({ title: 'x'.repeat(129) })] });
  });
});
