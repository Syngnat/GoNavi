import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ImportTableCreateModal } from './ImportTableCreateModal';
import type { ImportTableSchemaInference } from './importTableTypeMapping';

vi.mock('../common/ResizableDraggableModal', () => ({
  default: ({
    open,
    title,
    children,
    footer,
    className,
  }: {
    open?: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    className?: string;
  }) => (open ? React.createElement(
    'section',
    { 'data-modal-class-name': className },
    title,
    children,
    footer,
  ) : null),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Button = ({ children, ...props }: any) => React.createElement('button', props, children);
  const Input = ({ value, onChange, ...props }: any) => React.createElement(
    'input',
    {
      ...props,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(event),
    },
  );
  const AutoComplete = ({ value, onChange, options: _options, ...props }: any) => React.createElement(
    'input',
    {
      ...props,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value),
    },
  );
  const Switch = ({ checked, onChange, ...props }: any) => React.createElement(
    'button',
    {
      ...props,
      'data-checked': checked,
      onClick: () => onChange?.(!checked),
    },
  );
  const Checkbox = ({ checked, onChange, ...props }: any) => React.createElement(
    'input',
    {
      ...props,
      type: 'checkbox',
      checked,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(event),
    },
  );
  const Alert = ({ message, description, ...props }: any) => React.createElement(
    'div',
    props,
    message,
    description,
  );
  const InputNumber = ({ value, onChange, ...props }: any) => React.createElement('input', {
    ...props,
    type: 'number',
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(Number(event.target.value)),
  });
  const Space = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { Alert, AutoComplete, Button, Checkbox, Input, InputNumber, Space, Switch };
});

const t = (key: string, params?: Record<string, unknown>) => (
  params ? `${key} ${JSON.stringify(params)}` : key
);

const inference: ImportTableSchemaInference = {
  tableName: 'imported_data',
  columns: [
    {
      name: 'amount',
      sourceName: 'Amount USD',
      logicalType: 'decimal',
      nullable: true,
      precision: 12,
      scale: 2,
    },
    {
      name: 'created_at',
      sourceName: 'created_at',
      logicalType: 'datetime',
      nullable: true,
    },
  ],
  warnings: ['Column "Amount USD" was renamed to "amount"'],
  sampledRows: 120,
  sampleLimit: 500,
};

const renderModal = async (
  overrides: Partial<React.ComponentProps<typeof ImportTableCreateModal>> = {},
) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ImportTableCreateModal
        open
        inference={inference}
        dialect="mysql"
        fileName="sales.xlsx"
        t={t}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...overrides}
      />,
    );
  });
  return { renderer, onConfirm, onCancel };
};

const textContent = (node: unknown): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  const record = node as { children?: unknown[] };
  return textContent(record.children || []);
};

describe('ImportTableCreateModal', () => {
  it('uses a scrollable body for long column lists', async () => {
    const { renderer } = await renderModal();
    expect(renderer.root.findByType('section').props['data-modal-class-name'])
      .toBe('gn-import-table-create-modal');

    const css = readFileSync(new URL('./ImportTableCreateModal.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.ant-modal\.gn-import-table-create-modal \.ant-modal-body \{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it('renders inferred columns, edits types, forces PK columns to NOT NULL and confirms SQL', async () => {
    const { renderer, onConfirm } = await renderModal();

    expect(textContent(renderer.toJSON())).toContain(
      'Column "Amount USD" was renamed to "amount"',
    );
    expect(renderer.root.findByProps({
      'data-import-create-table-table-name': 'true',
    }).props.value).toBe('imported_data');
    expect(renderer.root.findByProps({
      title: 'Amount USD',
    }).props.value).toBe('amount');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-column-type': 'amount',
      }).props.onChange('decimal(12,2)');
    });
    expect(renderer.root.findByProps({
      'data-import-create-table-sql': 'true',
    }).children.join('')).toContain('`amount` decimal(12,2)');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-column-primary-key': 'amount',
      }).props.onChange({ target: { checked: true } });
    });
    const nullableSwitch = renderer.root.findByProps({
      'data-import-create-table-column-nullable': 'amount',
    });
    expect(nullableSwitch.props.disabled).toBe(true);
    expect(nullableSwitch.props.checked).toBe(false);

    const sql = renderer.root.findByProps({
      'data-import-create-table-sql': 'true',
    }).children.join('');
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('PRIMARY KEY (`amount`)');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-confirm': 'true',
      }).props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledWith({
      tableName: 'imported_data',
      sql: expect.stringContaining('CREATE TABLE'),
      columns: ['amount', 'created_at'],
      columnMappings: { 'Amount USD': 'amount', created_at: 'created_at' },
    });
  });

  it('allows editing column names and blocks duplicate names', async () => {
    const { renderer, onConfirm } = await renderModal();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-column-name': 'Amount USD',
      }).props.onChange({ target: { value: 'total_amount' } });
    });
    expect(renderer.root.findByProps({
      'data-import-create-table-sql': 'true',
    }).children.join('')).toContain('`total_amount`');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-column-name': 'created_at',
      }).props.onChange({ target: { value: 'TOTAL_AMOUNT' } });
    });
    expect(renderer.root.findByProps({
      'data-import-create-table-confirm': 'true',
    }).props.disabled).toBe(true);

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-column-name': 'created_at',
      }).props.onChange({ target: { value: 'created_at' } });
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-confirm': 'true',
      }).props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      columns: ['total_amount', 'created_at'],
      columnMappings: { 'Amount USD': 'total_amount', created_at: 'created_at' },
    }));
  });

  it('uses parsed header types/comments and applies separate metadata rows', async () => {
    const onApplyRows = vi.fn();
    const { renderer } = await renderModal({
      onApplyRows,
      inference: {
        ...inference,
        columns: [
          {
            name: 'name',
            sourceName: '姓名 varchar(50) 客户姓名',
            logicalType: 'text',
            declaredType: 'varchar(50)',
            comment: '客户姓名',
            nullable: true,
          },
        ],
        warnings: [],
      },
    });

    expect(renderer.root.findByProps({
      'data-import-create-table-column-type': 'name',
    }).props.value).toBe('varchar(50)');
    expect(renderer.root.findByProps({
      'data-import-create-table-column-comment': 'name',
    }).props.value).toBe('客户姓名');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-type-row': 'true',
      }).props.onChange(2);
      renderer.root.findByProps({
        'data-import-create-table-comment-row': 'true',
      }).props.onChange(3);
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-create-table-apply-rows': 'true',
      }).props.onClick();
    });
    expect(onApplyRows).toHaveBeenCalledWith(2, 3);
  });

  it('disables confirmation when TDengine has no date or datetime column', async () => {
    const { renderer } = await renderModal({
      dialect: 'tdengine',
      inference: {
        ...inference,
        columns: [
          {
            name: 'value',
            sourceName: 'value',
            logicalType: 'integer',
            nullable: true,
          },
        ],
        warnings: [],
      },
    });

    expect(renderer.root.findByProps({
      'data-import-create-table-time-index-error': 'true',
    })).toBeDefined();
    expect(renderer.root.findByProps({
      'data-import-create-table-confirm': 'true',
    }).props.disabled).toBe(true);
  });
});
