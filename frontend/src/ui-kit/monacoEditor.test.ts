import { describe, expect, it } from 'vitest';
import { gonaviMonacoLanguage } from './monacoLanguage';

describe('monaco language mapping', () => {
  it('maps UI Kit languages to Monaco ids', () => {
    expect(gonaviMonacoLanguage('sql')).toBe('sql');
    expect(gonaviMonacoLanguage('json')).toBe('json');
    expect(gonaviMonacoLanguage('javascript')).toBe('javascript');
    expect(gonaviMonacoLanguage('text')).toBe('plaintext');
    expect(gonaviMonacoLanguage(undefined)).toBe('plaintext');
  });
});
