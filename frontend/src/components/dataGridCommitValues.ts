import { type ColumnMeta, shouldOmitBlankDataGridInsertValue } from './dataGridColumnMeta';
import { normalizeTemporalLiteralText } from './dataGridCopyInsert';
import { isTemporalColumnType } from './dataGridTemporal';

type CommitColumnMeta = Partial<Pick<ColumnMeta, 'type' | 'default' | 'hasDefault' | 'extra'>>;

type NormalizeDataGridCommitCellValueParams = {
  columnName: string;
  value: any;
  mode: 'insert' | 'update';
  dbType?: string;
  meta?: CommitColumnMeta;
};

const NUMERIC_COLUMN_TYPE_RE = /\b(?:u?int(?:2|4|8|16|32|64|128)?|integer|smallint|tinyint|mediumint|bigint|byteint|largeint|u?hugeint|serial(?:2|4|8)?|bigserial|smallserial|decimal(?:32|64|128|256)?|dec|numeric|number|float(?:4|8|32|64)?|double(?:\s+precision)?|real|money|smallmoney|binary_float|binary_double)\b/i;
const DECIMAL_TEXT_RE = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

export const isNumericDataGridColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim();
  return raw !== '' && NUMERIC_COLUMN_TYPE_RE.test(raw);
};

// 将十进制文本归一化成正负号 + 有效数字 + 十进制指数，用于判断 Number 往返是否损失数值。
const canonicalDecimalText = (value: string): string | null => {
  const match = String(value || '').trim().match(DECIMAL_TEXT_RE);
  if (!match) return null;

  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2] || '';
  const fractionPart = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] || '0');
  if (!Number.isSafeInteger(exponent)) return null;

  let digits = `${integerPart}${fractionPart}`.replace(/^0+/, '');
  if (!digits) return '0';

  let decimalExponent = exponent - fractionPart.length;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    decimalExponent += 1;
  }
  return `${sign}${digits}e${decimalExponent}`;
};

export const normalizeNumericDataGridCommitValue = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.trim() === '') return value;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  const sourceKey = canonicalDecimalText(value);
  const numericKey = canonicalDecimalText(String(numeric));
  if (!sourceKey || !numericKey || sourceKey !== numericKey) return value;

  // JS Number 无法无损表达的安全整数必须保持文本，避免静默改掉末位。
  if (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) return value;
  return Object.is(numeric, -0) ? 0 : numeric;
};

export const normalizeDataGridCommitCellValue = ({
  value,
  mode,
  dbType,
  meta,
}: NormalizeDataGridCommitCellValueParams): any => {
  if (value === undefined) return undefined;
  if (shouldOmitBlankDataGridInsertValue(value, mode, meta)) return undefined;

  if (isTemporalColumnType(meta?.type, dbType)) {
    if (value === null) return null;
    if (typeof value === 'string') {
      const raw = value.trim();
      if (raw === '') {
        // INSERT 空时间值直接忽略字段，让数据库默认值生效；UPDATE 空时间值转 NULL。
        return mode === 'insert' ? undefined : null;
      }
      return normalizeTemporalLiteralText(value, meta?.type, true);
    }
    return value;
  }

  if (isNumericDataGridColumnType(meta?.type)) {
    return normalizeNumericDataGridCommitValue(value);
  }
  return value;
};
