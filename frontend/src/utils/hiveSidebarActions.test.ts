import { describe, expect, it, vi } from 'vitest';
import type { MenuProps } from 'antd';
import { buildViewMenuItems } from '../components/sidebar/sidebarNodeMenuObjects';
import { supportsTableClearAction, supportsTableTruncateAction } from '../components/tableDataDangerActions';

const keys = (items: MenuProps['items']): string[] => (items || []).flatMap(item => !item ? [] : [
  ...('key' in item ? [String(item.key)] : []),
  ...('children' in item ? keys(item.children) : []),
]);

const config = { type: 'hive', host: 'warehouse', port: 10000, user: '' };
const context = {
  getMetadataDialect: () => 'hive', resolveMessagePublishTarget: () => null,
  isStructureOnlyDbType: () => true, renameTableForm: { setFieldsValue: vi.fn() }, renameViewForm: { setFieldsValue: vi.fn() },
};

describe('Hive sidebar native object actions', () => {
  it('keeps view rename/drop actions available despite read-only generic designer/index capabilities', () => {
    const view = buildViewMenuItems({ node: { type: 'view', title: 'active_events', dataRef: { id: 'hive', dbName: 'analytics', viewName: 'active_events', config } }, context });
    expect(keys(view)).toEqual(expect.arrayContaining(['rename-view', 'drop-view']));
  });

  it('offers clear/truncate only as backend-preflight actions for Hive and its registered aliases', () => {
    for (const type of ['hive', 'hive2', 'hiveserver2', 'hs2', 'apache-hive']) {
      expect(supportsTableTruncateAction(type)).toBe(true);
      expect(supportsTableClearAction(type)).toBe(true);
    }
    expect(supportsTableTruncateAction('unknown')).toBe(false);
    expect(supportsTableClearAction('unknown')).toBe(false);
  });
});
