import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  DEFAULT_GENERATED_LENGTH,
  estimatePasswordStrength,
  generatePassword,
} from './passwordGenerator';
import type { UMPasswordPolicy } from './userManagementTypes';

const policy = (overrides: Partial<UMPasswordPolicy> = {}): UMPasswordPolicy => ({
  minLength: 0,
  maxLength: 0,
  requireUpper: false,
  requireLower: false,
  requireDigit: false,
  requireSpecial: false,
  minCategories: 0,
  disallowUsername: false,
  ...overrides,
});

describe('passwordGenerator', () => {
  it('always includes every character class and satisfies strict policies', () => {
    for (let round = 0; round < 50; round += 1) {
      const password = generatePassword(policy({ minLength: 12, minCategories: 4 }));
      expect(password).toHaveLength(DEFAULT_GENERATED_LENGTH);
      expect(checkPasswordPolicy(password, 'admin', policy({ minLength: 12, minCategories: 4, requireUpper: true, requireDigit: true, requireSpecial: true }))).toEqual([]);
    }
  });

  it('respects length bounds and forbidden characters', () => {
    const forbidden = '!#$%&*+-=?@^_~.,:;';
    const password = generatePassword(policy({ minLength: 8, maxLength: 16, forbiddenChars: forbidden }));
    expect(password).toHaveLength(16);
    expect(Array.from(password).some((char) => forbidden.includes(char))).toBe(false);
    expect(generatePassword(policy({ minLength: 40 }))).toHaveLength(40);
  });

  it('never emits quotes, backslashes, backticks or spaces', () => {
    for (let round = 0; round < 100; round += 1) {
      expect(generatePassword()).not.toMatch(/['"`\\ ]/);
    }
  });

  it('uses the injected random source (deterministic output)', () => {
    let counter = 0;
    const random = (buffer: Uint32Array) => {
      buffer[0] = counter;
      counter += 7;
      return buffer;
    };
    expect(generatePassword(policy(), random)).toBe(generatePassword(policy(), (() => {
      let second = 0;
      return (buffer: Uint32Array) => {
        buffer[0] = second;
        second += 7;
        return buffer;
      };
    })()));
  });

  it('reports policy failures with backend rule codes', () => {
    expect(checkPasswordPolicy('admin', 'admin', policy({ minLength: 8, disallowUsername: true, requireDigit: true })))
      .toEqual(['min_length', 'digit', 'username']);
    expect(checkPasswordPolicy('nimda', 'admin', policy({ disallowUsername: true }))).toEqual(['username']);
  });

  it('estimates strength monotonically', () => {
    expect(estimatePasswordStrength('')).toBe(0);
    expect(estimatePasswordStrength('aaaaaaaaaaaaaaaaaaaa')).toBeLessThanOrEqual(1);
    expect(estimatePasswordStrength('Abcdef1!Abcdef1!')).toBe(4);
  });
});
