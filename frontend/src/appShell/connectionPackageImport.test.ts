import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import type { SavedConnection } from '../types';
import { normalizeConnectionPackageImportPayload, summarizeConnectionImport } from './connectionPackageImport';

const translate = (key: string, params?: Record<string, string | number>) => t(key, params, 'zh-CN');
const connections = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `conn-${index}`,
  name: `A${index}`,
})) as SavedConnection[];

describe('normalizeConnectionPackageImportPayload', () => {
  it('reads the skipped count reported by the backend', () => {
    expect(normalizeConnectionPackageImportPayload({ connections: [], skippedCount: 504 })?.skippedCount).toBe(504);
  });

  it('treats a missing or malformed skipped count as zero', () => {
    expect(normalizeConnectionPackageImportPayload({ connections: [] })?.skippedCount).toBe(0);
    expect(normalizeConnectionPackageImportPayload({ connections: [], skippedCount: -3 })?.skippedCount).toBe(0);
    expect(normalizeConnectionPackageImportPayload({ connections: [], skippedCount: 'many' })?.skippedCount).toBe(0);
    expect(normalizeConnectionPackageImportPayload([])?.skippedCount).toBe(0);
  });
});

describe('summarizeConnectionImport', () => {
  it('keeps the plain success message when nothing was skipped', () => {
    expect(summarizeConnectionImport(translate, { connections: connections(18), skippedCount: 0 })).toEqual({
      type: 'success',
      message: '成功导入 18 个连接',
    });
  });

  it('reports existing connections that were not imported again', () => {
    expect(summarizeConnectionImport(translate, { connections: connections(18), skippedCount: 504 })).toEqual({
      type: 'success',
      message: '成功导入 18 个连接（另有 504 个连接已存在，未重复导入）',
    });
  });

  it('says nothing new was imported instead of reporting zero imported connections', () => {
    expect(summarizeConnectionImport(translate, { connections: [], skippedCount: 504 })).toEqual({
      type: 'warning',
      message: '未导入新连接：文件中的 504 个连接均已存在',
    });
  });

  it('keeps the Excel grouping and missing password wording alongside the skipped note', () => {
    const grouped = summarizeConnectionImport(translate, { connections: connections(18), skippedCount: 2 }, { groupedCount: 18 });
    expect(grouped.message).toBe('已导入 18 个连接，其中 18 个按 Excel 分组归位（另有 2 个连接已存在，未重复导入）');

    const missing = summarizeConnectionImport(translate, { connections: connections(3), skippedCount: 1 }, { missingPasswords: true });
    expect(missing.type).toBe('warning');
    expect(missing.message).toContain('部分连接未包含密码');
    expect(missing.message).toContain('另有 1 个连接已存在');
  });
});
