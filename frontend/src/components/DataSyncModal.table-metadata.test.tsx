import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DataSyncModal from './DataSyncModal';

const mocks = vi.hoisted(() => ({
  dbGetDatabases: vi.fn(),
  dbGetTables: vi.fn(),
  dataSyncCapability: vi.fn(),
  message: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  transfer: vi.fn(),
  storeState: {
    connections: [
      {
        id: 'source',
        name: 'Source Redis',
        config: { type: 'redis', host: 'source.local', port: 6379, database: '0' },
      },
      {
        id: 'target',
        name: 'Target Redis',
        config: { type: 'redis', host: 'target.local', port: 6379, database: '0' },
      },
    ],
    theme: 'light',
    appearance: {},
  },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetTables: mocks.dbGetTables,
  DataSync: vi.fn(),
  DataSyncAnalyze: vi.fn(),
  DataSyncCapability: mocks.dataSyncCapability,
  DataSyncPreview: vi.fn(),
}));

vi.mock('../../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => undefined),
}));

vi.mock('./dataSyncBackgroundTask', () => ({
  useDataSyncBackgroundTask: () => ({
    taskKey: '',
    jobId: '',
    status: 'idle',
    startedAt: 0,
    finishedAt: 0,
    progress: { percent: 0, current: 0, total: 0, table: '', stage: '' },
    logs: [],
    result: null,
  }),
  startDataSyncBackgroundTask: vi.fn(),
  finishDataSyncBackgroundTask: vi.fn(),
  failDataSyncBackgroundTask: vi.fn(),
  resolveDataSyncTaskLogLevel: vi.fn(() => 'info'),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Form = Object.assign(
    ({ children }: { children?: React.ReactNode }) => React.createElement('form', null, children),
    { Item: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children) },
  );
  const Select = Object.assign(
    ({ children, value, onChange, disabled }: any) => React.createElement(
      'select',
      {
        value: value ?? '',
        disabled,
        onChange: (event: any) => onChange?.(event.target.value),
      },
      children,
    ),
    {
      Option: ({ children, value, disabled }: any) => React.createElement(
        'option',
        { value, disabled },
        children,
      ),
    },
  );
  const Input = Object.assign(
    ({ value, onChange, placeholder }: any) => React.createElement('input', { value, onChange, placeholder }),
    { TextArea: ({ value, onChange }: any) => React.createElement('textarea', { value, onChange }) },
  );
  const Steps = Object.assign(
    ({ current, children }: any) => React.createElement('div', { 'data-testid': 'steps', 'data-current': current }, children),
    { Step: () => null },
  );
  const Typography = {
    Title: ({ children }: { children?: React.ReactNode }) => React.createElement('h2', null, children),
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  };
  const modalRef = () => ({ update: vi.fn() });
  const Modal = Object.assign(
    ({ children, open }: any) => (open ? React.createElement('div', null, children) : null),
    {
      info: modalRef,
      success: modalRef,
      error: modalRef,
      warning: modalRef,
      confirm: modalRef,
      destroyAll: vi.fn(),
      useModal: () => [{ info: modalRef, success: modalRef, error: modalRef, warning: modalRef, confirm: modalRef }, null],
    },
  );

  return {
    Form,
    Select,
    Input,
    Button: ({ children, disabled, loading, onClick }: any) => React.createElement(
      'button',
      { disabled: Boolean(disabled || loading), onClick },
      children,
    ),
    Steps,
    Transfer: (props: any) => {
      mocks.transfer(props);
      return React.createElement('div', { 'data-testid': 'transfer' });
    },
    Card: ({ children, title }: any) => React.createElement('section', null, title, children),
    Alert: ({ message: alertMessage, description }: any) => React.createElement('div', null, alertMessage, description),
    Divider: ({ children }: any) => React.createElement('div', null, children),
    Typography,
    Progress: () => React.createElement('div'),
    Checkbox: ({ children, checked, disabled, onChange }: any) => React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked,
        disabled,
        onChange,
      }),
      children,
    ),
    Table: () => React.createElement('div'),
    Drawer: ({ children, open }: any) => (open ? React.createElement('aside', null, children) : null),
    Tabs: () => React.createElement('div'),
    Modal,
    theme: { useToken: () => ({ token: { colorPrimary: '#1677ff' } }) },
    message: mocks.message,
  };
});

vi.mock('@ant-design/icons', () => ({
  DatabaseOutlined: () => null,
  RocketOutlined: () => null,
  SwapOutlined: () => null,
  TableOutlined: () => null,
}));

const textContent = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.children || []);
};

describe('DataSyncModal table metadata completeness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbGetDatabases.mockResolvedValue({ success: true, data: [{ Database: '0' }] });
    mocks.dataSyncCapability.mockResolvedValue({
      sourceType: 'redis',
      targetType: 'redis',
      planner: 'redis',
      canExecute: true,
      supportsAutoCreate: false,
      supportsAutoAddColumns: false,
      requiresExistingTarget: true,
      supportLevel: 'full',
    });
  });

  it('warns and remains on configuration when table metadata is truncated', async () => {
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      partial: true,
      truncated: true,
      message: 'Redis key scan truncated after 2 keys: cursor loop detected',
      data: [{ Table: 'orders' }, { Table: 'users' }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DataSyncModal open embedded onClose={vi.fn()} />);
      await Promise.resolve();
    });

    const [sourceConnection, targetConnection] = renderer.root.findAllByType('select');
    await act(async () => {
      sourceConnection.props.onChange({ target: { value: 'source' } });
      await Promise.resolve();
      targetConnection.props.onChange({ target: { value: 'target' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    const nextButton = renderer.root
      .findAllByType('button')
      .find((button) => textContent(button).trim() === 'Next');
    expect(nextButton).toBeTruthy();
    expect(nextButton?.props.disabled).toBe(false);

    await act(async () => {
      nextButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbGetTables).toHaveBeenCalledTimes(1);
    expect(mocks.message.warning).toHaveBeenCalledWith(
      expect.stringContaining('Redis key scan truncated after 2 keys: cursor loop detected'),
    );
    expect(renderer.root.findByProps({ 'data-testid': 'steps' }).props['data-current']).toBe(0);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
