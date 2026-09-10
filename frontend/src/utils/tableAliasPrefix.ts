export const TABLE_ALIAS_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,23}$/;

export const normalizeTableAliasPrefix = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const prefix = value.trim();
  return TABLE_ALIAS_PREFIX_PATTERN.test(prefix) ? prefix : '';
};
