import { describe, expect, it } from 'vitest';

import { resolveDataSyncTargetTableStrategy } from './dataSyncRequest';
import { isTargetTableCreationAllowed } from './dataSyncTableCreation';

describe('isTargetTableCreationAllowed', () => {
  it('always allows table creation for migration from tables', () => {
    expect(isTargetTableCreationAllowed('migration', 'both', 'table')).toBe(true);
    expect(isTargetTableCreationAllowed('migration', 'data', 'table')).toBe(true);
  });

  it('lets the sync workflow create tables only when the sync content includes schema', () => {
    expect(isTargetTableCreationAllowed('sync', 'both', 'table')).toBe(true);
    expect(isTargetTableCreationAllowed('sync', 'schema', 'table')).toBe(true);
    // 仅同步数据时后端禁止改动目标结构，选了建表只会在执行期失败。
    expect(isTargetTableCreationAllowed('sync', 'data', 'table')).toBe(false);
  });

  it('never creates tables for SQL result-set sources', () => {
    expect(isTargetTableCreationAllowed('migration', 'both', 'query')).toBe(false);
    expect(isTargetTableCreationAllowed('sync', 'both', 'query')).toBe(false);
  });
});

describe('resolveDataSyncTargetTableStrategy for the sync workflow', () => {
  it('defaults to smart once the sync content includes schema and the pair can auto-create', () => {
    expect(resolveDataSyncTargetTableStrategy('existing_only', 'sync', 'table', true, false, 'both')).toBe('smart');
    expect(resolveDataSyncTargetTableStrategy('existing_only', 'sync', 'table', true, false, 'schema')).toBe('smart');
  });

  it('keeps existing-only for data-only content, even if a creating strategy was left over', () => {
    expect(resolveDataSyncTargetTableStrategy('existing_only', 'sync', 'table', true, false, 'data')).toBe('existing_only');
    expect(resolveDataSyncTargetTableStrategy('smart', 'sync', 'table', true, true, 'data')).toBe('existing_only');
  });

  it('respects an explicit choice and unsupported pairs', () => {
    expect(resolveDataSyncTargetTableStrategy('existing_only', 'sync', 'table', true, true, 'both')).toBe('existing_only');
    expect(resolveDataSyncTargetTableStrategy('auto_create_if_missing', 'sync', 'table', true, true, 'both')).toBe('auto_create_if_missing');
    expect(resolveDataSyncTargetTableStrategy('existing_only', 'sync', 'table', false, false, 'both')).toBe('existing_only');
  });
});
