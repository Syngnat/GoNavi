import { describe, expect, it } from 'vitest';
import { compactMiddle, compactSecret, compactUrl } from './compactConnectionDisplay';

describe('compactConnectionDisplay', () => {
  it('strips http(s) from URLs and shortens the rest', () => {
    expect(compactUrl('https://api.openai.com/v1')).toBe('api.openai.com/v1');
    expect(compactUrl('http://localhost:8080/v1')).toBe('localhost:8080/v1');
    expect(compactUrl('https://very-long-gateway.example.internal/openai/v1/chat/completions'))
      .toBe('very-long-gateway..../completions');
  });

  it('keeps short format strings and ellipsizes the middle of long ones', () => {
    expect(compactMiddle('openai')).toBe('openai');
    expect(compactMiddle('openai-responses')).toBe('openai...ponses');
  });

  it('shows secret head and tail', () => {
    expect(compactSecret('')).toBe('');
    expect(compactSecret('short')).toBe('short');
    expect(compactSecret('sk-abcdefghijklmnopqrstuvwxyz')).toBe('sk-a...wxyz');
  });
});
