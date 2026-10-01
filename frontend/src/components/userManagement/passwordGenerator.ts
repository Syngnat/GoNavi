import type { UMPasswordPolicy } from './userManagementTypes';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
// 刻意排除引号、反斜杠、空格与反引号：不同方言对它们的转义规则不一，且部分数据源
// （TDengine、Oracle 等）直接禁止，生成的口令应在所有已适配数据源上都可用。
const SPECIAL = '!#$%&*+-=?@^_~.,:;';

export const DEFAULT_GENERATED_LENGTH = 20;

type RandomSource = (buffer: Uint32Array) => Uint32Array;

const defaultRandom: RandomSource = (buffer) => globalThis.crypto.getRandomValues(buffer);

/** 拒绝采样取均匀随机下标，避免取模偏差。 */
const randomIndex = (size: number, random: RandomSource): number => {
  const limit = Math.floor(0x100000000 / size) * size;
  const buffer = new Uint32Array(1);
  for (;;) {
    const value = random(buffer)[0];
    if (value < limit) return value % size;
  }
};

const withoutForbidden = (chars: string, forbidden: string): string => (
  forbidden ? Array.from(chars).filter((char) => !forbidden.includes(char)).join('') : chars
);

/**
 * 按服务端口令策略生成随机口令：保证每个必需字符类至少出现一次，
 * 长度取策略下限与默认长度的较大者，并受策略上限约束。
 */
export const generatePassword = (
  policy: Partial<UMPasswordPolicy> = {},
  random: RandomSource = defaultRandom,
): string => {
  const forbidden = policy.forbiddenChars || '';
  const classes = [UPPER, LOWER, DIGIT, SPECIAL].map((chars) => withoutForbidden(chars, forbidden)).filter(Boolean);
  const maxLength = policy.maxLength && policy.maxLength > 0 ? policy.maxLength : Number.POSITIVE_INFINITY;
  const length = Math.min(Math.max(policy.minLength || 0, DEFAULT_GENERATED_LENGTH), maxLength);
  const all = classes.join('');
  const chars: string[] = classes.map((set) => set[randomIndex(set.length, random)]);
  while (chars.length < length) {
    chars.push(all[randomIndex(all.length, random)]);
  }
  // Fisher-Yates 洗牌，打散前置的必需字符类。
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1, random);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.slice(0, length).join('');
};

export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

/** 粗略强度：长度与字符类数量，仅作提示，不替代服务端策略校验。 */
export const estimatePasswordStrength = (password: string): PasswordStrength => {
  if (!password) return 0;
  const categories = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  score += categories >= 3 ? 1 : 0;
  if (categories <= 1) score = Math.min(score, 1);
  return Math.min(score, 4) as PasswordStrength;
};

/** 本地预检口令策略，返回未满足的规则代码（与后端 password_policy.* 对应）。 */
export const checkPasswordPolicy = (
  password: string,
  username: string,
  policy: UMPasswordPolicy,
): string[] => {
  const failures: string[] = [];
  const upper = /[A-Z]/.test(password);
  const lower = /[a-z]/.test(password);
  const digit = /\d/.test(password);
  const special = /[^A-Za-z0-9]/.test(password);
  if (policy.minLength > 0 && password.length < policy.minLength) failures.push('min_length');
  if (policy.maxLength > 0 && password.length > policy.maxLength) failures.push('max_length');
  if (policy.requireUpper && !upper) failures.push('upper');
  if (policy.requireLower && !lower) failures.push('lower');
  if (policy.requireDigit && !digit) failures.push('digit');
  if (policy.requireSpecial && !special) failures.push('special');
  if (policy.minCategories > 0 && [upper, lower, digit, special].filter(Boolean).length < policy.minCategories) {
    failures.push('categories');
  }
  if (policy.disallowUsername && username) {
    const lowered = password.toLowerCase();
    const name = username.toLowerCase();
    if (lowered === name || lowered === Array.from(name).reverse().join('')) failures.push('username');
  }
  return failures;
};
