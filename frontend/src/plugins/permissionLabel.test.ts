import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pluginPermissionText } from './permissionLabel';

const repoRoot = new URL('../../../', import.meta.url);
const referencePath = new URL('../../../../GoNavi-Plugin-Market/docs/plugins/permissions.md', import.meta.url);
const reference = existsSync(referencePath) ? readFileSync(referencePath, 'utf8') : '';
const permissions = reference
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) => line.slice(3, line.indexOf('`', 3)));
const english = JSON.parse(readFileSync(new URL('shared/i18n/en-US.json', repoRoot), 'utf8')) as Record<string, string>;

describe.skipIf(!existsSync(referencePath))('permission labels', () => {
  it('labels every permission in the reference instead of showing the raw identifier', () => {
    expect(permissions.length).toBeGreaterThanOrEqual(7);
    for (const permission of permissions) {
      const label = pluginPermissionText(permission, (key) => key);
      expect(label.startsWith('plugin.permission.'), permission).toBe(true);
      expect(label.includes(`(${permission})`), permission).toBe(true);
    }
  });
  it('has an English string for every label it renders', () => {
    for (const permission of permissions) {
      const key = pluginPermissionText(permission, (name) => name).split(' — ')[0].split(' (')[0];
      expect(english[key], key).toBeTruthy();
    }
  });
  it('uses the localized description for known permissions', () => {
    expect(pluginPermissionText('host.log', (key) => key.endsWith('.description') ? '诊断说明' : '日志权限'))
      .toBe('日志权限 — 诊断说明 (host.log)');
  });

  it('falls back to the raw identifier for an unknown permission', () => {
    expect(pluginPermissionText('data.writes', (key) => key)).toBe('data.writes');
  });
});
