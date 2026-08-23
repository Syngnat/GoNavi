const REDIS_GLOB_SPECIAL_CHARS = /([*?\[\]\\])/g;
const ASCII_LETTER = /^[A-Za-z]$/;

export type RedisSearchMode = 'prefix' | 'fuzzy' | 'exact';

const escapeRedisGlobLiteral = (value: string): string => {
  return value.replace(REDIS_GLOB_SPECIAL_CHARS, '\\$1');
};

const toCaseInsensitiveRedisGlobLiteral = (value: string): string => {
  return Array.from(value).map((char) => {
    if (!ASCII_LETTER.test(char)) {
      return escapeRedisGlobLiteral(char);
    }

    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    return `[${lower}${upper}]`;
  }).join('');
};

export const normalizeRedisSearchInput = (
  rawValue: string,
  mode: RedisSearchMode = 'prefix',
): { keyword: string; pattern: string } => {
  const keyword = String(rawValue || '').trim();
  if (!keyword) {
    return { keyword: '', pattern: '*' };
  }
  if (mode === 'exact') {
    return {
      keyword,
      pattern: escapeRedisGlobLiteral(keyword),
    };
  }
  const pattern = toCaseInsensitiveRedisGlobLiteral(keyword);
  return {
    keyword,
    pattern: mode === 'fuzzy' ? `*${pattern}*` : `${pattern}*`,
  };
};

export const normalizeRedisSearchDraftChange = (rawValue: string, mode: RedisSearchMode = 'prefix'): {
  keyword: string;
  pattern: string;
  shouldSearchImmediately: boolean;
} => {
  const normalized = normalizeRedisSearchInput(rawValue, mode);
  return {
    ...normalized,
    shouldSearchImmediately: normalized.keyword === '',
  };
};
