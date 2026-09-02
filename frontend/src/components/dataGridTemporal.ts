import dayjs from 'dayjs';
import type { ConnectionConfig } from '../types';
import { normalizeOceanBaseProtocol } from '../utils/oceanBaseProtocol';
import { isOracleLikeDialect } from '../utils/sqlDialect';

export type TemporalPickerType = 'datetime' | 'date' | 'time' | 'year' | null;
export type TemporalConnectionLike = Pick<ConnectionConfig, 'type' | 'driver' | 'oceanBaseProtocol'> | null | undefined;

export const TEMPORAL_FORMATS: Record<string, string> = {
  datetime: 'YYYY-MM-DD HH:mm:ss',
  date: 'YYYY-MM-DD',
  time: 'HH:mm:ss',
  year: 'YYYY',
};

// rc-picker briefly blurs the selector while moving focus into its body portal.
// Keep the editor alive long enough for the portal focus event to arrive.
export const TEMPORAL_PICKER_INTERACTION_DELAY_MS = 200;

export const isTemporalPickerPopupTarget = (target: EventTarget | null | undefined): boolean => {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
  const candidate = target as { closest?: (selector: string) => unknown };
  if (typeof candidate.closest !== 'function') return false;
  try {
    return !!candidate.closest('.ant-picker-dropdown, .ant-picker-panel');
  } catch {
    return false;
  }
};

export const isTemporalPickerPopupFocused = (relatedTarget?: EventTarget | null): boolean => {
  if (isTemporalPickerPopupTarget(relatedTarget)) return true;
  if (typeof document === 'undefined') return false;
  try {
    return isTemporalPickerPopupTarget(document.activeElement);
  } catch {
    return false;
  }
};

const TEMPORAL_DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/;
const temporalFractionMetaKey = Symbol('temporalFractionMeta');

type DayjsWithTemporalFractionMeta = dayjs.Dayjs & {
  [temporalFractionMetaKey]?: string;
};

type TemporalDateTimeParts = {
  datePart: string;
  timePart: string;
  fractionDigits: string;
  suffixAfterDate: string;
};

const parseTemporalDateTimeParts = (value: string): TemporalDateTimeParts | null => {
  const text = String(value || '').trim();
  const match = text.match(TEMPORAL_DATE_TIME_RE);
  if (!match) return null;
  return {
    datePart: match[1],
    timePart: match[2],
    fractionDigits: match[3] || '',
    suffixAfterDate: text.slice(match[1].length),
  };
};

const attachTemporalFractionMeta = (value: dayjs.Dayjs, fractionDigits: string): dayjs.Dayjs => {
  if (!value?.isValid?.()) return value;
  const normalizedDigits = String(fractionDigits || '');
  if (!normalizedDigits) return value;
  (value as DayjsWithTemporalFractionMeta)[temporalFractionMetaKey] = normalizedDigits;
  return value;
};

const getTemporalFractionMeta = (value: dayjs.Dayjs | null | undefined): string => {
  if (!value || !value.isValid()) return '';
  return String((value as DayjsWithTemporalFractionMeta)[temporalFractionMetaKey] || '');
};

const buildDayjsParseTextForDateTime = (datePart: string, timePart: string, fractionDigits: string): string => {
  if (!fractionDigits) return `${datePart} ${timePart}`;
  const milliseconds = fractionDigits.slice(0, 3).padEnd(3, '0');
  return `${datePart} ${timePart}.${milliseconds}`;
};

const formatDateTimeWithFractionMeta = (value: dayjs.Dayjs): string => {
  const base = value.format(TEMPORAL_FORMATS.datetime);
  const fractionDigits = getTemporalFractionMeta(value);
  if (!fractionDigits) return base;

  const milliseconds = String(value.millisecond()).padStart(3, '0');
  if (fractionDigits.length <= 3) {
    return `${base}.${milliseconds.slice(0, fractionDigits.length)}`;
  }
  return `${base}.${milliseconds}${fractionDigits.slice(3)}`;
};

export const getTemporalPickerFormat = (
  pickerType: TemporalPickerType,
): string | ((value: dayjs.Dayjs) => string) | Array<string | ((value: dayjs.Dayjs) => string)> => {
  if (pickerType !== 'datetime') {
    return TEMPORAL_FORMATS[pickerType || 'datetime'];
  }
  return [
    (value: dayjs.Dayjs) => formatDateTimeWithFractionMeta(value),
    'YYYY-MM-DD HH:mm:ss.SSSSSS',
    'YYYY-MM-DD HH:mm:ss.SSS',
    'YYYY-MM-DD HH:mm:ss',
  ];
};

export const isTemporalColumnType = (
  columnType?: string,
  dbType?: string,
  connectionConfig?: TemporalConnectionLike,
): boolean => {
  return !!getTemporalPickerType(columnType, dbType, connectionConfig);
};

const isOceanBaseOracleDateOnlyConnection = (connectionConfig?: TemporalConnectionLike): boolean => {
  if (!connectionConfig) return false;
  const type = String(connectionConfig.type || '').trim().toLowerCase();
  const driver = String(connectionConfig.driver || '').trim().toLowerCase();
  return (type === 'oceanbase' || driver === 'oceanbase')
    && normalizeOceanBaseProtocol(connectionConfig.oceanBaseProtocol) === 'oracle';
};

export const getTemporalPickerType = (
  columnType?: string,
  dbType?: string,
  connectionConfig?: TemporalConnectionLike,
): TemporalPickerType => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('datetime') || raw.includes('timestamp')) return 'datetime';
  const base = raw.split(/[ (]/)[0];
  if (base === 'date') {
    if (isOracleLikeDialect(String(dbType || '')) && !isOceanBaseOracleDateOnlyConnection(connectionConfig)) {
      return 'datetime';
    }
    return 'date';
  }
  if (base === 'time') return 'time';
  if (base === 'year') return 'year';
  return null;
};

export const parseToDayjs = (val: any, pickerType: TemporalPickerType): dayjs.Dayjs | null => {
  if (val === null || val === undefined || val === '') return null;
  const str = String(val).trim();
  if (!str || /^0{4}-0{2}-0{2}/.test(str)) return null;
  if (pickerType === 'date') {
    const parts = parseTemporalDateTimeParts(str);
    if (parts) {
      const parsedDate = dayjs(parts.datePart, TEMPORAL_FORMATS.date);
      if (parsedDate.isValid()) return parsedDate;
    }
  }
  if (pickerType === 'datetime') {
    const parts = parseTemporalDateTimeParts(str);
    if (parts) {
      const parsed = dayjs(buildDayjsParseTextForDateTime(parts.datePart, parts.timePart, parts.fractionDigits));
      if (parsed.isValid()) {
        return attachTemporalFractionMeta(parsed, parts.fractionDigits);
      }
    }
  }
  const fmt = TEMPORAL_FORMATS[pickerType || 'datetime'];
  const d = dayjs(str, fmt);
  if (d.isValid()) {
    const parts = pickerType === 'datetime' ? parseTemporalDateTimeParts(str) : null;
    return parts ? attachTemporalFractionMeta(d, parts.fractionDigits) : d;
  }
  const fallback = dayjs(str);
  if (!fallback.isValid()) return null;
  const parts = pickerType === 'datetime' ? parseTemporalDateTimeParts(str) : null;
  return parts ? attachTemporalFractionMeta(fallback, parts.fractionDigits) : fallback;
};

export const formatFromDayjs = (val: dayjs.Dayjs | null, pickerType: TemporalPickerType): string => {
  if (!val || !val.isValid()) return '';
  if (pickerType === 'datetime') {
    return formatDateTimeWithFractionMeta(val);
  }
  const fmt = TEMPORAL_FORMATS[pickerType || 'datetime'];
  return val.format(fmt);
};

export const resolveTemporalEditorSaveValue = (
  formValue: any,
  pickerValue: dayjs.Dayjs | null | undefined,
  pickerType: TemporalPickerType,
  originalValue?: any,
): string | null | any => {
  const value = pickerValue !== undefined ? pickerValue : formValue;
  if (value && dayjs.isDayjs(value)) {
    const formatted = formatFromDayjs(value as dayjs.Dayjs, pickerType);
    if (pickerType === 'date' && typeof originalValue === 'string') {
      const originalParts = parseTemporalDateTimeParts(originalValue);
      if (originalParts) {
        return `${formatted}${originalParts.suffixAfterDate}`;
      }
    }
    return formatted;
  }
  if (!value) {
    return null;
  }
  return value;
};
