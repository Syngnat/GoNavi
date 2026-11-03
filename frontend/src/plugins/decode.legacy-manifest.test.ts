import { describe, expect, it } from 'vitest';
import { decodeStatus, decodeStatuses } from './decode';
import type { PluginStatus } from './types';

// 回归背景：00021c5bc 让 window 必须声明 ui.html-panel，宿主随后在 internal/plugin/state.go
// 里只隔离了这一条记录。但前端 decodeStatuses 是整表 map，只要一条失败就抛
// invalid_response，插件面板因此整块空白 —— 用户看到「怎么都看不了了」，并且连卸载入口都没有。
const identity = { schemaVersion: 1, apiVersion: 1, name: 'Legacy Window', version: '1.0.0' };

const healthyStatus = (id = 'example.healthy'): Record<string, unknown> => ({
  manifest: { ...identity, id, permissions: [] },
  digest: 'a'.repeat(64),
  state: 'disabled',
  desiredEnabled: false,
  generation: 1,
  installedAt: '2026-11-01T00:00:00Z',
});

// 旧清单：声明了 window，但没有 ui.html-panel —— 10-21 到 11-01 之间发布的插件就是这样。
const legacyWindowStatus = (id = 'example.legacy'): Record<string, unknown> => ({
  manifest: { ...identity, id, permissions: [], window: { entry: 'index.html' } },
  digest: 'b'.repeat(64),
  state: 'blocked',
  desiredEnabled: false,
  generation: 1,
  lastError: 'invalid persisted manifest: window requires the ui.html-panel permission',
  installedAt: '2026-10-25T00:00:00Z',
});

const byId = (statuses: PluginStatus[]) => new Map(statuses.map((item) => [item.manifest.id, item]));

describe('legacy manifest no longer blanks the whole installed list', () => {
  it('keeps every other plugin when one manifest no longer decodes', () => {
    const statuses = decodeStatuses([healthyStatus(), legacyWindowStatus()]);
    expect(statuses).toHaveLength(2);
    const plugins = byId(statuses);
    expect(plugins.get('example.healthy')?.state).toBe('disabled');
    expect(plugins.get('example.legacy')?.state).toBe('blocked');
  });

  it('degrades the incompatible entry to identity fields only', () => {
    const [legacy] = decodeStatuses([legacyWindowStatus()]);
    expect(legacy.manifestDegraded).toBe(true);
    expect(legacy.manifest.id).toBe('example.legacy');
    expect(legacy.manifest.name).toBe('Legacy Window');
    expect(legacy.manifest.version).toBe('1.0.0');
    // 无法按契约解码的声明一律不可信：权限、contributions 与 window 都不许带出来。
    expect(legacy.manifest.permissions).toEqual([]);
    expect(legacy.manifest.window).toBeUndefined();
    expect(legacy.manifest.contributes).toBeUndefined();
    expect(legacy.desiredEnabled).toBe(false);
    // 宿主写入的拒绝原因要保留，用户才知道为什么这一条不可用。
    expect(legacy.lastError).toContain('ui.html-panel');
  });

  it('leaves a fully valid plugin undegraded', () => {
    const [healthy] = decodeStatuses([healthyStatus()]);
    expect(healthy.manifestDegraded).toBeUndefined();
  });

  it('drops an entry whose identity itself is unusable instead of failing the list', () => {
    const brokenIdentity = { ...legacyWindowStatus('example.legacy'), digest: 'not-a-digest' };
    const statuses = decodeStatuses([healthyStatus(), brokenIdentity]);
    expect(statuses.map((item) => item.manifest.id)).toEqual(['example.healthy']);
  });

  it('still rejects a structurally invalid envelope', () => {
    expect(() => decodeStatuses({ items: [] })).toThrow('plugin.error.invalid_response');
    expect(() => decodeStatuses([null])).toThrow('plugin.error.invalid_response');
  });

  it('keeps decodeStatus strict for a single record', () => {
    // 单条入口仍原样抛错：降级只属于「列表里的一条坏数据」，不能顺带放宽契约。
    expect(() => decodeStatus(legacyWindowStatus())).toThrow('plugin.error.invalid_response');
  });
});
