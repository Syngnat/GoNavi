import React from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import DataGridColumnTitle from './DataGridColumnTitle';

vi.mock('antd', () => ({
  Button: ({ children, type: buttonType, htmlType, ...props }: { children?: React.ReactNode; type?: string; htmlType?: 'button' | 'submit' | 'reset' }) => (
    <button type={htmlType || 'button'} data-button-type={buttonType} {...props}>
      {children}
    </button>
  ),
  Form: ({ children, component: Component = 'form', onFinish: _onFinish, ...props }: { children?: React.ReactNode; component?: React.ElementType; onFinish?: () => void }) => (
    <Component {...props}>{children}</Component>
  ),
  Input: Object.assign(
    ({ onPressEnter: _onPressEnter, ...props }: { onPressEnter?: () => void }) => <input {...props} />,
    {
      TextArea: ({ autoSize: _autoSize, ...props }: { autoSize?: unknown }) => <textarea {...props} />,
    },
  ),
  Popover: ({ children, content, open }: { children: React.ReactNode; content?: React.ReactNode; open?: boolean }) => (
    <span data-popover-open={open ? 'true' : 'false'}>
      {content}
      {children}
    </span>
  ),
  Select: ({ options = [], value, onChange }: { options?: Array<{ value: string; label: string }>; value?: string; onChange?: (value: string) => void }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Checkbox: ({ children, checked, onChange, ...props }: { children?: React.ReactNode; checked?: boolean; onChange?: () => void }) => (
    <label {...props}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  ),
  Table: ({
    columns = [],
    dataSource = [],
    onChange,
  }: {
    columns?: Array<{
      key?: React.Key;
      title?: React.ReactNode;
      dataIndex?: string;
      sortOrder?: string | null;
      render?: (value: unknown, record: Record<string, unknown>, index: number) => React.ReactNode;
    }>;
    dataSource?: Array<Record<string, unknown>>;
    onChange?: (...args: unknown[]) => void;
  }) => (
    <table
      data-value-count-table="true"
      data-count-sort-order={String(columns.find((column) => column.key === 'count')?.sortOrder || '')}
      onClick={() => onChange?.({}, {}, { order: 'ascend' })}
    >
      <thead>
        <tr>{columns.map((column) => <th key={column.key}>{column.title}</th>)}</tr>
      </thead>
      <tbody>
        {dataSource.map((record, index) => (
          <tr key={String(record.key || index)}>
            {columns.map((column) => (
              <td key={column.key}>
                {column.render
                  ? column.render(column.dataIndex ? record[column.dataIndex] : undefined, record, index)
                  : (column.dataIndex ? String(record[column.dataIndex] ?? '') : null)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  Tooltip: ({ children, title, rootClassName }: { children: React.ReactNode; title?: React.ReactNode; rootClassName?: string }) => (
    <>
      <div data-testid="tooltip-title">{title}</div>
      <div data-tooltip-root-class={rootClassName}>{title}</div>
      {children}
    </>
  ),
}));

vi.mock('@ant-design/icons', () => ({
  FilterOutlined: () => <span data-icon="filter" />,
  LinkOutlined: () => <span data-icon="link" />,
  SearchOutlined: () => <span data-icon="search" />,
}));

describe('DataGridColumnTitle', () => {
  it('marks v2 table headers as single-line when column type and comment rows are hidden', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="id"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
      />,
    );

    expect(markup).toContain('data-grid-column-title-single-line="true"');
    expect(markup).not.toContain('gn-v2-column-title-type');
    expect(markup).not.toContain('gn-v2-column-title-comment');
  });

  it('renders column type and comment rows when enabled', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="id"
        columnMeta={{ type: 'bigint', comment: '主键 ID' }}
        showColumnType
        showColumnComment
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
      />,
    );

    expect(markup).toContain('class="gn-v2-column-title"');
    expect(markup).toContain('class="gn-v2-column-title-type"');
    expect(markup).toContain('bigint');
    expect(markup).toContain('class="gn-v2-column-title-comment"');
    expect(markup).toContain('主键 ID');
    expect(markup).toContain('flex-direction:column');
    expect(markup).toContain('align-items:flex-start');
    expect(markup).toContain('display:inline-flex;width:100%;max-width:100%;min-width:0;overflow:hidden');
  });

  it('keeps column metadata tooltip readable in light theme', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="auth_type"
        columnMeta={{ type: 'tinyint(4)', comment: '认证类型：1企业，2个人' }}
        showColumnType
        showColumnComment
        metaFontSize={11}
        columnMetaHintColor="#595959"
        columnMetaTooltipColor="#262626"
        darkMode={false}
      />,
    );

    expect(markup).toContain('data-tooltip-root-class="gn-data-grid-column-meta-tooltip"');
    expect(markup).toContain('class="gn-data-grid-column-meta-tooltip-content"');
    expect(markup).toContain('color:var(--gn-fg-1, #fff)');
    expect(markup).not.toContain('color:#fff');
  });

  it('keeps the configured warm metadata tooltip color in dark theme', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="auth_type"
        columnMeta={{ type: 'tinyint(4)', comment: '认证类型：1企业，2个人' }}
        showColumnType
        showColumnComment
        metaFontSize={11}
        columnMetaHintColor="rgba(255, 236, 179, 0.98)"
        columnMetaTooltipColor="rgba(255, 236, 179, 0.98)"
        darkMode
      />,
    );

    expect(markup).toContain('color:rgba(255, 236, 179, 0.98)');
  });

  it('renders foreign-key jump affordance when reference target exists', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="customer_id"
        foreignKeyTarget={{ refTableName: 'customers', refColumnName: 'id' }}
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
      />,
    );

    expect(markup).toContain('data-grid-fk-jump="true"');
    expect(markup).toContain('data-ref-table-name="customers"');
  });

  it('renders a compact column filter trigger with active state', () => {
    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="status"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        columnFilter={{
          active: true,
          operatorOptions: [
            { value: '=', label: '=' },
            { value: 'CONTAINS', label: 'Contains' },
          ],
          defaultOperator: 'CONTAINS',
          initialOperator: '=',
          initialValue: 'active',
          filterLabel: 'Filter',
          applyLabel: 'Apply',
          clearLabel: 'Clear',
          valuePlaceholder: 'Value',
          secondValuePlaceholder: 'End value',
          listValuePlaceholder: 'List values',
          noValuePlaceholder: 'No value needed',
          isNoValueOp: () => false,
          isBetweenOp: () => false,
          isListOp: () => false,
          onApply: () => true,
          onClear: () => true,
        }}
      />,
    );

    expect(markup).toContain('class="gn-v2-column-title-shell"');
    expect(markup).toContain('data-grid-column-filter-trigger="true"');
    expect(markup).toContain('data-grid-column-filter-active="true"');
    expect(markup).toContain('data-grid-column-filter-popover="true"');
    expect(markup).toContain('flex:1 1 auto');
    expect(markup).toContain('display:inline-flex;flex:1 1 auto;max-width:100%;min-width:0;overflow:hidden');
    expect(markup).toContain('width:100%');
    expect(markup).toContain('Filter status');
    expect(markup).toContain('value="active"');
  });

  it('isolates pointer interactions inside the filter popover from column dragging', () => {
    const renderer = create(
      <DataGridColumnTitle
        columnName="status"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        columnFilter={{
          active: false,
          operatorOptions: [{ value: '=', label: '=' }],
          defaultOperator: '=',
          filterLabel: 'Filter',
          applyLabel: 'Apply',
          clearLabel: 'Clear',
          valuePlaceholder: 'Value',
          secondValuePlaceholder: 'End value',
          listValuePlaceholder: 'List values',
          noValuePlaceholder: 'No value needed',
          isNoValueOp: () => false,
          isBetweenOp: () => false,
          isListOp: () => false,
          onApply: () => true,
          onClear: () => true,
        }}
      />,
    );

    const filterPopover = renderer.root.findByProps({ 'data-grid-column-filter-popover': 'true' });
    const stopPropagation = vi.fn();
    act(() => {
      filterPopover.props.onMouseDown({ stopPropagation });
      filterPopover.props.onPointerDown({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('applies the column filter from the popover action button', () => {
    const onApply = vi.fn(() => true);
    const renderer = create(
      <DataGridColumnTitle
        columnName="code"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        columnFilter={{
          active: false,
          operatorOptions: [
            { value: 'CONTAINS', label: 'Contains' },
          ],
          defaultOperator: 'CONTAINS',
          initialOperator: 'CONTAINS',
          initialValue: '3551',
          filterLabel: 'Filter',
          applyLabel: 'Apply',
          clearLabel: 'Clear',
          valuePlaceholder: 'Value',
          secondValuePlaceholder: 'End value',
          listValuePlaceholder: 'List values',
          noValuePlaceholder: 'No value needed',
          isNoValueOp: () => false,
          isBetweenOp: () => false,
          isListOp: () => false,
          onApply,
          onClear: () => true,
        }}
      />,
    );

    const applyButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Apply'));

    expect(applyButton).toBeTruthy();
    act(() => {
      applyButton!.props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    expect(onApply).toHaveBeenCalledWith({
      op: 'CONTAINS',
      value: '3551',
      value2: '',
    });
  });

  it('keeps column filter operator switching and clearing interactive', () => {
    const onApply = vi.fn(() => true);
    const onClear = vi.fn(() => true);
    const renderer = create(
      <DataGridColumnTitle
        columnName="title"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        columnFilter={{
          active: true,
          operatorOptions: [
            { value: '=', label: '=' },
            { value: 'CONTAINS', label: 'Contains' },
          ],
          defaultOperator: 'CONTAINS',
          initialOperator: 'CONTAINS',
          initialValue: '3551',
          filterLabel: 'Filter',
          applyLabel: 'Apply',
          clearLabel: 'Clear',
          valuePlaceholder: 'Value',
          secondValuePlaceholder: 'End value',
          listValuePlaceholder: 'List values',
          noValuePlaceholder: 'No value needed',
          isNoValueOp: () => false,
          isBetweenOp: () => false,
          isListOp: () => false,
          onApply,
          onClear,
        }}
      />,
    );

    const operatorSelect = renderer.root.findByType('select');
    act(() => {
      operatorSelect.props.onChange({ target: { value: '=' } });
    });

    const buttons = renderer.root.findAllByType('button');
    const clearButton = buttons.find((button) => button.children.includes('Clear'));
    const applyButton = buttons.find((button) => button.children.includes('Apply'));

    expect(clearButton).toBeTruthy();
    expect(applyButton).toBeTruthy();

    act(() => {
      applyButton!.props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    expect(onApply).toHaveBeenLastCalledWith({
      op: '=',
      value: '3551',
      value2: '',
    });

    act(() => {
      clearButton!.props.onClick();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('searches and multi-selects current values before explicit apply', () => {
    const onApply = vi.fn(() => true);
    const translate = (key: string) => ({
      'data_grid.filter.value_counts.title': 'Current values',
      'data_grid.filter.value_counts.search_placeholder': 'Search values',
      'data_grid.filter.value_counts.nullish': '(Null)',
      'data_grid.filter.value_counts.empty': '(Empty)',
      'data_grid.filter.value_counts.no_matches': 'No matches',
      'data_grid.filter.value_counts.value': 'Value',
      'data_grid.filter.value_counts.count': 'Count',
    }[key] || key);
    const renderer = create(
      <DataGridColumnTitle
        columnName="status"
        showColumnType={false}
        showColumnComment={false}
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        translate={translate}
        currentValueCounts={[
          { key: 'string:active', display: 'active', kind: 'value', count: 3 },
          { key: 'nullish', display: '', kind: 'nullish', count: 2 },
          { key: 'empty', display: '', kind: 'empty', count: 1 },
        ]}
        columnFilter={{
          active: false,
          operatorOptions: [
            { value: '=', label: '=' },
            { value: 'IS_NULL', label: 'Is null' },
            { value: 'IS_EMPTY', label: 'Is empty' },
          ],
          defaultOperator: '=',
          filterLabel: 'Filter',
          applyLabel: 'Apply',
          clearLabel: 'Clear',
          valuePlaceholder: 'Value',
          secondValuePlaceholder: 'End value',
          listValuePlaceholder: 'List values',
          noValuePlaceholder: 'No value needed',
          isNoValueOp: (op) => op === 'IS_NULL' || op === 'IS_EMPTY',
          isBetweenOp: () => false,
          isListOp: () => false,
          onApply,
          onClear: () => true,
        }}
      />,
    );

    const valueCountTable = () => renderer.root.findByProps({ 'data-value-count-table': 'true' });
    expect(valueCountTable().props['data-count-sort-order']).toBe('descend');
    act(() => valueCountTable().props.onClick());
    expect(valueCountTable().props['data-count-sort-order']).toBe('ascend');

    const searchInput = renderer.root.findAllByType('input')
      .find((input) => input.props.placeholder === 'Search values');
    expect(searchInput).toBeTruthy();
    act(() => searchInput!.props.onChange({ target: { value: 'act' } }));
    expect(renderer.root.findAllByType('label')
      .filter((node) => node.props['data-grid-column-value-count-kind'])
      .map((node) => node.props.title)).toEqual(['active']);

    const toggleValueCount = (kind: string) => {
      const checkbox = renderer.root.findAllByType('label')
        .filter((node) => node.props['data-grid-column-value-count-kind'] === kind);
      expect(checkbox).toHaveLength(1);
      const input = checkbox[0].findByType('input');
      act(() => input.props.onChange());
    };
    const apply = () => {
      const button = renderer.root.findAllByType('button').find((node) => node.children.includes('Apply'));
      act(() => button!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    };

    toggleValueCount('value');
    expect(onApply).not.toHaveBeenCalled();
    apply();
    expect(onApply).toHaveBeenLastCalledWith({
      op: 'IN',
      value: '',
      value2: '',
      valueSelection: { values: ['active'] },
    });

    act(() => searchInput!.props.onChange({ target: { value: '' } }));
    toggleValueCount('nullish');
    expect(onApply).toHaveBeenCalledTimes(1);
    apply();
    expect(onApply).toHaveBeenLastCalledWith({
      op: 'IN',
      value: '',
      value2: '',
      valueSelection: { values: ['active'], includeNull: true },
    });
  });

  it('uses translated tooltip wrappers while preserving raw metadata values', () => {
    const translate = vi.fn((key: string, params?: Record<string, unknown>) => {
      if (key === 'data_grid.column.type_tooltip') return `TYPE ${String(params?.type)}`;
      if (key === 'data_grid.column.comment_tooltip') return `COMMENT ${String(params?.comment)}`;
      if (key === 'data_grid.column.foreign_key_tooltip') return `FK ${String(params?.target)}`;
      if (key === 'data_grid.column.foreign_key_jump_title') return `JUMP ${String(params?.tableName)}`;
      return key;
    });

    const markup = renderToStaticMarkup(
      <DataGridColumnTitle
        columnName="account_id"
        columnMeta={{ type: 'uuid', comment: '账户编号' }}
        foreignKeyTarget={{ refTableName: 'public.users', refColumnName: 'id' }}
        showColumnType
        showColumnComment
        metaFontSize={11}
        columnMetaHintColor="#999"
        columnMetaTooltipColor="#fff"
        darkMode={false}
        translate={translate}
      />,
    );

    expect(markup).toContain('TYPE uuid');
    expect(markup).toContain('COMMENT 账户编号');
    expect(markup).toContain('FK public.users.id');
    expect(markup).toContain('title="JUMP public.users"');
    expect(markup).not.toContain('类型：uuid');
    expect(markup).not.toContain('备注：账户编号');
    expect(markup).not.toContain('外键：public.users.id');
    expect(markup).not.toContain('跳转到外键表：public.users');

    expect(translate).toHaveBeenCalledWith('data_grid.column.type_tooltip', { type: 'uuid' });
    expect(translate).toHaveBeenCalledWith('data_grid.column.comment_tooltip', { comment: '账户编号' });
    expect(translate).toHaveBeenCalledWith('data_grid.column.foreign_key_tooltip', { target: 'public.users.id' });
    expect(translate).toHaveBeenCalledWith('data_grid.column.foreign_key_jump_title', { tableName: 'public.users' });
  });
});
