import { describe, expect, it, vi } from 'vitest';

import { waitForWindowCondition } from './windowTransition';

describe('windowTransition', () => {
  it('waits until a fire-and-forget native transition becomes observable', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(waitForWindowCondition({ read, wait, maxChecks: 4, intervalMs: 25 })).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
  });

  it('does not treat an unobserved transition as complete', async () => {
    const read = vi.fn().mockResolvedValue(false);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(waitForWindowCondition({ read, wait, maxChecks: 3 })).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stops polling when the startup restoration task is cancelled', async () => {
    let cancelled = false;
    const read = vi.fn().mockResolvedValue(false);
    const wait = vi.fn().mockImplementation(async () => {
      cancelled = true;
    });

    await expect(waitForWindowCondition({
      read,
      wait,
      isCancelled: () => cancelled,
      maxChecks: 5,
    })).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
