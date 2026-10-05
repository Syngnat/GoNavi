import {
  normalizeExtendedJSON,
  evalMongoLikeLiteral,
  buildMongoDateLiteralText,
  getSingleMongoOperatorEntry,
  isPlainMongoObject,
  isMongoObjectIdFieldName,
  HEX24_RE,
  isMongoDateFieldName,
  parseMongoDateToMillis,
  buildMongoBinaryLiteralText,
  resolveMongoValueKind,
  looksLikeMongoStructuredLiteral,
  looksLikeExplicitMongoTypedLiteral,
  buildMongoExtendedDate,
  INTEGER_RE,
  normalizeMongoDoubleLiteral,
  FLOAT_RE,
  parseBooleanLiteral,
} from './mongodbLiterals';

export const parseMongoJSONValue = (raw: string): unknown => {
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
