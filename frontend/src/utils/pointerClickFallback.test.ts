import { describe, expect, it } from 'vitest';

import { shouldFallbackClick } from './pointerClickFallback';

describe('shouldFallbackClick', () => {
  it('falls back for an enabled button on primary pointerup', () => {
    expect(shouldFallbackClick({
      button: 0,
      targetIsClickable: true,
      targetDisabled: false,
      targetInEditor: false,
    })).toBe(true);
  });

  it('skips disabled targets, editor internals and non-primary buttons', () => {
    const base = {
      button: 0,
      targetIsClickable: true,
      targetDisabled: false,
      targetInEditor: false,
    };
    expect(shouldFallbackClick({ ...base, targetDisabled: true })).toBe(false);
    expect(shouldFallbackClick({ ...base, targetInEditor: true })).toBe(false);
    expect(shouldFallbackClick({ ...base, button: 2 })).toBe(false);
  });
});
