import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CONTEXT_WINDOW,
  formatContextSize,
  parseModelContextProfile,
  resolveEffectiveContextWindow,
} from './aiChatRuntime';

describe('formatContextSize', () => {
  it('shows k below one million and converts to M from 1000k', () => {
    expect(formatContextSize(32_000)).toBe('32k');
    expect(formatContextSize(258_000)).toBe('258k');
    expect(formatContextSize(999_000)).toBe('999k');
    expect(formatContextSize(1_000_000)).toBe('1M');
    expect(formatContextSize(1_500_000)).toBe('1.5M');
    expect(formatContextSize(5_000_000)).toBe('5M');
  });

  it('keeps one decimal for usage in k and up to two decimals in M', () => {
    expect(formatContextSize(0, true)).toBe('0.0k');
    expect(formatContextSize(12_800, true)).toBe('12.8k');
    expect(formatContextSize(1_200_000, true)).toBe('1.2M');
    expect(formatContextSize(1_234_000, true)).toBe('1.23M');
  });
});

describe('model context profile', () => {
  it('parses the Go payload and tolerates missing options', () => {
    expect(parseModelContextProfile({ defaultWindow: 1_000_000, options: [500_000, 1_000_000] }))
      .toEqual({ defaultWindow: 1_000_000, options: [500_000, 1_000_000] });
    expect(parseModelContextProfile({ defaultWindow: 128_000, options: null }))
      .toEqual({ defaultWindow: 128_000, options: [128_000] });
  });

  it('rejects payloads without a usable default window', () => {
    expect(parseModelContextProfile(null)).toBeNull();
    expect(parseModelContextProfile({ defaultWindow: 0, options: [1] })).toBeNull();
    expect(parseModelContextProfile({ options: [1] })).toBeNull();
  });

  it('prefers the selected window, then the model default, then the fallback', () => {
    const profile = { defaultWindow: 1_000_000, options: [500_000, 1_000_000] };
    expect(resolveEffectiveContextWindow(profile, 500_000)).toBe(500_000);
    expect(resolveEffectiveContextWindow(profile, 0)).toBe(1_000_000);
    expect(resolveEffectiveContextWindow(profile)).toBe(1_000_000);
    expect(resolveEffectiveContextWindow(null, 0)).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});
