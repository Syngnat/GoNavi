import { describe, expect, it, vi } from 'vitest';
import { withAISettingsLeaveGuard } from './aiSettingsLeaveGuard';

describe('AI settings host leave guard', () => {
  it('keeps clean settings navigation synchronous and stops a denied close', () => {
    const navigate = vi.fn(() => 'moved');
    expect(withAISettingsLeaveGuard(() => true, navigate)).toBe('moved');
    expect(withAISettingsLeaveGuard(null, navigate)).toBe('moved');
    expect(withAISettingsLeaveGuard(() => false, navigate)).toBeUndefined();
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('waits for draft confirmation before any host action: %s', async (confirmed) => {
    let finish!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => { finish = resolve; });
    const navigate = vi.fn();
    const pending = withAISettingsLeaveGuard(() => confirmation, navigate);
    expect(navigate).not.toHaveBeenCalled();
    finish(confirmed);
    await pending;
    expect(navigate).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  });
});
