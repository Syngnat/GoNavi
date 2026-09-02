import { describe, expect, it } from 'vitest';

import { closeConfirmedWorkbenchTabs, isRunningDataImportWorkbenchTab } from './TabManager';

describe('TabManager background task window guard', () => {

  it('blocks closing a data import tab only while its foreground task is running', () => {
    expect(isRunningDataImportWorkbenchTab({
      type: 'data-import',
      dataImportRunning: true,
    })).toBe(true);
    expect(isRunningDataImportWorkbenchTab({
      type: 'data-import',
      dataImportRunning: false,
    })).toBe(false);
  });
});

describe('TabManager confirmed close targets', () => {
  it('只关闭确认时固定的标签集合，不重新计算批量关闭范围', () => {
    const closed: string[] = [];

    closeConfirmedWorkbenchTabs(['tab-1', 'tab-2', 'tab-1', ''], (id) => {
      closed.push(id);
    });

    expect(closed).toEqual(['tab-1', 'tab-2']);
  });
});
