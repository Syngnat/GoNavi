import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import DataGridPaginationBar, {
  createDataGridLastPageAction,
  resolveDataGridPaginationBoundaryTarget,
} from './DataGridPaginationBar';

describe('DataGridPaginationBar boundary navigation', () => {
  it('resolves the first and last page when the total page count is known', () => {
    const options = {
      current: 3,
      totalPages: 10,
      totalKnown: true,
      canNavigate: true,
    };

    expect(resolveDataGridPaginationBoundaryTarget({ boundary: 'first', ...options })).toBe(1);
    expect(resolveDataGridPaginationBoundaryTarget({ boundary: 'last', ...options })).toBe(10);
  });

  it('keeps first-page navigation but has no last-page target when the total is unknown', () => {
    const options = {
      current: 3,
      totalPages: 4,
      totalKnown: false,
      canNavigate: true,
    };

    expect(resolveDataGridPaginationBoundaryTarget({ boundary: 'first', ...options })).toBe(1);
    expect(resolveDataGridPaginationBoundaryTarget({ boundary: 'last', ...options })).toBeNull();
  });

  it('has no boundary target when already at that boundary or navigation is unavailable', () => {
    expect(resolveDataGridPaginationBoundaryTarget({
      boundary: 'first',
      current: 1,
      totalPages: 10,
      totalKnown: true,
      canNavigate: true,
    })).toBeNull();
    expect(resolveDataGridPaginationBoundaryTarget({
      boundary: 'last',
      current: 10,
      totalPages: 10,
      totalKnown: true,
      canNavigate: true,
    })).toBeNull();
    expect(resolveDataGridPaginationBoundaryTarget({
      boundary: 'first',
      current: 3,
      totalPages: 10,
      totalKnown: true,
      canNavigate: false,
    })).toBeNull();
  });

  it('renders visible first-page and last-page labels instead of icon-only controls', () => {
    const translate = (key: string): string => ({
      'data_grid.pagination.first_page': 'First page',
      'data_grid.pagination.last_page': 'Last page',
    }[key] || key);
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{ current: 2, pageSize: 100, total: 500, totalKnown: true }}
        paginationV2SummaryText="200 rows"
        paginationSummaryText="200 rows"
        paginationControlTotal={500}
        paginationTotalPages={5}
        paginationPageText="Page 2 / 5"
        paginationPageSizeOptions={['100']}
        showKnownPageCount
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
        translate={translate}
      />,
    );

    expect(markup).toMatch(/data-grid-pagination-first="true"[^>]*>[\s\S]*First page[\s\S]*?<\/button>/);
    expect(markup).toMatch(/data-grid-pagination-last="true"[^>]*>[\s\S]*Last page[\s\S]*?<\/button>/);
  });

  it('does not render a total-count action without a real callback', () => {
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{ current: 1, pageSize: 100, total: 200, totalKnown: false }}
        paginationV2SummaryText="100 rows"
        paginationSummaryText="100 rows"
        paginationControlTotal={200}
        paginationTotalPages={2}
        paginationPageText="Page 1"
        paginationPageSizeOptions={['100']}
        showKnownPageCount={false}
        manualTotalCountAvailable
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
      />,
    );

    expect(markup).not.toContain('data-grid-pagination-total-count="true"');
  });

  it('keeps the last-page action available for a fresh tail lookup at the cached boundary', () => {
    const onPageChange = vi.fn();
    const onLastPage = vi.fn();
    const action = createDataGridLastPageAction({
      current: 10,
      pageSize: 10,
      totalPages: 10,
      totalKnown: true,
      onPageChange,
      onLastPage,
    });
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{ current: 10, pageSize: 10, total: 100, totalKnown: true }}
        paginationV2SummaryText="100 rows"
        paginationSummaryText="100 rows"
        paginationControlTotal={100}
        paginationTotalPages={10}
        paginationPageText="Page 10 / 10"
        paginationPageSizeOptions={['10']}
        showKnownPageCount
        onPageChange={onPageChange}
        onLastPage={onLastPage}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
      />,
    );
    const lastPageButton = markup.match(/<button[^>]*data-grid-pagination-last="true"[^>]*>/)?.[0];

    expect(lastPageButton).toBeDefined();
    expect(lastPageButton).not.toContain('disabled');
    expect(action).toEqual(expect.any(Function));
    action?.();

    expect(onLastPage).toHaveBeenCalledWith(10);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('falls back to cached last-page navigation when no fresh callback is available', () => {
    const onPageChange = vi.fn();
    const action = createDataGridLastPageAction({
      current: 3,
      pageSize: 10,
      totalPages: 10,
      totalKnown: true,
      onPageChange,
    });

    expect(action).toEqual(expect.any(Function));
    action?.();
    expect(onPageChange).toHaveBeenCalledWith(10, 10);
  });

});
