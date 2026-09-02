import { describe, expect, it } from 'vitest';

import {
  resolvePaginationPageText,
  resolvePaginationSummaryText,
  resolvePaginationTotalForControl,
} from './dataGridPagination';

const keyEchoTranslate = (key: string, params?: Record<string, unknown>): string => {
  const suffix = params ? ` ${JSON.stringify(params)}` : '';
  return `${key}${suffix}`;
};

describe('dataGridPagination', () => {
  it('resolves legacy pagination summaries through catalog keys', () => {
    const pagination = {
      current: 1,
      pageSize: 100,
      total: 1,
    };

    expect(resolvePaginationSummaryText({
      pagination,
      prefersManualTotalCount: false,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.known {"current":1,"total":1}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, total: 0 },
      prefersManualTotalCount: false,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.empty {"current":0,"total":0}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, totalKnown: false, totalCountLoading: true },
      prefersManualTotalCount: true,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.counting_exact {"current":1}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, totalKnown: false, totalCountLoading: true },
      prefersManualTotalCount: false,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.counting {"current":1}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, totalKnown: false },
      prefersManualTotalCount: false,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.not_counted {"current":1}');

    expect(resolvePaginationSummaryText({
      pagination: {
        ...pagination,
        totalKnown: false,
        totalApprox: true,
        approximateTotal: 1000,
      },
      prefersManualTotalCount: true,
      supportsApproximateTableCount: true,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.approximate {"current":1,"total":1000}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, totalKnown: false, totalCountCancelled: true },
      prefersManualTotalCount: true,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.cancelled {"current":1}');

    expect(resolvePaginationSummaryText({
      pagination: { ...pagination, totalKnown: false },
      prefersManualTotalCount: true,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.not_counted {"current":1}');

    expect(resolvePaginationSummaryText({
      pagination: {
        ...pagination,
        totalKnown: false,
        totalCountUnavailableLabel: 'TAG total unavailable',
      },
      prefersManualTotalCount: true,
      supportsApproximateTableCount: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.total_unavailable {"current":1,"label":"TAG total unavailable"}');
  });

  it('resolves pagination page labels through catalog keys', () => {
    const pagination = {
      current: 2,
      pageSize: 100,
      total: 201,
    };

    expect(resolvePaginationPageText({
      pagination,
      supportsApproximateTotalPages: true,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.page.known {"current":2,"totalPages":3}');

    expect(resolvePaginationPageText({
      pagination: { ...pagination, total: 0 },
      supportsApproximateTotalPages: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.page.current {"current":2}');
  });

  it('shows Oracle approximate total in summary but not in total-page chip', () => {
    const pagination = {
      current: 3,
      pageSize: 100,
      total: 301,
      totalKnown: false,
      totalApprox: true,
      approximateTotal: 1832451,
    };

    expect(resolvePaginationSummaryText({
      pagination,
      prefersManualTotalCount: true,
      supportsApproximateTableCount: true,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.summary.approximate {"current":100,"total":1832451}');

    expect(resolvePaginationPageText({
      pagination,
      supportsApproximateTotalPages: false,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.page.current {"current":3}');

    expect(resolvePaginationTotalForControl({
      pagination,
      supportsApproximateTotalPages: false,
    })).toBe(301);
  });

  it('still allows DuckDB to use approximate totals for page counts', () => {
    const pagination = {
      current: 2,
      pageSize: 100,
      total: 201,
      totalKnown: false,
      totalApprox: true,
      approximateTotal: 1000,
    };

    expect(resolvePaginationPageText({
      pagination,
      supportsApproximateTotalPages: true,
      translate: keyEchoTranslate,
    })).toBe('data_grid.pagination.page.known {"current":2,"totalPages":10}');

    expect(resolvePaginationTotalForControl({
      pagination,
      supportsApproximateTotalPages: true,
    })).toBe(1000);
  });
});
