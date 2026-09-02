import { describe, expect, it } from 'vitest';

import { getDynamicMaxContextChars } from './aiChatRuntime';

describe('aiChatRuntime', () => {
  it('maps modern model families to practical context windows', () => {
    expect(getDynamicMaxContextChars('gemini-2.5-pro')).toBe(5000000);
    expect(getDynamicMaxContextChars('gpt-5')).toBe(1000000);
    expect(getDynamicMaxContextChars('claude-4-sonnet')).toBe(1000000);
    expect(getDynamicMaxContextChars('gpt-4o')).toBe(128000);
    expect(getDynamicMaxContextChars()).toBe(258000);
  });
});
