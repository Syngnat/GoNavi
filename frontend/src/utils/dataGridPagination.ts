export type PaginationStateLike = {
  current: number;
  pageSize: number;
  total: number;
  totalKnown?: boolean;
  totalApprox?: boolean;
  approximateTotal?: number;
  totalCountLoading?: boolean;
  totalCountCancelled?: boolean;
  totalCountUnavailableLabel?: string;
  totalCountUnavailableReason?: string;
};

export type PaginationI18nParams = Record<string, string | number | boolean | null | undefined>;
export type PaginationTranslate = (key: string, params?: PaginationI18nParams) => string;

const fallbackTranslate: PaginationTranslate = (key) => key;

const toFiniteNonNegativeNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const resolveApproximateTotal = (pagination: PaginationStateLike): number | null => {
  if (!pagination.totalApprox) return null;
  const approximateTotal = toFiniteNonNegativeNumber(pagination.approximateTotal);
  return approximateTotal !== null && approximateTotal > 0 ? approximateTotal : null;
};

const resolveCurrentCount = (pagination: PaginationStateLike): number => {
  const total = toFiniteNonNegativeNumber(pagination.total) ?? 0;
  const rangeStart = Math.max(0, (pagination.current - 1) * pagination.pageSize + (total > 0 ? 1 : 0));
  const hasValidRange = total > 0 && rangeStart > 0;
  if (!hasValidRange) return 0;
  const rangeEnd = Math.min(total, rangeStart + pagination.pageSize - 1);
  return Math.max(0, rangeEnd - rangeStart + 1);
};

export const resolvePaginationSummaryText = (params: {
  pagination: PaginationStateLike;
  prefersManualTotalCount: boolean;
  supportsApproximateTableCount: boolean;
  translate?: PaginationTranslate;
}): string => {
  const { pagination, prefersManualTotalCount, supportsApproximateTableCount, translate = fallbackTranslate } = params;
  const currentCount = resolveCurrentCount(pagination);
  const total = toFiniteNonNegativeNumber(pagination.total) ?? 0;
  const approximateTotal = resolveApproximateTotal(pagination);

  if (pagination.totalCountUnavailableLabel) {
    return translate('data_grid.pagination.summary.total_unavailable', {
      current: currentCount,
      label: pagination.totalCountUnavailableLabel,
    });
  }

  if (pagination.totalKnown === false) {
    if (pagination.totalCountLoading) {
      return prefersManualTotalCount
        ? translate('data_grid.pagination.summary.counting_exact', { current: currentCount })
        : translate('data_grid.pagination.summary.counting', { current: currentCount });
    }
    if (supportsApproximateTableCount && approximateTotal !== null) {
      return translate('data_grid.pagination.summary.approximate', { current: currentCount, total: approximateTotal });
    }
    if (pagination.totalCountCancelled) return translate('data_grid.pagination.summary.cancelled', { current: currentCount });
    return translate('data_grid.pagination.summary.not_counted', { current: currentCount });
  }

  if (!Number.isFinite(total) || total <= 0) {
    return translate('data_grid.pagination.summary.empty', { current: 0, total: 0 });
  }

  return translate('data_grid.pagination.summary.known', { current: currentCount, total });
};

export const resolvePaginationPageText = (params: {
  pagination: PaginationStateLike;
  supportsApproximateTotalPages: boolean;
  translate?: PaginationTranslate;
}): string => {
  const { pagination, supportsApproximateTotalPages, translate = fallbackTranslate } = params;
  const exactTotal = toFiniteNonNegativeNumber(pagination.total) ?? 0;
  const approximateTotal = resolveApproximateTotal(pagination);
  const effectiveTotal =
    pagination.totalKnown !== false
      ? exactTotal
      : supportsApproximateTotalPages && approximateTotal !== null
        ? approximateTotal
        : 0;

  if (effectiveTotal <= 0) return translate('data_grid.pagination.page.current', { current: pagination.current });

  const totalPages = Math.max(1, Math.ceil(effectiveTotal / Math.max(1, pagination.pageSize)));
  if (pagination.totalKnown === false && !(supportsApproximateTotalPages && approximateTotal !== null)) {
    return translate('data_grid.pagination.page.current', { current: pagination.current });
  }
  return translate('data_grid.pagination.page.known', { current: pagination.current, totalPages });
};

export const resolvePaginationTotalForControl = (params: {
  pagination: PaginationStateLike;
  supportsApproximateTotalPages: boolean;
}): number => {
  const { pagination, supportsApproximateTotalPages } = params;
  const exactTotal = toFiniteNonNegativeNumber(pagination.total) ?? 0;
  const approximateTotal = resolveApproximateTotal(pagination);
  if (pagination.totalKnown !== false) return exactTotal;
  if (supportsApproximateTotalPages && approximateTotal !== null) return approximateTotal;
  return exactTotal;
};
