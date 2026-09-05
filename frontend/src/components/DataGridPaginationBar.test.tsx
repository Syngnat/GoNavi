import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  type Props = Record<string, any> & { children?: React.ReactNode };

  const omit = (props: Props, keys: string[]) => Object.fromEntries(
    Object.entries(props).filter(([key]) => !keys.includes(key)),
  );
  const Button = ({ children, icon, iconPosition, ...props }: Props) => ReactModule.createElement(
    'button',
    omit(props, ['size']),
    iconPosition === 'end' ? children : icon,
    iconPosition === 'end' ? icon : children,
  );
  const Input = (props: Props) => ReactModule.createElement(
    'input',
    omit(props, ['size', 'status', 'onPressEnter']),
  );
  const InputNumber = (props: Props) => ReactModule.createElement(
    'input',
    omit(props, ['size', 'min', 'max', 'precision', 'controls', 'onPressEnter']),
  );
  const Pagination = (props: Props) => ReactModule.createElement(
    'div',
    omit(props, ['current', 'pageSize', 'total', 'showSizeChanger', 'showTitle', 'size', 'itemRender', 'onChange']),
  );
  const Select = ({ popupRender, open, ...props }: Props) => ReactModule.createElement(
    'div',
    omit(props, ['size', 'popupMatchSelectWidth', 'options', 'onChange', 'onOpenChange']),
    ReactModule.createElement(
      'select',
      {
        ...omit(props, ['size', 'popupMatchSelectWidth', 'options', 'onChange', 'onOpenChange']),
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => props.onChange?.(event.target.value),
      },
      (props.options || []).map((option: { value: string; label: React.ReactNode }) => (
        ReactModule.createElement('option', { key: option.value, value: option.value }, option.label)
      )),
    ),
    open ? popupRender?.(ReactModule.createElement('div', { 'data-grid-page-size-menu': 'true' })) : null,
  );
  const Modal = ({ children, open }: Props) => (open
    ? ReactModule.createElement('div', null, children)
    : null
  );
  const Tooltip = ({ children }: Props) => ReactModule.createElement(ReactModule.Fragment, null, children);

  return { Button, Input, InputNumber, Modal, Pagination, Select, Tooltip };
});

vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const Icon = () => ReactModule.createElement('span');
  return {
    CloseOutlined: Icon,
    CheckOutlined: Icon,
    LeftOutlined: Icon,
    RightOutlined: Icon,
    VerticalAlignBottomOutlined: Icon,
    VerticalLeftOutlined: Icon,
    VerticalRightOutlined: Icon,
  };
});

import { Select } from 'antd';

import DataGridPaginationBar, {
  createDataGridLastPageAction,
  isValidDataGridCustomPageSize,
  resolveDataGridPaginationBoundaryTarget,
} from './DataGridPaginationBar';

describe('DataGridPaginationBar custom page size values', () => {
  const createProps = (onPageSizeChange: (value: string) => void) => ({
    isV2Ui: true,
    pagination: { current: 1, pageSize: 100, total: 500, totalKnown: true },
    paginationV2SummaryText: 'Current 100 rows / 500 rows total',
    paginationSummaryText: 'Current 100 rows / 500 rows total',
    paginationControlTotal: 500,
    paginationTotalPages: 5,
    paginationPageText: 'Page 1 / 5',
    paginationPageSizeOptions: ['100', '200'],
    showKnownPageCount: true,
    allowCustomPageSize: true,
    onPageChange: vi.fn(),
    onPageSizeChange,
    onV2PageStep: vi.fn(),
  });

  it.each(['', '0', '-1', '12.5', '1e3', 'not-a-number', '9007199254740992'])(
    'rejects custom page size input %j',
    (value) => {
      expect(isValidDataGridCustomPageSize(value)).toBe(false);
    },
  );

  it('accepts only positive safe decimal integers for custom page size input', () => {
    expect(isValidDataGridCustomPageSize('1500')).toBe(true);
    expect(isValidDataGridCustomPageSize('0001500')).toBe(true);
  });

  it('renders custom rows as an inline dropdown input without appending a page-size option', async () => {
    const onPageSizeChange = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataGridPaginationBar {...createProps(onPageSizeChange)} />);
    });

    const select = renderer.root.findAllByType(Select)[0];
    expect(select.props.options.map((option: { value: string }) => option.value)).toEqual(['100', '200']);
    expect(select.props.popupRender).toEqual(expect.any(Function));
    await act(async () => {
      select.props.onOpenChange(true);
    });
    expect(renderer.root.findAllByType(Select)[0].props.open).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-grid-custom-page-size-popover': 'true' })).toHaveLength(0);
    const customDropdown = renderer.root.findByProps({ 'data-grid-custom-page-size-dropdown': 'true' });
    expect(customDropdown.props.style).toEqual({
      width: 128,
      maxWidth: 'calc(100vw - 24px)',
    });

    const input = renderer.root.findByProps({ 'data-grid-custom-page-size-input': 'true' });
    expect(input.props.value).toBe('100');
    expect(input.props.style).toEqual({
      width: 80,
      minWidth: 80,
      maxWidth: 80,
      flex: '0 0 80px',
    });
    expect(renderer.root.findByProps({ 'data-grid-custom-page-size-confirm': 'true' }).props.style).toEqual({
      width: 24,
      minWidth: 24,
      maxWidth: 24,
      height: 24,
      minHeight: 24,
      flex: '0 0 24px',
    });
    await act(async () => {
      input.props.onChange({ target: { value: '0001500' } });
    });
    await act(async () => {
      renderer.root.findAllByType(Select)[0].props.onOpenChange(false);
    });
    expect(onPageSizeChange).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-grid-custom-page-size-dropdown': 'true' })).toHaveLength(0);

    await act(async () => {
      renderer.root.findAllByType(Select)[0].props.onOpenChange(true);
    });
    const reopenedInput = renderer.root.findByProps({ 'data-grid-custom-page-size-input': 'true' });
    await act(async () => {
      reopenedInput.props.onChange({ target: { value: '0001500' } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-grid-custom-page-size-confirm': 'true' }).props.onClick();
    });
    expect(onPageSizeChange).toHaveBeenCalledTimes(1);
    expect(onPageSizeChange).toHaveBeenCalledWith('1500');

    await act(async () => {
      renderer.update(
        <DataGridPaginationBar
          {...createProps(onPageSizeChange)}
          pagination={{ current: 1, pageSize: 1500, total: 500, totalKnown: true }}
        />,
      );
    });
    const updatedSelect = renderer.root.findAllByType(Select)[0];
    expect(updatedSelect.props.value).toBe('1500');
    expect(updatedSelect.props.options.map((option: { value: string }) => option.value)).toEqual(['100', '200']);
    await act(async () => {
      updatedSelect.props.onOpenChange(true);
    });
    expect(renderer.root.findByProps({ 'data-grid-custom-page-size-input': 'true' }).props.value).toBe('1500');
    renderer.unmount();
  });

  it.each(['', '0', '-1', '12.5', '1e3', 'not-a-number', '9007199254740992'])(
    'keeps the custom input open for invalid value %j', async (value) => {
      const onPageSizeChange = vi.fn();
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DataGridPaginationBar {...createProps(onPageSizeChange)} />);
      });
      await act(async () => {
        renderer.root.findAllByType(Select)[0].props.onOpenChange(true);
      });
      const input = renderer.root.findByProps({ 'data-grid-custom-page-size-input': 'true' });
      await act(async () => {
        input.props.onChange({ target: { value } });
        renderer.root.findByProps({ 'data-grid-custom-page-size-confirm': 'true' }).props.onClick();
      });
      expect(onPageSizeChange).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ 'data-grid-custom-page-size-error': 'true' })).toBeDefined();
      expect(renderer.root.findAllByType(Select)[0].props.open).toBe(true);
      renderer.unmount();
    },
  );
});

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
