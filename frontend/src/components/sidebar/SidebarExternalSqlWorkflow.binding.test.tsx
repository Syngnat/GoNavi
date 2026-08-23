import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';

import { ExternalSQLBindingModal } from './SidebarExternalSqlWorkflow';

vi.mock('antd', () => {
  const Form: any = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, name, rules }: any) => (
    <section
      data-form-item={String(name || '')}
      data-required={rules?.some((rule: { required?: boolean }) => rule.required === true) ? 'yes' : 'no'}
    >
      {children}
    </section>
  );
  const Button = ({ children, ...props }: any) => <button type="button" {...props}>{children}</button>;
  const Input: any = (props: any) => <input {...props} />;
  const Progress = () => null;
  const Select = ({ allowClear, options, ...props }: any) => (
    <select data-allow-clear={allowClear === true ? 'yes' : 'no'} {...props}>
      {(options || []).map((option: { value: string; label: string }) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
  return {
    Button,
    Form,
    Input,
    Progress,
    Select,
    message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});

vi.mock('../common/ResizableDraggableModal', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

describe('ExternalSQLBindingModal', () => {
  it('allows a file binding to keep its connection while clearing the database', async () => {
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <ExternalSQLBindingModal
          open
          form={{ getFieldValue: (name: string) => name === 'connectionId' ? 'mysql-1' : undefined } as any}
          connections={[{
            id: 'mysql-1',
            name: 'MySQL',
            config: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root' },
          }]}
          filePath="D:/sql/bootstrap/create-database.sql"
          databaseOptions={['orders']}
          loadingDatabases={false}
          databaseLoadError=""
          hasExplicitBinding={false}
          saving={false}
          onConnectionChange={() => undefined}
          onClearBinding={() => undefined}
          onOk={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });

    const databaseField = renderer!.root.findByProps({ 'data-form-item': 'dbName' });
    expect(databaseField.props['data-required']).toBe('no');
    expect(databaseField.findByType('select').props['data-allow-clear']).toBe('yes');
  });
});
