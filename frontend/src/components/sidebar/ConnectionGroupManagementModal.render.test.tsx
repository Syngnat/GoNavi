import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Modal from '../common/ResizableDraggableModal';

const storeState = vi.hoisted(() => ({
  connections: [{
    id: 'connection-1',
    name: 'Primary database',
    createdAt: 1_700_000_000_000,
    config: { host: '127.0.0.1', port: 3306 },
  }],
  connectionTags: [{
    id: 'group-1',
    name: 'Production',
    connectionIds: ['connection-1'],
    connectionSortMode: 'name',
  }],
  sidebarRootOrder: ['tag:group-1'],
  rootConnectionSortMode: 'name',
  setConnectionDisplaySortMode: vi.fn(),
  updateConnectionTag: vi.fn(),
  removeConnectionTagTree: vi.fn(),
  removeConnection: vi.fn(),
  moveConnectionsToTag: vi.fn(),
  moveConnectionTag: vi.fn(),
}));
const messageMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
  buildSidebarRootTagToken: (id: string) => `tag:${id}`,
  resolveConnectionTagChildOrder: () => [],
  resolveSidebarRootOrderTokens: () => ['tag:group-1'],
}));

vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const Icon = (props: Record<string, unknown>) => ReactModule.createElement('i', props);
  return {
    CloseOutlined: Icon,
    DeleteOutlined: Icon,
    EditOutlined: Icon,
    FolderAddOutlined: Icon,
    InboxOutlined: Icon,
    PlusOutlined: Icon,
    SettingOutlined: Icon,
    SortAscendingOutlined: Icon,
  };
});

vi.mock('../common/ResizableDraggableModal', async () => {
  const ReactModule = await import('react');
  const Modal = ({ open, children, title, zIndex, rootClassName, closeIcon }: any) => open
    ? ReactModule.createElement('div', { 'data-modal': true, 'data-z-index': zIndex, className: rootClassName }, title, closeIcon, children)
    : null;
  Modal.confirm = vi.fn();
  return { default: Modal };
});

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) => ReactModule.createElement(tag, props, children);
  const Button = ({ children, icon, ...props }: any) => ReactModule.createElement('button', props, icon, children);
  const Empty = ({ description }: any) => ReactModule.createElement('div', { 'data-empty': true }, description);
  (Empty as any).PRESENTED_IMAGE_SIMPLE = 'simple';
  const Form: any = passthrough('form');
  Form.Item = passthrough('label');
  Form.useForm = () => [{
    setFieldsValue: vi.fn(),
    validateFields: vi.fn(),
    setFields: vi.fn(),
  }];
  const Input = passthrough('input');
  const List: any = ({ dataSource = [], renderItem }: any) => ReactModule.createElement('div', null, dataSource.map(renderItem));
  List.Item = passthrough('div');
  const Select = (props: any) => ReactModule.createElement('select', props);
  const Space: any = passthrough('div');
  Space.Compact = passthrough('div');
  const Table = ({ dataSource = [], columns = [], rowSelection, onRow }: any) => ReactModule.createElement(
    'div',
    { 'data-table': true },
    ReactModule.createElement('button', {
      'data-select-visible': true,
      onClick: () => rowSelection?.onChange(dataSource.map((row: any) => row.id)),
    }),
    ReactModule.createElement('button', {
      'data-clear-visible': true,
      onClick: () => rowSelection?.onChange([]),
    }),
    dataSource.map((row: any, rowIndex: number) => ReactModule.createElement(
      'div',
      { key: row.id, 'data-connection-row': row.id, ...(onRow?.(row) || {}) },
      columns.map((column: any, columnIndex: number) => ReactModule.createElement(
        'span',
        { key: column.key || columnIndex },
        typeof column.render === 'function'
          ? column.render(column.dataIndex ? row[column.dataIndex] : undefined, row, rowIndex)
          : row[column.dataIndex],
      )),
    )),
  );
  const Tag = passthrough('span');
  const Tooltip = ({ title, children }: any) => ReactModule.createElement('span', { 'data-tooltip': title }, children);
  const Tree = ({ treeData = [], onSelect }: any) => ReactModule.createElement(
    'div',
    { 'data-tree': true },
    treeData.map((node: any) => ReactModule.createElement('button', {
      key: node.key,
      'data-tree-key': node.key,
      onClick: () => onSelect?.([node.key]),
    }, node.title)),
  );
  const Typography = {
    Paragraph: passthrough('p'),
    Text: passthrough('span'),
    Title: passthrough('h2'),
  };
  return { Button, Empty, Form, Input, List, Select, Space, Table, Tag, Tooltip, Tree, Typography, message: messageMock };
});

import { setCurrentLanguage } from '../../i18n';
import ConnectionGroupManagementModal from './ConnectionGroupManagementModal';

class FakeHTMLElement {
  constructor(private readonly interactive: boolean) {}

  closest() {
    return this.interactive ? {} : null;
  }
}

const findByData = (root: ReactTestInstance, name: string, value: unknown = true) => (
  root.find((node) => node.props?.[`data-${name}`] === value)
);

describe('ConnectionGroupManagementModal rendering', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    setCurrentLanguage('zh-CN');
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    const listeners = new Map<string, Set<EventListener>>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: EventListener) => {
        const current = listeners.get(type) || new Set<EventListener>();
        current.add(listener);
        listeners.set(type, current);
      },
      removeEventListener: (type: string, listener: EventListener) => listeners.get(type)?.delete(listener),
      dispatchEvent: (event: Event) => {
        listeners.get(event.type)?.forEach((listener) => listener(event));
        return true;
      },
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    storeState.connectionTags[0].connectionIds = ['connection-1'];
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const renderModal = (onCloseTabsByConnection: ReturnType<typeof vi.fn> = vi.fn()) => {
    act(() => {
      renderer = create(<ConnectionGroupManagementModal
        open
        onClose={vi.fn()}
        onOpenTagForm={vi.fn()}
        onCreateConnectionInGroup={vi.fn()}
        onEditConnection={vi.fn()}
        onCloseTabsByConnection={onCloseTabsByConnection}
        onConnectionGroupDeleted={vi.fn().mockResolvedValue(undefined)}
      />);
    });
    return renderer!.root;
  };

  const selectGroup = (root: ReactTestInstance) => {
    const group = root.find((node) => node.props?.['data-tree-key'] === 'group-1');
    act(() => group.props.onClick());
  };

  it('uses localized tooltips for every management action', () => {
    const root = renderModal();
    selectGroup(root);

    const tooltips = root.findAll((node) => typeof node.props?.['data-tooltip'] === 'string')
      .map((node) => node.props['data-tooltip']);
    expect(tooltips).toEqual(expect.arrayContaining([
      '关闭',
      '新建分组',
      '添加连接',
      '重命名',
      '删除',
      '编辑连接',
      '删除连接',
    ]));
    expect(tooltips.some((title) => title.includes('.'))).toBe(false);
  });

  it('keeps the management modal below nested editors but above ordinary popups', () => {
    const root = renderModal();
    expect(root.findAllByProps({ 'data-modal': true })[0].props['data-z-index']).toBe(20_000);
  });

  it('shows the selected count beside the group title only after selection', () => {
    const root = renderModal();
    selectGroup(root);
    expect(root.findAllByProps({ className: 'connection-group-management-selected-tag' })).toHaveLength(0);

    act(() => findByData(root, 'select-visible').props.onClick());

    const heading = root.findByProps({ className: 'connection-group-management-heading' });
    const selectedTag = heading.findByProps({ className: 'connection-group-management-selected-tag' });
    expect(selectedTag.findByType('span').children.join('')).toBe('已选 1');

    act(() => findByData(root, 'clear-visible').props.onClick());
    expect(root.findAllByProps({ className: 'connection-group-management-selected-tag' })).toHaveLength(0);
  });

  it('keeps cross-group dragging but blocks drags started from controls', () => {
    const root = renderModal();
    selectGroup(root);
    const row = findByData(root, 'connection-row', 'connection-1');
    const preventDefault = vi.fn();
    const setData = vi.fn();

    act(() => row.props.onDragStart({
      target: new FakeHTMLElement(true),
      preventDefault,
      dataTransfer: { setData, effectAllowed: '' },
    }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setData).not.toHaveBeenCalled();

    act(() => row.props.onDragStart({
      target: new FakeHTMLElement(false),
      preventDefault,
      dataTransfer: { setData, effectAllowed: '' },
    }));
    expect(setData).toHaveBeenCalledWith(
      'application/x-gonavi-connection-ids',
      JSON.stringify(['connection-1']),
    );
  });

  it('bridges row deletion to the existing sidebar deletion workflow', () => {
    const root = renderModal();
    selectGroup(root);
    const deleteEvent = vi.fn();
    const dispatchEvent = vi.fn((event: CustomEvent<{ connectionId: string }>) => deleteEvent(event));
    class TestCustomEvent<T> {
      type: string;
      detail: T;
      constructor(type: string, init: { detail: T }) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', TestCustomEvent);

    act(() => root.findByProps({ 'aria-label': '删除连接' }).props.onClick());

    expect(deleteEvent).toHaveBeenCalledTimes(1);
    expect(deleteEvent.mock.calls[0][0].detail).toEqual({
      connectionId: 'connection-1',
    });
  });

  it('uses clear recursive deletion copy and aligned action controls', () => {
    const root = renderModal();
    selectGroup(root);

    const groupDelete = root.findByProps({ 'aria-label': '删除' });
    expect(groupDelete.props.className).toContain('connection-group-management-toolbar-button');
    act(() => groupDelete.props.onClick());
    expect((Modal as any).confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除分组',
      content: '确定删除分组“Production”吗？该分组及所有子分组中的 1 个连接和已保存凭据将被永久删除。此操作无法恢复。',
    }));

    const rowDelete = root.findByProps({ 'aria-label': '删除连接' });
    expect(rowDelete.props.type).toBe('default');
    expect(rowDelete.props.className).toContain('connection-group-management-row-delete');
  });

  it('uses a separate copy when the recursive group tree has no connections', () => {
    storeState.connectionTags[0].connectionIds = [];
    const root = renderModal();
    selectGroup(root);

    act(() => root.findByProps({ 'aria-label': '删除' }).props.onClick());
    expect((Modal as any).confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除分组',
      content: '确定删除分组“Production”吗？该分组及所有子分组不包含连接。删除后无法恢复。',
    }));
  });

  it('makes sorting identifiable and gives the new group action a primary style', () => {
    const root = renderModal();
    selectGroup(root);

    const sortControl = root.findByProps({ className: 'connection-group-management-sort-control' });
    const sortLabelSpans = sortControl.findByProps({ className: 'connection-group-management-sort-label' }).findAllByType('span');
    const sortLabelText = sortLabelSpans[sortLabelSpans.length - 1]?.children.find((child: unknown) => typeof child === 'string');
    expect(sortLabelText).toBe('排序');
    expect(sortControl.findByType('select').props.options.map((option: { label: string }) => option.label)).toEqual(['名称', '添加时间']);

    const newGroup = root.findByProps({ className: 'connection-group-management-new-group' });
    expect(newGroup.props.type).toBe('primary');
  });

  it('keeps sorting tooltip separate from the interactive select', () => {
    const root = renderModal();
    selectGroup(root);

    const sortControl = root.findByProps({ className: 'connection-group-management-sort-control' });
    const select = sortControl.findByType('select');
    expect(select.parent?.props?.['data-tooltip']).toBeUndefined();
    expect(select.props['aria-label']).toBe('连接排序');
  });

  it('places child modals above the management modal', () => {
    const root = renderModal();
    selectGroup(root);

    expect(root.findAllByProps({ 'data-modal': true }).map((modal) => modal.props['data-z-index']))
      .toContain(20000);

    act(() => root.findByProps({ 'aria-label': '重命名' }).props.onClick());
    expect(root.findAllByProps({ 'data-modal': true }).map((modal) => modal.props['data-z-index']))
      .toEqual(expect.arrayContaining([20000, 21000]));
  });

  it('keeps management CSS on defined theme variables and overrides modal padding', () => {
    const css = readFileSync(new URL('./ConnectionGroupManagementModal.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/--gn-(bg-2|bg-active-hover|accent-contrast)\b/);
    expect(css).toMatch(/\.connection-group-management-modal \.ant-modal-header[\s\S]*padding:[^;]+!important/);
    expect(css).toMatch(/\.connection-group-management-modal \.ant-modal-body[\s\S]*padding: 0 !important/);
  });

  it('deletes the authoritative subtree and closes each deleted connection tab', async () => {
    const deleteConnections = vi.fn().mockResolvedValue(undefined);
    const closeTabsByConnection = vi.fn();
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            LoadConnectionSidebarLayout: vi.fn().mockResolvedValue({
              initialized: true,
              connectionTags: [{ id: 'group-1', name: 'Production', connectionIds: ['connection-1'] }],
            }),
            DeleteConnections: deleteConnections,
          },
        },
      },
    });
    const root = renderModal(closeTabsByConnection);
    selectGroup(root);
    const groupDelete = root.findByProps({ 'aria-label': '删除' });
    act(() => groupDelete.props.onClick());
    const confirmOptions = (Modal as any).confirm.mock.calls.at(-1)[0];

    await act(async () => { await confirmOptions.onOk(); });
    expect(deleteConnections).toHaveBeenCalledWith(['connection-1']);
    expect(closeTabsByConnection).toHaveBeenCalledWith('connection-1');
    expect(storeState.removeConnection).toHaveBeenCalledWith('connection-1');
    expect(storeState.removeConnectionTagTree).toHaveBeenCalledWith('group-1');
  });

  it('uses the atomic group deletion binding when available', async () => {
    const deleteConnectionGroup = vi.fn().mockResolvedValue(undefined);
    const deleteConnections = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      go: {
        app: {
          App: {
            LoadConnectionSidebarLayout: vi.fn().mockResolvedValue({
              initialized: true,
              revision: 9,
              connectionTags: [{ id: 'group-1', name: 'Production', connectionIds: ['connection-1'] }],
            }),
            DeleteConnectionGroup: deleteConnectionGroup,
            DeleteConnections: deleteConnections,
          },
        },
      },
    });
    const root = renderModal();
    selectGroup(root);
    act(() => root.findByProps({ 'aria-label': '删除' }).props.onClick());
    const confirmOptions = (Modal as any).confirm.mock.calls.at(-1)[0];

    await act(async () => { await confirmOptions.onOk(); });
    expect(deleteConnectionGroup).toHaveBeenCalledWith({ tagId: 'group-1', expectedRevision: 9 });
    expect(deleteConnections).not.toHaveBeenCalled();
    expect(storeState.removeConnectionTagTree).toHaveBeenCalledWith('group-1');
  });

  it('keeps local cleanup when the post-delete layout refresh fails', async () => {
    const deleteConnectionGroup = vi.fn().mockResolvedValue(undefined);
    const refreshFailure = new Error('refresh unavailable');
    const onConnectionGroupDeleted = vi.fn().mockRejectedValue(refreshFailure);
    vi.stubGlobal('window', {
      go: { app: { App: {
        LoadConnectionSidebarLayout: vi.fn().mockResolvedValue({
          initialized: true,
          revision: 9,
          connectionTags: [{ id: 'group-1', name: 'Production', connectionIds: ['connection-1'] }],
        }),
        DeleteConnectionGroup: deleteConnectionGroup,
      } } },
    });
    const root = renderModal();
    // Replace the default callback with a failing one for this scenario.
    act(() => renderer!.update(<ConnectionGroupManagementModal
      open
      onClose={vi.fn()}
      onOpenTagForm={vi.fn()}
      onCreateConnectionInGroup={vi.fn()}
      onEditConnection={vi.fn()}
      onCloseTabsByConnection={vi.fn()}
      onConnectionGroupDeleted={onConnectionGroupDeleted}
    />));
    selectGroup(renderer!.root);
    act(() => renderer!.root.findByProps({ 'aria-label': '删除' }).props.onClick());
    const confirmOptions = (Modal as any).confirm.mock.calls.at(-1)[0];

    await act(async () => { await confirmOptions.onOk(); });
    await act(async () => { await Promise.resolve(); });
    expect(deleteConnectionGroup).toHaveBeenCalledWith({ tagId: 'group-1', expectedRevision: 9 });
    expect(onConnectionGroupDeleted).toHaveBeenCalled();
    expect(storeState.removeConnection).toHaveBeenCalledWith('connection-1');
    expect(storeState.removeConnectionTagTree).toHaveBeenCalledWith('group-1');
  });

  it('reports backend deletion failures without changing the local tree', async () => {
    const failure = new Error('backend unavailable');
    vi.stubGlobal('window', {
      go: { app: { App: {
        DeleteConnections: vi.fn().mockRejectedValue(failure),
      } } },
    });
    const root = renderModal();
    selectGroup(root);
    act(() => root.findByProps({ 'aria-label': '删除' }).props.onClick());
    const confirmOptions = (Modal as any).confirm.mock.calls.at(-1)[0];

    await expect(act(async () => { await confirmOptions.onOk(); })).rejects.toThrow('backend unavailable');
    expect(messageMock.error).toHaveBeenCalledWith('删除分组失败');
    expect(storeState.removeConnection).not.toHaveBeenCalled();
    expect(storeState.removeConnectionTagTree).not.toHaveBeenCalled();
  });

  it('blocks deletion when another window moved the connection out of the group', async () => {
    const deleteConnections = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      go: { app: { App: {
        LoadConnectionSidebarLayout: vi.fn().mockResolvedValue({
          initialized: true,
          connectionTags: [{ id: 'group-1', name: 'Production', connectionIds: [] }],
        }),
        DeleteConnections: deleteConnections,
      } } },
    });
    const root = renderModal();
    selectGroup(root);
    act(() => root.findByProps({ 'aria-label': '删除' }).props.onClick());
    const confirmOptions = (Modal as any).confirm.mock.calls.at(-1)[0];

    await expect(act(async () => { await confirmOptions.onOk(); })).rejects.toThrow('分组内容已被其他窗口更新，请刷新后再删除。');
    expect(deleteConnections).not.toHaveBeenCalled();
    expect(messageMock.error).toHaveBeenCalledWith('分组内容已被其他窗口更新，请刷新后再删除。');
  });
});
