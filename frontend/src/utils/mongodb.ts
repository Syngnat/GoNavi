import type { FilterCondition } from './sql';
import { parseListValues } from './sql';

type SortInfo = {
  columnKey?: string;
  order?: string;
} | null | undefined;

type ShellConvertResult = {
  recognized: boolean;
  command?: string;
  error?: string;
};

const HEX24_RE = /^[0-9a-fA-F]{24}$/;
const INTEGER_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d+|\d+\.|\.\d+)$/;

const escapeRegex = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseMongoDateToMillis = (raw: unknown): number | null => {
  if (raw instanceof Date) {
    const ts = raw.getTime();
    return Number.isFinite(ts) ? Math.trunc(ts) : null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : null;
  }
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (INTEGER_RE.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return Math.trunc(n);
  }

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct.getTime();

  const withT = text.includes(' ') ? text.replace(' ', 'T') : text;
  const fromT = new Date(withT);
  if (!Number.isNaN(fromT.getTime())) return fromT.getTime();

  return null;
};

const buildMongoExtendedDate = (raw?: unknown): { $date: { $numberLong: string } } | { $date: string } => {
  if (typeof raw === 'undefined') {
    return { $date: { $numberLong: String(Date.now()) } };
  }
  const millis = parseMongoDateToMillis(raw);
  if (millis !== null) {
    return { $date: { $numberLong: String(millis) } };
  }
  return { $date: String(raw ?? '') };
};

const parseBooleanLiteral = (raw: string): boolean | null => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
};

const normalizeExtendedJSON = (raw: string): string => {
  let text = String(raw || '');
  text = text.replace(/ObjectId\s*\(\s*["']([0-9a-fA-F]{24})["']\s*\)/g, (_m, oid: string) => JSON.stringify({ $oid: oid }));
  text = text.replace(/ISODate\s*\(\s*["']([^"']+)["']\s*\)/g, (_m, dateText: string) => JSON.stringify(buildMongoExtendedDate(dateText)));
  text = text.replace(/NumberLong\s*\(\s*["']?([+-]?\d+)["']?\s*\)/g, '{"$numberLong":"$1"}');
  text = text.replace(/NumberInt\s*\(\s*["']?([+-]?\d+)["']?\s*\)/g, '{"$numberInt":"$1"}');
  text = text.replace(/NumberDecimal\s*\(\s*["']?([+-]?(?:\d+(?:\.\d+)?|\.\d+))["']?\s*\)/g, '{"$numberDecimal":"$1"}');
  return text;
};

const normalizeEvaluatedMongoValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return buildMongoExtendedDate(value);
  }
  if (value instanceof RegExp) {
    return {
      $regex: value.source,
      ...(value.flags ? { $options: value.flags } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEvaluatedMongoValue(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
      if (typeof v === 'undefined') return;
      out[k] = normalizeEvaluatedMongoValue(v);
    });
    return out;
  }
  if (typeof value === 'bigint') {
    return { $numberLong: String(value) };
  }
  return value;
};

const evalMongoLikeLiteral = (raw: string): unknown => {
  const expression = String(raw || '').trim();
  if (!expression) return {};

  const ObjectId = (value: unknown) => {
    const text = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!HEX24_RE.test(text)) {
      throw new Error(`ObjectId value must be 24 hex chars, got: ${text}`);
    }
    return { $oid: text.toLowerCase() };
  };
  const ISODate = (value?: unknown) => {
    return buildMongoExtendedDate(value);
  };
  const NumberInt = (value: unknown) => {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n)) throw new Error(`NumberInt invalid value: ${String(value)}`);
    return n;
  };
  const NumberLong = (value: unknown) => {
    const text = String(value ?? '').trim();
    if (!INTEGER_RE.test(text)) throw new Error(`NumberLong invalid value: ${text}`);
    return { $numberLong: text };
  };
  const NumberDecimal = (value: unknown) => {
    const text = String(value ?? '').trim();
    if (!text) throw new Error('NumberDecimal invalid value');
    return { $numberDecimal: text };
  };

  const parser = new Function(
    'ObjectId',
    'ISODate',
    'NumberInt',
    'NumberLong',
    'NumberDecimal',
    '"use strict"; return (' + expression + ');',
  );
  const evaluated = parser(ObjectId, ISODate, NumberInt, NumberLong, NumberDecimal);
  return normalizeEvaluatedMongoValue(evaluated);
};

const parseMongoScalar = (column: string, rawValue: string): unknown => {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  if (INTEGER_RE.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (FLOAT_RE.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (String(column || '').trim() === '_id' && HEX24_RE.test(raw)) {
    return { $oid: raw.toLowerCase() };
  }
  return raw;
};

const parseMongoJSONValue = (raw: string): unknown => {
  const text = String(raw || '').trim();
  if (!text) return {};
  const normalized = normalizeExtendedJSON(text);
  try {
    return JSON.parse(normalized);
  } catch {
    return evalMongoLikeLiteral(text);
  }
};

const splitTopLevelComma = (raw: string): string[] => {
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

const parseCollectionAndMethod = (raw: string): {
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
    while (end < input.length && /[A-Za-z0-9_$.-]/.test(input[end])) end++;
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

const parseChainCalls = (rawTail: string): Array<{ method: string; arg: string }> => {
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

const parsePositiveInt = (raw: string, fieldName: string): number => {
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

const parseMongoSortObject = (raw: string): Record<string, 1 | -1> => {
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

const parseMongoJSONDoc = (raw: string, fieldName: string): Record<string, unknown> => {
  const parsed = parseMongoJSONValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

const parseMongoJSONPipeline = (raw: string): unknown[] => {
  const parsed = parseMongoJSONValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('aggregate first argument must be a JSON array pipeline');
  }
  return parsed;
};

const parseMongoJSONArray = (raw: string, fieldName: string): unknown[] => {
  const parsed = parseMongoJSONValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON array`);
  }
  return parsed;
};

const normalizeMongoDocuments = (raw: unknown, fieldName: string): Record<string, unknown>[] => {
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

const parseMongoOptionalDoc = (raw: string | undefined): Record<string, unknown> => {
  if (!raw || !String(raw).trim()) return {};
  return parseMongoJSONDoc(raw, 'options');
};

const parseBooleanArg = (raw: string, fieldName: string): boolean => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error(`${fieldName} must be true or false`);
};

const isNoopMongoChainMethod = (method: string): boolean => {
  return method === 'toarray' || method === 'pretty';
};

const normalizeConditionLogic = (logic: unknown): 'AND' | 'OR' => {
  return String(logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
};

const combineMongoParts = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  logic: 'AND' | 'OR',
): Record<string, unknown> => {
  if (logic === 'OR') {
    return { $or: [left, right] };
  }
  return { $and: [left, right] };
};

export const buildMongoFilter = (conditions: FilterCondition[]): Record<string, unknown> => {
  const parts: Array<{ expr: Record<string, unknown>; logic: 'AND' | 'OR' }> = [];

  (conditions || []).forEach((cond) => {
    if (cond?.enabled === false) return;

    const op = String(cond?.op || '').trim();
    const column = String(cond?.column || '').trim();
    const value = String(cond?.value ?? '');
    const value2 = String(cond?.value2 ?? '');
    const logic = normalizeConditionLogic(cond?.logic);
    if (!op) return;

    const appendPart = (expr: Record<string, unknown>) => {
      if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return;
      parts.push({ expr, logic });
    };

    if (op === 'CUSTOM') {
      const expr = value.trim();
      if (!expr) return;
      const parsed = parseMongoJSONValue(expr);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Mongo custom filter must be a JSON object');
      }
      appendPart(parsed as Record<string, unknown>);
      return;
    }

    if (!column) return;

    const scalar = parseMongoScalar(column, value);
    const scalar2 = parseMongoScalar(column, value2);

    switch (op) {
      case 'IS_NULL':
        appendPart({ [column]: null });
        return;
      case 'IS_NOT_NULL':
        appendPart({ [column]: { $ne: null } });
        return;
      case 'IS_EMPTY':
        appendPart({ $or: [{ [column]: null }, { [column]: '' }] });
        return;
      case 'IS_NOT_EMPTY':
        appendPart({ $and: [{ [column]: { $ne: null } }, { [column]: { $ne: '' } }] });
        return;
      case 'BETWEEN':
        if (!value.trim() || !value2.trim()) return;
        appendPart({ [column]: { $gte: scalar, $lte: scalar2 } });
        return;
      case 'NOT_BETWEEN':
        if (!value.trim() || !value2.trim()) return;
        appendPart({ $or: [{ [column]: { $lt: scalar } }, { [column]: { $gt: scalar2 } }] });
        return;
      case 'IN': {
        const items = parseListValues(value).map((item) => parseMongoScalar(column, item));
        if (items.length === 0) return;
        appendPart({ [column]: { $in: items } });
        return;
      }
      case 'NOT_IN': {
        const items = parseListValues(value).map((item) => parseMongoScalar(column, item));
        if (items.length === 0) return;
        appendPart({ [column]: { $nin: items } });
        return;
      }
      case 'CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: escapeRegex(v) } });
        return;
      }
      case 'NOT_CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: escapeRegex(v) } } });
        return;
      }
      case 'STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: `^${escapeRegex(v)}` } });
        return;
      }
      case 'NOT_STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: `^${escapeRegex(v)}` } } });
        return;
      }
      case 'ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: `${escapeRegex(v)}$` } });
        return;
      }
      case 'NOT_ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: `${escapeRegex(v)}$` } } });
        return;
      }
      case '=':
        if (!value.trim()) return;
        appendPart({ [column]: scalar });
        return;
      case '!=':
        if (!value.trim()) return;
        appendPart({ [column]: { $ne: scalar } });
        return;
      case '<':
        if (!value.trim()) return;
        appendPart({ [column]: { $lt: scalar } });
        return;
      case '<=':
        if (!value.trim()) return;
        appendPart({ [column]: { $lte: scalar } });
        return;
      case '>':
        if (!value.trim()) return;
        appendPart({ [column]: { $gt: scalar } });
        return;
      case '>=':
        if (!value.trim()) return;
        appendPart({ [column]: { $gte: scalar } });
        return;
      default:
        return;
    }
  });

  if (parts.length === 0) return {};

  let merged = parts[0].expr;
  for (let i = 1; i < parts.length; i++) {
    merged = combineMongoParts(merged, parts[i].expr, parts[i].logic);
  }
  return merged;
};

export const buildMongoSort = (
  sortInfo: SortInfo,
  fallbackColumns: string[] = [],
): Record<string, 1 | -1> | undefined => {
  const sortColumn = String(sortInfo?.columnKey || '').trim();
  const sortOrder = String(sortInfo?.order || '');
  if (sortColumn && (sortOrder === 'ascend' || sortOrder === 'descend')) {
    return { [sortColumn]: sortOrder === 'ascend' ? 1 : -1 };
  }

  const uniqueColumns: string[] = [];
  const seen = new Set<string>();
  (fallbackColumns || []).forEach((col) => {
    const key = String(col || '').trim();
    if (!key) return;
    const low = key.toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    uniqueColumns.push(key);
  });
  if (uniqueColumns.length === 0) return undefined;

  const sort: Record<string, 1 | -1> = {};
  uniqueColumns.forEach((col) => {
    sort[col] = 1;
  });
  return sort;
};

export const buildMongoFindCommand = (params: {
  collection: string;
  filter: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, unknown>;
}): string => {
  const command: Record<string, unknown> = {
    find: String(params.collection || '').trim(),
    filter: params.filter || {},
  };
  if (params.projection && Object.keys(params.projection).length > 0) {
    command.projection = params.projection;
  }
  if (params.sort && Object.keys(params.sort).length > 0) {
    command.sort = params.sort;
  }
  if (Number.isFinite(params.limit) && Number(params.limit) > 0) {
    command.limit = Math.floor(Number(params.limit));
  }
  if (Number.isFinite(params.skip) && Number(params.skip) > 0) {
    command.skip = Math.floor(Number(params.skip));
  }
  return JSON.stringify(command);
};

export const buildMongoCountCommand = (collection: string, filter: Record<string, unknown>): string => {
  return JSON.stringify({
    count: String(collection || '').trim(),
    query: filter || {},
  });
};

const buildMongoInsertCommand = (
  collection: string,
  documents: Record<string, unknown>[],
  options: Record<string, unknown>,
): string => {
  const command: Record<string, unknown> = {
    insert: String(collection || '').trim(),
    documents,
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.bypassDocumentValidation !== 'undefined') {
    command.bypassDocumentValidation = !!options.bypassDocumentValidation;
  }
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

const buildMongoUpdateCommand = (
  collection: string,
  filter: Record<string, unknown>,
  update: unknown,
  options: Record<string, unknown>,
  multi: boolean,
): string => {
  const updateItem: Record<string, unknown> = {
    q: filter,
    u: update,
    multi,
  };
  if (typeof options.upsert !== 'undefined') updateItem.upsert = !!options.upsert;
  if (typeof options.collation !== 'undefined') updateItem.collation = options.collation;
  if (typeof options.arrayFilters !== 'undefined') updateItem.arrayFilters = options.arrayFilters;
  if (typeof options.hint !== 'undefined') updateItem.hint = options.hint;

  const command: Record<string, unknown> = {
    update: String(collection || '').trim(),
    updates: [updateItem],
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.bypassDocumentValidation !== 'undefined') {
    command.bypassDocumentValidation = !!options.bypassDocumentValidation;
  }
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

const buildMongoDeleteCommand = (
  collection: string,
  filter: Record<string, unknown>,
  options: Record<string, unknown>,
  limit: 0 | 1,
): string => {
  const deleteItem: Record<string, unknown> = {
    q: filter,
    limit,
  };
  if (typeof options.collation !== 'undefined') deleteItem.collation = options.collation;
  if (typeof options.hint !== 'undefined') deleteItem.hint = options.hint;

  const command: Record<string, unknown> = {
    delete: String(collection || '').trim(),
    deletes: [deleteItem],
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

export const convertMongoShellToJsonCommand = (raw: string): ShellConvertResult => {
  let input = String(raw || '').trim();
  input = input.replace(/^[\s]*(\/\/[^\n]*\n)+/g, '').trim();
  input = input.replace(/[;；]+\s*$/, '');
  if (!/^db\./i.test(input)) {
    return { recognized: false };
  }

  try {
    const parsed = parseCollectionAndMethod(input);
    if (!parsed) return { recognized: false };

    const collection = parsed.collection;
    const method = parsed.method;
    const args = splitTopLevelComma(parsed.argsText);
    const chain = parseChainCalls(parsed.tailText);

    if (method === 'find' || method === 'findone') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} first argument`) : {};
      let projection = args.length > 1 ? parseMongoJSONDoc(args[1], `${method} second argument (projection)`) : undefined;
      let sort: Record<string, 1 | -1> | undefined;
      let limit: number | undefined = method === 'findone' ? 1 : undefined;
      let skip: number | undefined;
      let useCountCommand = false;

      for (const item of chain) {
        if (item.method === 'sort') {
          sort = parseMongoSortObject(item.arg);
          continue;
        }
        if (item.method === 'limit') {
          limit = parsePositiveInt(item.arg, 'limit');
          continue;
        }
        if (item.method === 'skip') {
          skip = parsePositiveInt(item.arg, 'skip');
          continue;
        }
        if (item.method === 'project') {
          projection = parseMongoJSONDoc(item.arg, 'project argument');
          continue;
        }
        if (item.method === 'count') {
          if (item.arg) {
            const parsedBool = parseBooleanLiteral(item.arg);
            if (parsedBool === null) {
              throw new Error('count chain argument must be true or false');
            }
          }
          useCountCommand = true;
          continue;
        }
        if (isNoopMongoChainMethod(item.method)) {
          continue;
        }
        throw new Error(`Unsupported chain method .${item.method}()`);
      }

      if (method === 'findone') {
        limit = 1;
      }
      if (useCountCommand) {
        return {
          recognized: true,
          command: buildMongoCountCommand(collection, filter),
        };
      }

      return {
        recognized: true,
        command: buildMongoFindCommand({
          collection,
          filter,
          projection,
          sort,
          limit,
          skip,
        }),
      };
    }

    if (method === 'count' || method === 'countdocuments') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} argument`) : {};
      return {
        recognized: true,
        command: buildMongoCountCommand(collection, filter),
      };
    }

    if (method === 'aggregate') {
      const pipeline = args.length > 0 ? parseMongoJSONPipeline(args[0]) : [];
      const options = args.length > 1 ? parseMongoJSONDoc(args[1], 'aggregate second argument (options)') : {};

      for (const item of chain) {
        if (item.method === 'sort') {
          pipeline.push({ $sort: parseMongoSortObject(item.arg) });
          continue;
        }
        if (item.method === 'limit') {
          pipeline.push({ $limit: parsePositiveInt(item.arg, 'limit') });
          continue;
        }
        if (item.method === 'skip') {
          pipeline.push({ $skip: parsePositiveInt(item.arg, 'skip') });
          continue;
        }
        if (item.method === 'match') {
          pipeline.push({ $match: parseMongoJSONDoc(item.arg, 'match argument') });
          continue;
        }
        if (item.method === 'project') {
          pipeline.push({ $project: parseMongoJSONDoc(item.arg, 'project argument') });
          continue;
        }
        if (item.method === 'allowdiskuse') {
          options.allowDiskUse = parseBooleanArg(item.arg, 'allowDiskUse argument');
          continue;
        }
        if (isNoopMongoChainMethod(item.method)) {
          continue;
        }
        throw new Error(`Unsupported chain method .${item.method}()`);
      }

      const command: Record<string, unknown> = {
        aggregate: collection,
        pipeline,
      };
      Object.assign(command, options || {});
      if (typeof command.cursor === 'undefined') {
        command.cursor = {};
      }

      return {
        recognized: true,
        command: JSON.stringify(command),
      };
    }

    if (method === 'insertone' || method === 'insertmany' || method === 'insert') {
      if (args.length === 0) throw new Error(`${method} first argument is required`);
      const firstArg = parseMongoJSONValue(args[0]);
      let documents: Record<string, unknown>[] = [];
      if (method === 'insertone') {
        if (!firstArg || typeof firstArg !== 'object' || Array.isArray(firstArg)) {
          throw new Error('insertOne first argument must be a JSON object');
        }
        documents = [firstArg as Record<string, unknown>];
      } else if (method === 'insertmany') {
        const docs = parseMongoJSONArray(args[0], 'insertMany first argument');
        documents = normalizeMongoDocuments(docs, 'insertMany first argument');
      } else {
        documents = normalizeMongoDocuments(firstArg, 'insert first argument');
      }
      const options = parseMongoOptionalDoc(args[1]);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoInsertCommand(collection, documents, options),
      };
    }

    if (method === 'replaceone') {
      if (args.length < 2) {
        throw new Error('replaceOne requires filter and replacement arguments');
      }
      const filter = parseMongoJSONDoc(args[0], 'replaceOne first argument');
      const replacement = parseMongoJSONDoc(args[1], 'replaceOne second argument');
      const options = parseMongoOptionalDoc(args[2]);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoUpdateCommand(collection, filter, replacement, options, false),
      };
    }

    if (method === 'updateone' || method === 'updatemany' || method === 'update') {
      if (args.length < 2) {
        throw new Error(`${method} requires at least filter and update arguments`);
      }
      const filter = parseMongoJSONDoc(args[0], `${method} first argument`);
      const updateExpr = parseMongoJSONValue(args[1]);
      if (
        !updateExpr ||
        typeof updateExpr !== 'object'
      ) {
        throw new Error(`${method} second argument must be update document or pipeline`);
      }
      let options: Record<string, unknown> = {};
      if (method === 'update') {
        const third = args[2];
        const fourth = args[3];
        const thirdBool = parseBooleanLiteral(String(third || ''));
        if (typeof third === 'undefined' || !String(third).trim()) {
          options = {};
        } else if (thirdBool !== null) {
          options.upsert = thirdBool;
          if (typeof fourth !== 'undefined' && String(fourth).trim()) {
            const fourthBool = parseBooleanLiteral(String(fourth));
            if (fourthBool === null) throw new Error('update fourth argument must be true or false');
            options.multi = fourthBool;
          }
        } else {
          options = parseMongoOptionalDoc(third);
          if (typeof fourth !== 'undefined' && String(fourth).trim()) {
            const fourthBool = parseBooleanLiteral(String(fourth));
            if (fourthBool === null) throw new Error('update fourth argument must be true or false');
            options.multi = fourthBool;
          }
        }
      } else {
        options = parseMongoOptionalDoc(args[2]);
      }
      const multi = method === 'updatemany' || (method === 'update' && options.multi === true);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoUpdateCommand(collection, filter, updateExpr, options, multi),
      };
    }

    if (method === 'deleteone' || method === 'deletemany' || method === 'remove') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} first argument`) : {};
      let options: Record<string, unknown> = {};
      let limit: 0 | 1 = method === 'deleteone' ? 1 : 0;

      if (method === 'remove' && args.length > 1) {
        const rawSecond = String(args[1] || '').trim().toLowerCase();
        if (rawSecond === 'true' || rawSecond === 'false') {
          limit = rawSecond === 'true' ? 1 : 0;
        } else {
          options = parseMongoOptionalDoc(args[1]);
          if (typeof options.justOne !== 'undefined') {
            limit = options.justOne ? 1 : 0;
            delete options.justOne;
          }
        }
      } else if (args.length > 1) {
        options = parseMongoOptionalDoc(args[1]);
      }

      if (method === 'deletemany') limit = 0;
      if (method === 'deleteone') limit = 1;

      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoDeleteCommand(collection, filter, options, limit),
      };
    }

    return { recognized: false };
  } catch (error: any) {
    return {
      recognized: true,
      error: String(error?.message || error || 'Mongo shell command parse failed'),
    };
  }
};

