import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import DatabaseSchemaVisibilityModal from './DatabaseSchemaVisibilityModal';

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../common/ResizableDraggableModal', () => ({
  default: ({ children, ...props }: any) => (
    <section data-component="modal" {...props}>{children}</section>
  ),
}));

vi.mock('@ant-design/icons', () => ({
  DatabaseOutlined: () => <span data-icon="database" />,
  FolderOpenOutlined: () => <span data-icon="folder-open" />,
  ReloadOutlined: () => <span data-icon="reload" />,
  SearchOutlined: () => <span data-icon="search" />,
}));

vi.mock('antd', () => {
  const Space: any = ({ children }: any) => <div data-component="space">{children}</div>;
  Space.Compact = ({ children }: any) => <div data-component="space-compact">{children}</div>;

  const Input: any = (props: any) => <input {...props} />;
  Input.TextArea = (props: any) => <textarea {...props} />;

  const Tree = ({ treeData, ...props }: any) => (
    <div data-component="tree" {...props}>
      {(treeData || []).map((node: any) => (
        <div data-component="tree-node" key={String(node.key)}>
          {node.title}
          {(node.children || []).map((child: any) => (
            <div data-component="tree-node" key={String(child.key)}>{child.title}</div>
          ))}
        </div>
      ))}
    </div>
  );

  return {
    Alert: ({ children, ...props }: any) => <div data-component="alert" {...props}>{children}</div>,
    Button: ({ children, ...props }: any) => <button type="button" {...props}>{children}</button>,
    Checkbox: ({ children, ...props }: any) => (
      <label data-component="checkbox" {...props}>{children}</label>
    ),
    Empty: ({ description }: any) => <div data-component="empty">{description}</div>,
    Input,
    Space,
    Spin: () => <span data-component="spin" />,
    Tag: ({ children }: any) => <span data-component="tag">{children}</span>,
    Tree,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
      Title: ({ children }: any) => <h3>{children}</h3>,
    },
    message: {
      error: vi.fn(),
      warning: vi.fn(),
    },
  };
});

const textContent = (node: ReactTestInstance): string => node.children.map((child) => (
  typeof child === 'string' ? child : textContent(child)
)).join('');

const findCheckbox = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
  const checkbox = renderer.root.findAllByProps({ 'data-component': 'checkbox' }).find(
    (candidate) => textContent(candidate).trim() === label,
  );
  if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
  return checkbox;
};

describe('DatabaseSchemaVisibilityModal', () => {
  it('allows selecting one schema directly after clearing every database', async () => {
    const onSave = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <DatabaseSchemaVisibilityModal
          open
          connectionName="SQL Server"
          source={{}}
          initialDatabase="app"
          primaryLabel="database"
          supportsSchemas
          databaseCaseSensitive={false}
          schemaCaseSensitive={false}
          loadDatabases={async () => ['app', 'audit']}
          loadSchemas={async () => ({
            supported: true,
            schemas: ['dbo', 'reporting'],
          })}
          onCancel={vi.fn()}
          onSave={onSave}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const clearButton = renderer.root.findAllByType('button').find(
      (button) => textContent(button) === 'sidebar.database_schema_visibility.action.clear',
    );
    expect(clearButton).toBeDefined();

    await act(async () => {
      clearButton!.props.onClick();
    });

    expect(findCheckbox(renderer, 'dbo').props.disabled).not.toBe(true);
    expect(findCheckbox(renderer, 'dbo').props.checked).toBe(false);
    expect(findCheckbox(renderer, 'reporting').props.checked).toBe(false);

    await act(async () => {
      findCheckbox(renderer, 'dbo').props.onChange({ target: { checked: true } });
    });

    expect(findCheckbox(renderer, 'app').props.indeterminate).toBe(true);
    expect(findCheckbox(renderer, 'dbo').props.checked).toBe(true);
    expect(findCheckbox(renderer, 'reporting').props.checked).toBe(false);

    await act(async () => {
      await renderer.root.findByProps({ 'data-component': 'modal' }).props.onOk();
    });

    expect(onSave).toHaveBeenCalledWith({
      includeDatabases: ['app'],
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      schemaVisibilityByDatabase: {
        app: { mode: 'include', schemas: ['dbo'] },
      },
    });
  });

  it('starts a lazily loaded database from the schema clicked after clearing', async () => {
    const onSave = vi.fn();
    const loadSchemas = vi.fn(async () => ({
      supported: true,
      schemas: ['dbo', 'reporting'],
    }));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <DatabaseSchemaVisibilityModal
          open
          connectionName="SQL Server"
          source={{}}
          primaryLabel="database"
          supportsSchemas
          databaseCaseSensitive={false}
          schemaCaseSensitive={false}
          loadDatabases={async () => ['app', 'audit']}
          loadSchemas={loadSchemas}
          onCancel={vi.fn()}
          onSave={onSave}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const clearButton = renderer.root.findAllByType('button').find(
      (button) => textContent(button) === 'sidebar.database_schema_visibility.action.clear',
    );
    await act(async () => {
      clearButton!.props.onClick();
      renderer.root.findByProps({ 'data-component': 'tree' }).props.onExpand(
        ['database:app'],
        { expanded: true, node: { key: 'database:app' } },
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadSchemas).toHaveBeenCalledWith('app');
    expect(findCheckbox(renderer, 'dbo').props.checked).toBe(false);
    expect(findCheckbox(renderer, 'reporting').props.checked).toBe(false);

    await act(async () => {
      findCheckbox(renderer, 'reporting').props.onChange({ target: { checked: true } });
    });

    await act(async () => {
      await renderer.root.findByProps({ 'data-component': 'modal' }).props.onOk();
    });

    expect(onSave).toHaveBeenCalledWith({
      includeDatabases: ['app'],
      includeDatabasePatterns: [],
      excludeDatabasePatterns: [],
      schemaVisibilityByDatabase: {
        app: { mode: 'include', schemas: ['reporting'] },
      },
    });
  });
});
