import { describe, expect, it } from 'vitest';
import { decodeVersionPage } from './versionsApi';

// 回归背景：宿主在某版本收紧了 window 权限（要求 ui.html-panel）。市场里该收紧之前
// 发布的版本其清单不再能按当前契约解码，而 decodeVersionPage 是逐行 decodeMarketPlugin，
// 任意一行失败就整页抛 invalid_response —— 界面报「无法读取版本 / 主机返回了无效的插件
// 响应」，连合法的最新版都装不了。invalid_version 这个取值本来就在契约里，说明设计上
// 允许「某版本无效」。
const base = {
  id: 'gh-example.ssh',
  name: 'Example SSH',
  description: 'SSH tools.',
  author: 'Example',
  publisherId: 'gh-example',
  official: false,
  platforms: ['linux/amd64'],
  ratingAverage: 0,
  ratingCount: 0,
  downloadCount: 4,
  updatedAt: '2026-11-03T00:00:00Z',
};

// 收紧前的样子：声明了 window，但权限里没有 ui.html-panel。
const legacyRow = (version: string) => ({
  plugin: {
    ...base,
    version,
    manifest: {
      schemaVersion: 1, apiVersion: 1, id: base.id, name: base.name, version,
      permissions: ['ai.tools', 'host.log'],
      window: { entry: 'frontend/index.html', title: 'Example SSH' },
    },
  },
  compatible: true,
  reason: '',
});

// 收紧后的样子：补上了 ui.html-panel。
const currentRow = (version: string) => ({
  plugin: {
    ...base,
    version,
    manifest: {
      schemaVersion: 1, apiVersion: 1, id: base.id, name: base.name, version,
      permissions: ['ai.tools', 'host.log', 'ui.html-panel'],
      window: { entry: 'frontend/index.html', title: 'Example SSH' },
    },
  },
  compatible: true,
  reason: '',
});

describe('version page tolerates manifests the current contract rejects', () => {
  it('keeps the healthy newest version when older rows are no longer decodable', () => {
    const page = decodeVersionPage({
      versions: [currentRow('0.1.4'), legacyRow('0.1.3'), legacyRow('0.1.2'), legacyRow('0.1.1')],
    });
    expect(page.versions.map((entry) => entry.plugin.version)).toEqual(['0.1.4', '0.1.3', '0.1.2', '0.1.1']);
    expect(page.versions[0]).toMatchObject({ compatible: true, reason: '' });
  });

  it('marks each undecodable row invalid_version instead of failing the page', () => {
    const page = decodeVersionPage({ versions: [currentRow('0.1.4'), legacyRow('0.1.3')] });
    const legacy = page.versions[1];
    expect(legacy.compatible).toBe(false);
    expect(legacy.reason).toBe('invalid_version');
    // 清单不可信，不能带出来渲染权限或发起安装。
    expect(legacy.plugin.manifest).toBeUndefined();
    expect(legacy.plugin.version).toBe('0.1.3');
    expect(legacy.plugin.name).toBe('Example SSH');
    expect(legacy.plugin.downloadCount).toBe(4);
  });

  it('still rejects the page when every row is undecodable at the identity level', () => {
    const broken = legacyRow('0.1.3');
    delete (broken.plugin as Record<string, unknown>).name;
    expect(() => decodeVersionPage({ versions: [broken] })).toThrow('plugin.error.invalid_response');
  });

  it('still rejects an oversized market description instead of degrading it', () => {
    // 元数据越界不是「清单契约变更」，不能被降级放过。
    const row = currentRow('0.1.4');
    (row.plugin as Record<string, unknown>).description = 'a'.repeat((32 << 10) + 1);
    expect(() => decodeVersionPage({ versions: [row] })).toThrow('plugin.error.invalid_response');
  });

  it('still rejects a row whose market metadata has the wrong type', () => {
    const row = currentRow('0.1.4');
    (row.plugin as Record<string, unknown>).official = 'yes';
    expect(() => decodeVersionPage({ versions: [row] })).toThrow('plugin.error.invalid_response');
  });

  it('still rejects a payload over the envelope budget', () => {
    const row = currentRow('0.1.4');
    (row.plugin as Record<string, unknown>).description = 'a'.repeat(300 << 10);
    expect(() => decodeVersionPage({ versions: [row] })).toThrow('plugin.ui.invalid_data');
  });
});
