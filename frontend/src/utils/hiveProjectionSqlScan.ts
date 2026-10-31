export type HiveProjectionToken = {
  value: string;
  raw: string;
  start: number;
  end: number;
  kind: 'word' | 'identifier' | 'string' | 'symbol';
};

// Only expose top-level tokens. CAST/UNIONTYPE arguments and string payloads
// cannot be mistaken for SELECT aliases, list commas or FROM/JOIN clauses.
export const hiveProjectionTokens = (sql: string): HiveProjectionToken[] => {
  if (sql.length > 2 * 1024 * 1024) return [];
  const tokens: HiveProjectionToken[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const start = index;
    const char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) return [];
      index = end + 2;
      continue;
    }
    let value = char;
    let kind: HiveProjectionToken['kind'] = 'symbol';
    if (char === '\x60' || char === "'" || char === '"') {
      kind = char === '\x60' ? 'identifier' : 'string';
      value = '';
      index++;
      let closed = false;
      while (index < sql.length) {
        const current = sql[index++];
        if (current === '\\' && char !== '\x60') { index++; continue; }
        if (current === char) {
          if (sql[index] === char) { value += char; index++; continue; }
          closed = true;
          break;
        }
        value += current;
      }
      if (!closed) return [];
    } else if (/[a-z_]/i.test(char)) {
      kind = 'word';
      index++;
      while (index < sql.length && /[a-z0-9_$]/i.test(sql[index])) index++;
      value = sql.slice(start, index);
    } else {
      index++;
      if (char === ')') { depth--; if (depth < 0) return []; }
    }
    if (depth === 0) tokens.push({ value, raw: sql.slice(start, index), kind, start, end: index });
    if (char === '(' && kind === 'symbol') { depth++; if (depth > 128) return []; }
  }
  return depth === 0 ? tokens : [];
};

export const isHiveProjectionIdentifier = (token: HiveProjectionToken | undefined): token is HiveProjectionToken =>
  !!token && (token.kind === 'word' || token.kind === 'identifier');

export const hiveProjectionPath = (tokens: HiveProjectionToken[]): string[] | undefined => {
  if (!tokens.length || tokens.length % 2 !== 1) return undefined;
  for (let index = 0; index < tokens.length; index++) {
    if (index % 2 === 0 ? !isHiveProjectionIdentifier(tokens[index]) : tokens[index].raw !== '.') return undefined;
  }
  return tokens.filter((_, index) => index % 2 === 0).map(token => token.value);
};

export const splitHiveProjectionItems = (tokens: HiveProjectionToken[]): HiveProjectionToken[][] => {
  const items: HiveProjectionToken[][] = [[]];
  for (const token of tokens) {
    if (token.raw === ',') items.push([]);
    else items[items.length - 1].push(token);
  }
  return items;
};
