import { INTEGER_RE } from './mongodbLiterals';
import { parseMongoJSONValue } from './mongodbEditing';

export const splitTopLevelComma = (raw: string): string[] => {
  const text = String(raw || '');
  const result: string[] = [];
  let current = '';
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);

    if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      result.push(current.slice(0, -1));
      current = '';
    }
  }

  if (current.trim()) result.push(current);
  return result.map((item) => item.trim()).filter(Boolean);
};

const extractBalancedParentheses = (text: string, openPos: number): { args: string; nextPos: number } => {
  if (openPos < 0 || openPos >= text.length || text[openPos] !== '(') {
    throw new Error('Syntax error: missing "("');
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = openPos; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === '(') depth++;
    if (ch === ')') depth--;

    if (depth === 0) {
      return {
        args: text.slice(openPos + 1, i),
        nextPos: i + 1,
      };
    }
  }

  throw new Error('Syntax error: unclosed parenthesis');
};

export const parseCollectionAndMethod = (raw: string): {
  collection: string;
  method: string;
  argsText: string;
  tailText: string;
} | null => {
  const input = String(raw || '').trim();
  if (!/^db\./i.test(input)) return null;

  let pos = 3; // skip "db."
  let collection = '';

  const restLower = input.slice(pos).toLowerCase();
  if (restLower.startsWith('getcollection')) {
    pos += 'getCollection'.length;
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    if (input[pos] !== '(') throw new Error('Syntax error: getCollection missing arguments');
    const { args, nextPos } = extractBalancedParentheses(input, pos);
    const arg = String(args || '').trim();
    const m = arg.match(/^["']([^"']+)["']$/);
    if (!m) throw new Error('Syntax error: getCollection argument must be a string');
    collection = m[1];
    pos = nextPos;
  } else {
    let end = pos;
    while (end < input.length && /[A-Za-z0-9_$-]/.test(input[end])) end++;
    collection = input.slice(pos, end).trim();
    pos = end;
  }

  if (!collection) throw new Error('Syntax error: collection name not found');
  if (input[pos] !== '.') throw new Error('Syntax error: expected method call after collection');
  pos++;

  let methodEnd = pos;
  while (methodEnd < input.length && /[A-Za-z]/.test(input[methodEnd])) methodEnd++;
  const method = input.slice(pos, methodEnd).trim();
  pos = methodEnd;

  while (pos < input.length && /\s/.test(input[pos])) pos++;
  if (input[pos] !== '(') throw new Error('Syntax error: missing "(" for method arguments');
  const { args, nextPos } = extractBalancedParentheses(input, pos);
  pos = nextPos;

  return {
    collection,
    method: method.toLowerCase(),
    argsText: args,
    tailText: input.slice(pos).trim(),
  };
};

export const parseChainCalls = (rawTail: string): Array<{ method: string; arg: string }> => {
  const result: Array<{ method: string; arg: string }> = [];
  let tail = String(rawTail || '').trim();
  if (!tail) return result;

  while (tail) {
    if (!tail.startsWith('.')) {
      throw new Error(`Syntax error: unsupported chain fragment ${tail}`);
    }
    let pos = 1;
    while (pos < tail.length && /[A-Za-z]/.test(tail[pos])) pos++;
    const method = tail.slice(1, pos).trim().toLowerCase();
    while (pos < tail.length && /\s/.test(tail[pos])) pos++;
    if (tail[pos] !== '(') throw new Error(`Syntax error: ${method} missing argument parenthesis`);
    const { args, nextPos } = extractBalancedParentheses(tail, pos);
    result.push({ method, arg: String(args || '').trim() });
    tail = tail.slice(nextPos).trim();
  }

  return result;
};

export const parsePositiveInt = (raw: string, fieldName: string): number => {
  const text = String(raw || '').trim();
  if (!INTEGER_RE.test(text)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return Math.floor(n);
};

export const parseMongoSortObject = (raw: string): Record<string, 1 | -1> => {
  const parsedSort = parseMongoJSONValue(raw);
  if (!parsedSort || typeof parsedSort !== 'object' || Array.isArray(parsedSort)) {
    throw new Error('sort argument must be a JSON object');
  }
  const normalizedSort: Record<string, 1 | -1> = {};
  Object.entries(parsedSort as Record<string, unknown>).forEach(([key, value]) => {
    const n = Number(value);
    normalizedSort[key] = n >= 0 ? 1 : -1;
  });
  return normalizedSort;
};

export const parseMongoJSONDoc = (raw: string, fieldName: string): Record<string, unknown> => {
  const parsed = parseMongoJSONValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

export const parseMongoJSONPipeline = (raw: string): unknown[] => {
  const parsed = parseMongoJSONValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('aggregate first argument must be a JSON array pipeline');
  }
  return parsed;
};

export const parseMongoJSONArray = (raw: string, fieldName: string): unknown[] => {
  const parsed = parseMongoJSONValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON array`);
  }
  return parsed;
};

export const normalizeMongoDocuments = (raw: unknown, fieldName: string): Record<string, unknown>[] => {
  if (Array.isArray(raw)) {
    return raw.map((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${fieldName} document at index ${idx} must be a JSON object`);
      }
      return item as Record<string, unknown>;
    });
  }
  if (raw && typeof raw === 'object') {
    return [raw as Record<string, unknown>];
  }
  throw new Error(`${fieldName} must be a JSON object or JSON array`);
};

export const parseMongoOptionalDoc = (raw: string | undefined): Record<string, unknown> => {
  if (!raw || !String(raw).trim()) return {};
  return parseMongoJSONDoc(raw, 'options');
};

export const parseBooleanArg = (raw: string, fieldName: string): boolean => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error(`${fieldName} must be true or false`);
};

export const isNoopMongoChainMethod = (method: string): boolean => {
  return method === 'toarray' || method === 'pretty';
};

export const normalizeConditionLogic = (logic: unknown): 'AND' | 'OR' => {
  return String(logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
};

export const combineMongoParts = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  logic: 'AND' | 'OR',
): Record<string, unknown> => {
  if (logic === 'OR') {
    return { $or: [left, right] };
  }
  return { $and: [left, right] };
};
