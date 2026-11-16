import { describe, expect, it } from 'vitest';

import { shouldBlurBeforePointerDown } from './imePointerGuard';

describe('shouldBlurBeforePointerDown', () => {
  it('blurs a focused input before clicking a button', () => {
    expect(shouldBlurBeforePointerDown({
      button: 0,
      targetIsTextEntry: false,
      activeIsTextEntry: true,
      activeContainsTarget: false,
    })).toBe(true);
  });

  it('keeps focus for non-primary buttons and text targets', () => {
    expect(shouldBlurBeforePointerDown({
      button: 2,
      targetIsTextEntry: false,
      activeIsTextEntry: true,
      activeContainsTarget: false,
    })).toBe(false);
    expect(shouldBlurBeforePointerDown({
      button: 0,
      targetIsTextEntry: true,
      activeIsTextEntry: true,
      activeContainsTarget: false,
    })).toBe(false);
  });

  it('keeps focus when there is no text entry active', () => {
    expect(shouldBlurBeforePointerDown({
      button: 0,
      targetIsTextEntry: false,
      activeIsTextEntry: false,
      activeContainsTarget: false,
    })).toBe(false);
    expect(shouldBlurBeforePointerDown({
      button: 0,
      targetIsTextEntry: false,
      activeIsTextEntry: true,
      activeContainsTarget: true,
    })).toBe(false);
  });
});
