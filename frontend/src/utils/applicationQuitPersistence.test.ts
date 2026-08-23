import { describe, expect, it, vi } from 'vitest';

import { prepareApplicationQuitPersistence } from './applicationQuitPersistence';

describe('prepareApplicationQuitPersistence', () => {
  it('captures the latest native window before flushing persisted app state', async () => {
    const calls: string[] = [];
    const captureWindowState = vi.fn(async () => {
      calls.push('capture-window');
    });
    const flushDrafts = vi.fn(() => {
      calls.push('flush-drafts');
    });
    const flushAppState = vi.fn(async () => {
      calls.push('flush-app-state');
    });

    await prepareApplicationQuitPersistence({
      captureWindowState,
      flushDrafts,
      flushAppState,
    });

    expect(calls).toEqual([
      'capture-window',
      'flush-drafts',
      'flush-app-state',
    ]);
  });
});
