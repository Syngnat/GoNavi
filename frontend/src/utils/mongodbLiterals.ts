type SortInfoItem = {
  columnKey?: string;
  order?: string;
  enabled?: boolean;
};

export type SortInfo = SortInfoItem | SortInfoItem[] | null | undefined;

export type ShellConvertResult = {
  recognized: boolean;
  command?: string;
  error?: string;
};

export const HEX24_RE = /^[0-9a-fA-F]{24}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
export const INTEGER_RE = /^[+-]?\d+$/;
export const FLOAT_RE = /^[+-]?(?:\d+\.\d+|\d+\.|\.\d+)$/;
const SCIENTIFIC_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)[eE][+-]?\d+$/;

export const isPlainMongoObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const getSingleMongoOperatorEntry = (value: unknown): [string, unknown] | null => {
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

export const isMongoObjectIdFieldName = (fieldName: string): boolean => {
  const text = String(fieldName || '').trim();
  if (!text) return false;
  return text === '_id'
    || text === 'id'
    || text.endsWith('Id')
    || text.endsWith('ID')
    || text.endsWith('_id')
    || text.endsWith('-id');
};

export const isMongoDateFieldName = (fieldName: string): boolean => {
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

export const buildMongoDateLiteralText = (raw?: unknown): string => {
  const millis = typeof raw === 'object' && raw && !Array.isArray(raw)
    ? parseMongoDateToMillis((raw as Record<string, unknown>)?.$numberLong ?? raw)
    : parseMongoDateToMillis(raw);
  if (millis !== null) {
    return new Date(millis).toISOString();
  }
  return String(raw ?? '');
};

export const buildMongoBinaryLiteralText = (raw: unknown): string | null => {
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

export const looksLikeExplicitMongoTypedLiteral = (raw: string): boolean => (
  /^(?:ObjectId|ISODate|NumberInt|NumberLong|NumberDouble|NumberDecimal|UUID|MaxKey|MinKey)\s*\(/i.test(String(raw || '').trim())
);

export const looksLikeMongoStructuredLiteral = (raw: string): boolean => {
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

export const resolveMongoValueKind = (value: unknown): MongoValueKind => {
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

export const escapeRegex = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const parseMongoDateToMillis = (raw: unknown): number | null => {
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

export const buildMongoExtendedDate = (raw?: unknown): { $date: { $numberLong: string } } | { $date: string } => {
  if (typeof raw === 'undefined') {
    return { $date: { $numberLong: String(Date.now()) } };
  }
  const millis = parseMongoDateToMillis(raw);
  if (millis !== null) {
    return { $date: { $numberLong: String(millis) } };
  }
  return { $date: String(raw ?? '') };
};

export const parseBooleanLiteral = (raw: string): boolean | null => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
};

export const normalizeMongoDoubleLiteral = (raw: string): string | null => {
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

export const normalizeExtendedJSON = (raw: string): string => {
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

export const evalMongoLikeLiteral = (raw: string): unknown => {
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

export const parseMongoScalar = (column: string, rawValue: string): unknown => {
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
