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

  it('shows the distinct selected-row count in the V2 statusbar', () => {
    const translate = (key: string, params?: Record<string, unknown>): string => (
      key === 'data_grid.pagination.selected_count'
        ? `Selected ${String(params?.count)} rows`
        : key
    );
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{ current: 1, pageSize: 100, total: 500, totalKnown: true }}
        selectedRowCount={6}
        paginationV2SummaryText="Current 100 rows / 500 rows total"
        paginationSummaryText="Current 100 rows / 500 rows total"
        paginationControlTotal={500}
        paginationTotalPages={5}
        paginationPageText="Page 1 / 5"
        paginationPageSizeOptions={['100']}
        showKnownPageCount
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
        translate={translate}
      />,
    );

    expect(markup).toContain('data-grid-selected-count="true"');
    expect(markup).toContain('Selected 6 rows');
  });

  it('does not render a selected-row count when nothing is selected', () => {
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui={false}
        pagination={{ current: 1, pageSize: 100, total: 24, totalKnown: true }}
        selectedRowCount={0}
        paginationV2SummaryText="24 rows"
        paginationSummaryText="Current 24 rows / 24 rows total"
        paginationControlTotal={24}
        paginationTotalPages={1}
        paginationPageText="Page 1 / 1"
        paginationPageSizeOptions={['100']}
        showKnownPageCount
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
      />,
    );

    expect(markup).not.toContain('data-grid-selected-count="true"');
  });

  it('keeps the selected-row count for non-paginated result sets', () => {
    const translate = (key: string, params?: Record<string, unknown>): string => (
      key === 'data_grid.pagination.selected_count'
        ? `Selected ${String(params?.count)} rows`
        : key
    );

    for (const isV2Ui of [true, false]) {
      const markup = renderToStaticMarkup(
        <DataGridPaginationBar
          isV2Ui={isV2Ui}
          selectedRowCount={3}
          paginationV2SummaryText=""
          paginationSummaryText=""
          paginationControlTotal={0}
          paginationTotalPages={1}
          paginationPageText=""
          paginationPageSizeOptions={[]}
          showKnownPageCount={false}
          onPageSizeChange={vi.fn()}
          onV2PageStep={vi.fn()}
          translate={translate}
        />,
      );

      expect(markup).toContain('data-grid-selected-count="true"');
      expect(markup).toContain('Selected 3 rows');
    }
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

  it('shows the TAG limitation before execution and disables total-count boundary actions', () => {
    const unavailableReason = 'Broker offsets cannot provide an exact TAG total.';
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{
          current: 1,
          pageSize: 100,
          total: 100,
          totalKnown: false,
          totalCountUnavailableLabel: 'TAG total unavailable',
          totalCountUnavailableReason: unavailableReason,
        }}
        paginationV2SummaryText="Current page loaded 100 rows"
        paginationSummaryText="Current page loaded 100 rows"
        paginationControlTotal={100}
        paginationTotalPages={1}
        paginationPageText="Page 1"
        paginationPageSizeOptions={['100']}
        showKnownPageCount={false}
        manualTotalCountAvailable
        onPageChange={vi.fn()}
        onLastPage={vi.fn()}
        onPageSizeChange={vi.fn()}
        onV2PageStep={vi.fn()}
        onToggleTotalCount={vi.fn()}
      />,
    );
    const totalCountButton = markup.match(/<button[^>]*data-grid-pagination-total-count="true"[^>]*>/)?.[0];
    const lastPageButton = markup.match(/<button[^>]*data-grid-pagination-last="true"[^>]*>/)?.[0];

    expect(totalCountButton).toContain('disabled');
    expect(markup).toContain('TAG total unavailable');
    expect(lastPageButton).toContain('disabled');
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
