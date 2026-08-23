import type { FilterCondition } from './sql';
import { parseListValues } from './sql';

type SortInfoItem = {
  columnKey?: string;
  order?: string;
  enabled?: boolean;
};

type SortInfo = SortInfoItem | SortInfoItem[] | null | undefined;

type ShellConvertResult = {
  recognized: boolean;
  command?: string;
  error?: string;
};

const HEX24_RE = /^[0-9a-fA-F]{24}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const INTEGER_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d+|\d+\.|\.\d+)$/;
const SCIENTIFIC_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)[eE][+-]?\d+$/;

const isPlainMongoObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const getSingleMongoOperatorEntry = (value: unknown): [string, unknown] | null => {
  if (!isPlainMongoObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  return entries[0] || null;
};

const byteArrayToBase64 = (bytes: Uint8Array): string => {
  const BufferCtor = (globalThis as any)?.Buffer;
  if (BufferCtor) {
    return BufferCtor.from(bytes).toString('base64');
  }
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return globalThis.btoa(binary);
};

const base64ToByteArray = (base64: string): Uint8Array => {
  const BufferCtor = (globalThis as any)?.Buffer;
  if (BufferCtor) {
    return Uint8Array.from(BufferCtor.from(base64, 'base64'));
  }
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const uuidToBytes = (uuid: string): Uint8Array => {
  const hex = String(uuid || '').trim().replace(/-/g, '').toLowerCase();
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const bytesToUuid = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex.length !== 32) return '';
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

const buildMongoBinaryUUID = (uuidText: string): { $binary: { base64: string; subType: string } } => ({
  $binary: {
    base64: byteArrayToBase64(uuidToBytes(uuidText)),
    subType: '04',
  },
});

const isMongoObjectIdFieldName = (fieldName: string): boolean => {
  const text = String(fieldName || '').trim();
  if (!text) return false;
  return text === '_id'
    || text === 'id'
    || text.endsWith('Id')
    || text.endsWith('ID')
    || text.endsWith('_id')
    || text.endsWith('-id');
};

const isMongoDateFieldName = (fieldName: string): boolean => {
  const text = String(fieldName || '').trim();
  if (!text) return false;
  return text === 'date'
    || text === 'time'
    || text === 'timestamp'
    || text.endsWith('Date')
    || text.endsWith('Time')
    || text.endsWith('At')
    || text.endsWith('Timestamp')
    || text.endsWith('_date')
    || text.endsWith('_time')
    || text.endsWith('_at')
    || text.endsWith('_timestamp')
    || text.endsWith('-date')
    || text.endsWith('-time')
    || text.endsWith('-at')
    || text.endsWith('-timestamp');
};

const buildMongoDateLiteralText = (raw?: unknown): string => {
  const millis = typeof raw === 'object' && raw && !Array.isArray(raw)
    ? parseMongoDateToMillis((raw as Record<string, unknown>)?.$numberLong ?? raw)
    : parseMongoDateToMillis(raw);
  if (millis !== null) {
    return new Date(millis).toISOString();
  }
  return String(raw ?? '');
};

const buildMongoBinaryLiteralText = (raw: unknown): string | null => {
  if (!isPlainMongoObject(raw)) return null;
  const binary = raw.$binary;
  if (!isPlainMongoObject(binary)) return null;
  const subType = String(binary.subType ?? '').trim().toLowerCase();
  const base64 = String(binary.base64 ?? '').trim();
  if (subType !== '04' || !base64) return null;
  try {
    const uuidText = bytesToUuid(base64ToByteArray(base64));
    return UUID_RE.test(uuidText) ? `UUID("${uuidText}")` : null;
  } catch {
    return null;
  }
};

const looksLikeExplicitMongoTypedLiteral = (raw: string): boolean => (
  /^(?:ObjectId|ISODate|NumberInt|NumberLong|NumberDouble|NumberDecimal|UUID|MaxKey|MinKey)\s*\(/i.test(String(raw || '').trim())
);

const looksLikeMongoStructuredLiteral = (raw: string): boolean => {
  const text = String(raw || '').trim();
  if (!text) return false;
  const first = text[0];
  const last = text[text.length - 1];
  return (first === '{' && last === '}') || (first === '[' && last === ']');
};

type MongoValueKind =
  | 'nullish'
  | 'string'
  | 'boolean'
  | 'number'
  | 'object'
  | 'array'
  | 'objectId'
  | 'date'
  | 'int32'
  | 'int64'
  | 'double'
  | 'decimal128'
  | 'uuid'
  | 'binary'
  | 'maxKey'
  | 'minKey';

const resolveMongoValueKind = (value: unknown): MongoValueKind => {
  if (value === null || typeof value === 'undefined') return 'nullish';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  const singleEntry = getSingleMongoOperatorEntry(value);
  if (singleEntry) {
    switch (singleEntry[0]) {
      case '$oid':
        return 'objectId';
      case '$date':
        return 'date';
      case '$numberInt':
        return 'int32';
      case '$numberLong':
        return 'int64';
      case '$numberDouble':
        return 'double';
      case '$numberDecimal':
        return 'decimal128';
      case '$binary': {
        const binary = singleEntry[1];
        if (isPlainMongoObject(binary) && String(binary.subType ?? '').trim().toLowerCase() === '04') {
          return 'uuid';
        }
        return 'binary';
      }
      case '$maxKey':
        return 'maxKey';
      case '$minKey':
        return 'minKey';
      default:
        break;
    }
  }
  return typeof value === 'object' ? 'object' : 'string';
};

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

  const naiveMatch = text.match(
    /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?)?$/
  );
  if (naiveMatch) {
    const [, datePart, timePart = '00:00:00', fractionPart = ''] = naiveMatch;
    const fractionDigits = fractionPart ? `${fractionPart.slice(1)}000`.slice(0, 3) : '000';
    const utcText = `${datePart}T${timePart}.${fractionDigits}Z`;
    const utcMillis = Date.parse(utcText);
    if (!Number.isNaN(utcMillis)) return utcMillis;
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

const normalizeMongoDoubleLiteral = (raw: string): string | null => {
  const text = String(raw || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === 'nan') return 'NaN';
  if (lower === 'infinity' || lower === '+infinity') return 'Infinity';
  if (lower === '-infinity') return '-Infinity';
  if (INTEGER_RE.test(text) || FLOAT_RE.test(text) || SCIENTIFIC_RE.test(text)) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? String(parsed) : null;
  }
  return null;
};

const normalizeExtendedJSON = (raw: string): string => {
  let text = String(raw || '');
  text = text.replace(/ObjectId\s*\(\s*["']([0-9a-fA-F]{24})["']\s*\)/g, (_m, oid: string) => JSON.stringify({ $oid: oid }));
  text = text.replace(/ISODate\s*\(\s*["']([^"']+)["']\s*\)/g, (_m, dateText: string) => JSON.stringify(buildMongoExtendedDate(dateText)));
  text = text.replace(/NumberLong\s*\(\s*["']?([+-]?\d+)["']?\s*\)/g, '{"$numberLong":"$1"}');
  text = text.replace(/NumberInt\s*\(\s*["']?([+-]?\d+)["']?\s*\)/g, '{"$numberInt":"$1"}');
  text = text.replace(/NumberDouble\s*\(\s*["']?([^"')]+)["']?\s*\)/g, '{"$numberDouble":"$1"}');
  text = text.replace(/NumberDecimal\s*\(\s*["']?([+-]?(?:\d+(?:\.\d+)?|\.\d+))["']?\s*\)/g, '{"$numberDecimal":"$1"}');
  text = text.replace(/UUID\s*\(\s*["']([0-9a-fA-F-]{36})["']\s*\)/g, (_m, uuidText: string) => JSON.stringify(buildMongoBinaryUUID(uuidText)));
  text = text.replace(/MaxKey\s*\(\s*\)/g, '{"$maxKey":1}');
  text = text.replace(/MinKey\s*\(\s*\)/g, '{"$minKey":1}');
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
  const NumberDouble = (value: unknown) => {
    const normalized = normalizeMongoDoubleLiteral(String(value ?? '').trim());
    if (!normalized) throw new Error(`NumberDouble invalid value: ${String(value)}`);
    return { $numberDouble: normalized };
  };
  const NumberDecimal = (value: unknown) => {
    const text = String(value ?? '').trim();
    if (!text) throw new Error('NumberDecimal invalid value');
    return { $numberDecimal: text };
  };
  const UUID = (value: unknown) => {
    const text = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!UUID_RE.test(text)) {
      throw new Error(`UUID invalid value: ${text}`);
    }
    return buildMongoBinaryUUID(text.toLowerCase());
  };
  const MaxKey = () => ({ $maxKey: 1 });
  const MinKey = () => ({ $minKey: 1 });

  const parser = new Function(
    'ObjectId',
    'ISODate',
    'NumberInt',
    'NumberLong',
    'NumberDouble',
    'NumberDecimal',
    'UUID',
    'MaxKey',
    'MinKey',
    '"use strict"; return (' + expression + ');',
  );
  const evaluated = parser(ObjectId, ISODate, NumberInt, NumberLong, NumberDouble, NumberDecimal, UUID, MaxKey, MinKey);
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

const relaxMongoDateValue = (raw: unknown): { $date: string } => ({
  $date: buildMongoDateLiteralText(raw),
});

const normalizeMongoFieldValueForEditing = (fieldName: string, value: unknown): unknown => {
  if (value === null || typeof value === 'undefined') return value;

  const singleEntry = getSingleMongoOperatorEntry(value);
  if (singleEntry) {
    if (singleEntry[0] === '$date') {
      return relaxMongoDateValue(singleEntry[1]);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeMongoFieldValueForEditing(fieldName, item));
  }

  if (isPlainMongoObject(value)) {
    const next: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, nestedValue]) => {
      next[key] = normalizeMongoFieldValueForEditing(key, nestedValue);
    });
    return next;
  }

  if (typeof value !== 'string') return value;

  const text = value.trim();
  if (!text) return value;

  if (isMongoObjectIdFieldName(fieldName) && HEX24_RE.test(text)) {
    return { $oid: text.toLowerCase() };
  }

  if (isMongoDateFieldName(fieldName)) {
    const millis = parseMongoDateToMillis(text);
    if (millis !== null) {
      return relaxMongoDateValue(millis);
    }
  }

  return value;
};

export const normalizeMongoDocumentForEditing = <T>(value: T): T => (
  normalizeMongoFieldValueForEditing('', value) as T
);

export const formatMongoValueForDisplay = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'undefined') return '';
  const singleEntry = getSingleMongoOperatorEntry(value);
  if (singleEntry) {
    switch (singleEntry[0]) {
      case '$oid':
        return `ObjectId("${String(singleEntry[1] ?? '')}")`;
      case '$date':
        return `ISODate("${buildMongoDateLiteralText(singleEntry[1])}")`;
      case '$numberInt':
        return `NumberInt(${String(singleEntry[1] ?? '')})`;
      case '$numberLong':
        return `NumberLong("${String(singleEntry[1] ?? '')}")`;
      case '$numberDouble':
        return String(singleEntry[1] ?? '');
      case '$numberDecimal':
        return `NumberDecimal("${String(singleEntry[1] ?? '')}")`;
      case '$binary': {
        const binaryText = buildMongoBinaryLiteralText(value);
        if (binaryText) return binaryText;
        break;
      }
      case '$maxKey':
        return 'MaxKey()';
      case '$minKey':
        return 'MinKey()';
      default:
        break;
    }
  }
  if (Array.isArray(value) || isPlainMongoObject(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

export const formatMongoEditableValue = (value: unknown, columnName = ''): string => {
  const normalizedValue = normalizeMongoFieldValueForEditing(columnName, value);
  if (normalizedValue === null || typeof normalizedValue === 'undefined') return '';
  const singleEntry = getSingleMongoOperatorEntry(normalizedValue);
  if (singleEntry) {
    return formatMongoValueForDisplay(normalizedValue);
  }
  if (Array.isArray(normalizedValue) || isPlainMongoObject(normalizedValue)) {
    try {
      return JSON.stringify(normalizedValue, null, 2);
    } catch {
      return String(normalizedValue);
    }
  }
  return String(normalizedValue);
};

export const parseMongoEditedValue = (
  columnName: string,
  rawValue: unknown,
  currentValue?: unknown,
): unknown => {
  if (typeof rawValue !== 'string') return rawValue;

  const normalizedCurrentValue = normalizeMongoFieldValueForEditing(columnName, currentValue);
  const inferredRawValue = normalizeMongoFieldValueForEditing(columnName, rawValue);
  const currentKind = resolveMongoValueKind(normalizedCurrentValue);
  const text = rawValue.trim();
  const structuredLiteral = looksLikeMongoStructuredLiteral(rawValue);
  const explicitLiteral = looksLikeExplicitMongoTypedLiteral(rawValue);

  if (structuredLiteral || explicitLiteral) {
    return parseMongoJSONValue(rawValue);
  }

  switch (currentKind) {
    case 'objectId':
      if (HEX24_RE.test(text)) return { $oid: text.toLowerCase() };
      return rawValue;
    case 'date':
      if (!text) return rawValue;
      return buildMongoExtendedDate(text);
    case 'int32':
      if (INTEGER_RE.test(text)) return { $numberInt: String(Number.parseInt(text, 10)) };
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    case 'int64':
      if (INTEGER_RE.test(text)) return { $numberLong: text };
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    case 'double': {
      const normalized = normalizeMongoDoubleLiteral(text);
      if (normalized !== null) return { $numberDouble: normalized };
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    }
    case 'decimal128':
      if (INTEGER_RE.test(text) || FLOAT_RE.test(text)) return { $numberDecimal: text };
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    case 'boolean': {
      const boolValue = parseBooleanLiteral(text);
      if (boolValue !== null) return boolValue;
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    }
    case 'number':
      if (INTEGER_RE.test(text) || FLOAT_RE.test(text)) {
        const parsed = Number(text);
        return Number.isFinite(parsed) ? parsed : rawValue;
      }
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    case 'array':
    case 'object':
    case 'uuid':
    case 'binary':
    case 'maxKey':
    case 'minKey':
      if (text.toLowerCase() === 'null') return null;
      return rawValue;
    case 'string':
    case 'nullish':
    default:
      if (inferredRawValue !== rawValue) return inferredRawValue;
      return rawValue;
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
  const items = Array.isArray(sortInfo) ? sortInfo : (sortInfo ? [sortInfo] : []);
  const sort: Record<string, 1 | -1> = {};
  const seen = new Set<string>();
  for (const item of items) {
    if (item?.enabled === false) continue;
    const col = String(item?.columnKey || '').trim();
    const order = String(item?.order || '');
    if (col && (order === 'ascend' || order === 'descend')) {
      const key = col.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        sort[col] = order === 'ascend' ? 1 : -1;
      }
    }
  }
  if (Object.keys(sort).length > 0) return sort;

  const uniqueColumns: string[] = [];
  (fallbackColumns || []).forEach((col) => {
    const key = String(col || '').trim();
    if (!key) return;
    const low = key.toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    uniqueColumns.push(key);
  });
  if (uniqueColumns.length === 0) return undefined;

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
  includeObjectIDLocator?: boolean;
}): string => {
  const command: Record<string, unknown> = {
    find: String(params.collection || '').trim(),
    filter: params.filter || {},
  };
  if (params.includeObjectIDLocator) {
    command.__gonaviIncludeObjectIDLocator = true;
  }
  if (params.projection && Object.keys(params.projection).length > 0) {
    command.projection = params.projection;
  }
  if (params.sort && Object.keys(params.sort).length > 0) {
    command.sort = params.sort;
  }
  if (Number.isFinite(params.limit) && Number(params.limit) >= 0) {
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

const hasOwn = (obj: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

const isMongoCommandObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const applyMongoQueryAutoLimit = (
  command: string,
  maxRows: number,
): { command: string; applied: boolean; maxRows: number } => {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { command, applied: false, maxRows };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(command || '').trim());
  } catch {
    return { command, applied: false, maxRows };
  }
  if (!isMongoCommandObject(parsed)) return { command, applied: false, maxRows };

  const nextMaxRows = Math.floor(Number(maxRows));
  if (hasOwn(parsed, 'find')) {
    if (hasOwn(parsed, 'limit')) return { command, applied: false, maxRows };
    parsed.limit = nextMaxRows;
    return { command: JSON.stringify(parsed), applied: true, maxRows };
  }

  if (hasOwn(parsed, 'aggregate') && Array.isArray(parsed.pipeline)) {
    const pipeline = parsed.pipeline as unknown[];
    const hasExplicitLimit = pipeline.some((stage) => isMongoCommandObject(stage) && hasOwn(stage, '$limit'));
    const hasWriteStage = pipeline.some((stage) => isMongoCommandObject(stage) && (hasOwn(stage, '$out') || hasOwn(stage, '$merge')));
    if (hasExplicitLimit || hasWriteStage) return { command, applied: false, maxRows };
    pipeline.push({ $limit: nextMaxRows });
    return { command: JSON.stringify(parsed), applied: true, maxRows };
  }

  return { command, applied: false, maxRows };
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

const convertMongoShellShortcutCommand = (raw: string): ShellConvertResult | null => {
  const normalized = String(raw || '')
    .replace(/[;；]+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === 'show dbs' || normalized === 'show databases') {
    return {
      recognized: true,
      command: JSON.stringify({ listDatabases: 1, nameOnly: true }),
    };
  }

  if (normalized === 'show collections' || normalized === 'show tables') {
    return {
      recognized: true,
      command: JSON.stringify({ listCollections: 1, filter: {}, nameOnly: true }),
    };
  }

  return null;
};

export const convertMongoShellToJsonCommand = (raw: string): ShellConvertResult => {
  let input = String(raw || '').trim();
  input = input.replace(/^[\s]*(\/\/[^\n]*\n)+/g, '').trim();
  input = input.replace(/[;；]+\s*$/, '');
  const shortcut = convertMongoShellShortcutCommand(input);
  if (shortcut) {
    return shortcut;
  }
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

    if (method === 'distinct') {
      if (args.length === 0) throw new Error('distinct field argument is required');
      const key = parseMongoJSONValue(args[0]);
      if (typeof key !== 'string' || !key.trim()) {
        throw new Error('distinct field argument must be a string');
      }
      const query = args.length > 1 ? parseMongoJSONDoc(args[1], 'distinct query argument') : {};
      const options = args.length > 2 ? parseMongoOptionalDoc(args[2]) : {};
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      const command: Record<string, unknown> = {
        distinct: collection,
        key: key.trim(),
        query,
      };
      for (const option of ['collation', 'hint', 'comment', 'maxTimeMS', 'readConcern', 'let']) {
        if (typeof options[option] !== 'undefined') command[option] = options[option];
      }
      return {
        recognized: true,
        command: JSON.stringify(command),
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
