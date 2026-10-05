import type { I18nParams } from '../../i18n';

export type ViewerPaginationState = {
  current: number;
  pageSize: number;
  total: number;
  totalKnown: boolean;
  totalApprox: boolean;
  approximateTotal?: number;
  totalCountLoading: boolean;
  totalCountCancelled: boolean;
};

export type DataViewerFetchOptions = {
  refreshTotal?: boolean;
  navigateToLastPage?: boolean;
};

export type DataViewerTranslator = (key: string, params?: I18nParams) => string;

const JS_MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const isIntegerText = (text: string): boolean => /^[+-]?\d+$/.test(text);

const toNonNegativeFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= JS_MAX_SAFE_INTEGER_BIGINT ? Number(value) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (isIntegerText(text)) {
      try {
        const parsedBigInt = BigInt(text);
        if (parsedBigInt < 0n || parsedBigInt > JS_MAX_SAFE_INTEGER_BIGINT) {
          return null;
        }
        return Number(parsedBigInt);
      } catch {
        return null;
      }
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
  }
  return null;
};

export const parseTotalFromCountRow = (row: any): number | null => {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row as Record<string, unknown>);
  if (entries.length === 0) return null;

  for (const [key, raw] of entries) {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized === 'total' || normalized === 'count' || normalized.includes('count')) {
      const parsed = toNonNegativeFiniteNumber(raw);
      if (parsed !== null) return parsed;
    }
  }

  for (const [, raw] of entries) {
    const parsed = toNonNegativeFiniteNumber(raw);
    if (parsed !== null) return parsed;
  }

  return null;
};

export const isKnownTotalFreshForPage = (total: unknown, minExpectedTotal: number): boolean => {
  const parsedTotal = toNonNegativeFiniteNumber(total);
  return parsedTotal !== null && parsedTotal >= minExpectedTotal;
};
