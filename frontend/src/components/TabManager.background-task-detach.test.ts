import { describe, expect, it } from 'vitest';

import { isRunningDataImportWorkbenchTab } from './TabManager';

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
