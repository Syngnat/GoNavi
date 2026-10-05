import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisViewer from './RedisViewer';
import { readCssWithImports } from '../test/readCssWithImports';

const appCss = readCssWithImports(new URL('../App.css', import.meta.url));

const v2WorkbenchCss = readCssWithImports(new URL('../styles/v2-theme-workbench.css', import.meta.url));

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'redis-1',
      name: 'redis',
      config: {
        type: 'redis',
        host: '127.0.0.1',
        port: 6379,
        password: '',
        database: '',
      },
    },
  ],
  theme: 'light',
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
  },
}));

const redisBackend = vi.hoisted(() => ({
  RedisScanKeys: vi.fn(),
  RedisGetValue: vi.fn(),
  RedisGetListValue: vi.fn(),
  RedisListPush: vi.fn(),
  RedisListRemove: vi.fn(),
  RedisListSet: vi.fn(),
  RedisExportKeys: vi.fn(),
  RedisPreviewImportKeys: vi.fn(),
  RedisImportKeys: vi.fn(),
}));

const antdState = vi.hoisted(() => ({
  treeProps: null as any,
  tableProps: [] as any[],
  modalConfirm: vi.fn(),
  message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../store', () => {
  const useStore = Object.assign(
    (selector: (state: typeof storeState) => any) => selector(storeState),
    { getState: () => storeState },
  );
  return { useStore };
});

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react');
  return {
    default: () => React.createElement('div', { 'data-monaco-editor': true }),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const Icon = () => React.createElement('span', { 'data-icon': true });
  return {
    ReloadOutlined: Icon,
    DeleteOutlined: Icon,
    PlusOutlined: Icon,
    EditOutlined: Icon,
    EyeOutlined: Icon,
    SearchOutlined: Icon,
    ClockCircleOutlined: Icon,
    CopyOutlined: Icon,
    FolderOpenOutlined: Icon,
    KeyOutlined: Icon,
    PartitionOutlined: Icon,
    UnorderedListOutlined: Icon,
    TagsOutlined: Icon,
    RightOutlined: Icon,
    DownOutlined: Icon,
  };
});

vi.mock('antd', async () => {
  const React = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) => React.createElement(tag, props, children);
  const Button = ({ children, ...props }: any) => React.createElement('button', props, children);
  const Input = Object.assign(
    ({ ...props }: any) => React.createElement('input', props),
    {
      Search: ({ ...props }: any) => React.createElement('input', props),
      TextArea: ({ ...props }: any) => React.createElement('textarea', props),
    },
  );
  const FormComponent = Object.assign(
    ({ children, ...props }: any) => React.createElement('form', props, children),
    {
      Item: passthrough('div'),
      useForm: () => [{
        validateFields: vi.fn(),
        resetFields: vi.fn(),
        setFieldsValue: vi.fn(),
      }],
    },
  );

  return {
    Table: (props: any) => {
      antdState.tableProps.push(props);
      return React.createElement('redis-table');
    },
    Input,
    Button,
    Space: Object.assign(passthrough('div'), { Compact: passthrough('div') }),
    Tag: passthrough('span'),
    Tree: (props: any) => {
      antdState.treeProps = props;
      return React.createElement('redis-tree');
    },
    Spin: ({ children }: any) => React.createElement(React.Fragment, null, children),
    message: antdState.message,
    Modal: Object.assign(({ children, open, onOk, onCancel, okButtonProps, title, ...props }: any) => {
      if (!open) {
        return null;
      }
      return React.createElement('div', props, [
        React.createElement('div', { key: 'title', 'data-modal-title': true }, title),
        children,
        onOk ? React.createElement('button', { key: 'ok', onClick: onOk, disabled: okButtonProps?.disabled }, 'modal-ok') : null,
        onCancel ? React.createElement('button', { key: 'cancel', onClick: onCancel }, 'modal-cancel') : null,
      ]);
    }, { confirm: antdState.modalConfirm }),
    Form: FormComponent,
    InputNumber: ({ ...props }: any) => React.createElement('input', props),
    Popconfirm: passthrough('span'),
    Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Radio: {
      Group: passthrough('div'),
      Button,
    },
  };
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const collectRenderedText = (node: any): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectRenderedText).join('');
  if (Array.isArray(node.children)) return node.children.map(collectRenderedText).join('');
  return '';
};

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  return renderer.root.findAllByType('button').find((node) => collectRenderedText(node.props.children).includes(text));
};

const countLeafNodes = (nodes: any[]): number => {
  return nodes.reduce((total, node) => {
    if (!node || typeof node !== 'object') {
      return total;
    }
    if (node.nodeType === 'leaf') {
      return total + 1;
    }
    return total + countLeafNodes(Array.isArray(node.children) ? node.children : []);
  }, 0);
};

const findFirstLeafNode = (nodes: any[]): any | null => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (node.nodeType === 'leaf') {
      return node;
    }
    if (Array.isArray(node.children)) {
      const nested = findFirstLeafNode(node.children);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

const findLeafNodeByRawKey = (nodes: any[], rawKey: string): any | null => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (node.nodeType === 'leaf' && node.rawKey === rawKey) {
      return node;
    }
    if (Array.isArray(node.children)) {
      const nested = findLeafNodeByRawKey(node.children, rawKey);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

describe('RedisViewer tree interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    antdState.treeProps = null;
    antdState.tableProps = [];
    antdState.modalConfirm.mockImplementation(() => ({ update: vi.fn(), destroy: vi.fn() }));
    storeState.connections = [
      {
        id: 'redis-1',
        name: 'redis',
        config: {
          type: 'redis',
          host: '127.0.0.1',
          port: 6379,
          password: '',
          database: '',
        },
      },
    ];

    redisBackend.RedisScanKeys.mockResolvedValue({
      success: true,
      data: {
        cursor: '0',
        keys: [
          { key: 'app:user:1', type: 'string', ttl: -1 },
          { key: 'app:user:2', type: 'string', ttl: -1 },
        ],
      },
    });
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'string', ttl: -1, value: 'demo', length: 4 },
    });
    redisBackend.RedisGetListValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: [], length: 0 },
    });
    redisBackend.RedisListPush.mockResolvedValue({ success: true });
    redisBackend.RedisListRemove.mockResolvedValue({ success: true });
    redisBackend.RedisListSet.mockResolvedValue({ success: true });
    redisBackend.RedisExportKeys.mockResolvedValue({
      success: true,
      data: { exported: 2 },
    });
    redisBackend.RedisPreviewImportKeys.mockResolvedValue({
      success: true,
      data: {
        file: 'C:\\tmp\\redis-keys.json',
        database: 0,
        total: 2,
        keys: [
          { key: 'app:user:1', type: 'string', ttl: -1 },
          { key: 'app:user:2', type: 'string', ttl: 120 },
        ],
      },
    });
    redisBackend.RedisImportKeys.mockResolvedValue({
      success: true,
      data: { imported: 1, skipped: 0, total: 1 },
    });
    vi.stubGlobal('window', {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      go: {
        app: {
          App: redisBackend,
        },
      },
    });
    vi.stubGlobal('ResizeObserver', undefined);
  });

  it('rejects an exact search page that repeats its request cursor', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'exact' } });
    });
    await flushEffects();

    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '27',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '27',
          keys: [{ key: 'app:user:2', type: 'string', ttl: -1 }],
        },
      });

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('app:user');
    });
    await flushEffects();

    const loadMoreButton = findButtonByText(renderer!, 'Load more');
    expect(loadMoreButton).toBeTruthy();
    await act(async () => {
      loadMoreButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.map((call) => call[2])).toEqual(['0', '27']);
    expect(antdState.message.error).toHaveBeenCalledWith(expect.stringContaining('cursor'));
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);

    renderer!.unmount();
  });

  it('stops a filtered scan when the backend repeats a cursor', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '27',
          keys: [{ key: 'sub:v2:first', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [] },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('sub:v2');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(antdState.message.error).toHaveBeenCalledWith(expect.stringContaining('cursor'));

    renderer!.unmount();
  });

  it('loads every key page when the load-all action is clicked', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [
            { key: 'app:user:1', type: 'string', ttl: -1 },
            { key: 'app:user:2', type: 'string', ttl: -1 },
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [
            { key: 'app:user:1', type: 'string', ttl: -1 },
            { key: 'app:user:2', type: 'string', ttl: -1 },
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [
            { key: 'app:user:3', type: 'string', ttl: -1 },
          ],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const loadAllButton = findButtonByText(renderer!, 'Load all');
    expect(loadAllButton).toBeTruthy();

    await act(async () => {
      loadAllButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(redisBackend.RedisScanKeys.mock.calls[1]?.[2]).toBe('0');
    expect(redisBackend.RedisScanKeys.mock.calls[2]?.[2]).toBe('1');

    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(3);

    const renderedText = collectRenderedText(renderer!.toJSON());
    expect(renderedText).toContain('Loaded 3 Keys');

    renderer!.unmount();
  });

  it('stops load-all when the backend repeats a cursor', async () => {
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [{ key: 'app:user:2', type: 'string', ttl: -1 }],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const loadAllButton = findButtonByText(renderer!, 'Load all');
    await act(async () => {
      loadAllButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(redisBackend.RedisScanKeys.mock.calls.slice(1).map((call) => call[2])).toEqual(['0', '1']);
    expect(antdState.message.error).toHaveBeenCalledWith(expect.stringContaining('cursor'));
    expect(findButtonByText(renderer!, 'Load all')?.props.loading).toBe(false);

    renderer!.unmount();
  });

  it('keeps a newer search when it supersedes a pending load-all request', async () => {
    let resolveLoadAll!: (value: any) => void;
    const pendingLoadAll = new Promise<any>((resolve) => {
      resolveLoadAll = resolve;
    });
    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '1',
          keys: [{ key: 'app:user:1', type: 'string', ttl: -1 }],
        },
      })
      .mockReturnValueOnce(pendingLoadAll)
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'new:result', type: 'string', ttl: -1 }],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    await act(async () => {
      findButtonByText(renderer!, 'Load all')!.props.onClick?.();
    });
    await flushEffects();
    expect(findButtonByText(renderer!, 'Load all')?.props.loading).toBe(true);

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('new');
    });
    await flushEffects();

    expect(findButtonByText(renderer!, 'Load all')?.props.loading).toBe(false);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);
    expect(findFirstLeafNode(antdState.treeProps.treeData)?.rawKey).toBe('new:result');

    await act(async () => {
      resolveLoadAll({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'stale:result', type: 'string', ttl: -1 }],
        },
      });
      await pendingLoadAll;
    });
    await flushEffects();

    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);
    expect(findFirstLeafNode(antdState.treeProps.treeData)?.rawKey).toBe('new:result');

    renderer!.unmount();
  });

  it('exports the current filtered key set when the export-all action is clicked', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const exportAllButton = findButtonByText(renderer!, 'Export all');
    expect(exportAllButton).toBeTruthy();

    await act(async () => {
      exportAllButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisExportKeys).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      { scope: 'all', keys: [], pattern: '*' },
    );

    renderer!.unmount();
  });

  it('exports checked leaf keys when the export-selected action is clicked', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    expect(leafNode?.rawKey).toBe('app:user:1');

    await act(async () => {
      antdState.treeProps.onCheck?.(
        { checked: [leafNode.key], halfChecked: [] },
        { checked: true, node: leafNode },
      );
    });
    await flushEffects();

    const exportSelectedButton = findButtonByText(renderer!, 'Export selected');
    expect(exportSelectedButton).toBeTruthy();
    expect(exportSelectedButton?.props.disabled).toBe(false);

    await act(async () => {
      exportSelectedButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisExportKeys).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      { scope: 'selected', keys: ['app:user:1'], pattern: '*' },
    );

    renderer!.unmount();
  });

  it('imports only the checked preview keys from the selected file', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const importButton = findButtonByText(renderer!, 'Import');
    expect(importButton).toBeTruthy();

    await act(async () => {
      importButton!.props.onClick?.();
    });
    await flushEffects();

    const chooseFileButton = findButtonByText(renderer!, 'Select import file');
    expect(chooseFileButton).toBeTruthy();

    await act(async () => {
      chooseFileButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisPreviewImportKeys).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
    );

    const secondCheckbox = renderer!.root.findByProps({ 'data-import-key': 'app:user:2' });
    await act(async () => {
      secondCheckbox.props.onChange?.({ target: { checked: false } });
    });
    await flushEffects();

    const modalOkButton = findButtonByText(renderer!, 'modal-ok');
    expect(modalOkButton).toBeTruthy();
    expect(modalOkButton?.props.disabled).toBe(false);

    await act(async () => {
      modalOkButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisImportKeys).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      {
        conflictMode: 'overwrite',
        file: 'C:\\tmp\\redis-keys.json',
        scope: 'selected',
        keys: ['app:user:1'],
      },
    );

    renderer!.unmount();
  });

  it('filters Hash rows by field and value with case-insensitive AND matching', async () => {
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: {
        key: 'app:user:1',
        type: 'hash',
        ttl: -1,
        value: {
          UserName: 'Alice',
          userEmail: 'alice@example.com',
          team: 'Platform',
          status: 'ACTIVE',
        },
        length: 4,
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const fieldFilter = renderer!.root.findByProps({ 'data-redis-hash-field-filter': 'true' });
    const valueFilter = renderer!.root.findByProps({ 'data-redis-hash-value-filter': 'true' });
    expect(fieldFilter.props.allowClear).toBe(true);
    expect(valueFilter.props.allowClear).toBe(true);
    expect(fieldFilter.props['aria-label']).toBe('Filter fields');
    expect(valueFilter.props['aria-label']).toBe('Filter values');

    await act(async () => {
      fieldFilter.props.onChange?.({ target: { value: 'USER' } });
    });
    let hashTable = [...antdState.tableProps].reverse().find((props) => props.rowKey === 'field');
    expect(hashTable.dataSource.map((row: any) => row.field)).toEqual(['UserName', 'userEmail']);

    await act(async () => {
      fieldFilter.props.onChange?.({ target: { value: '' } });
      valueFilter.props.onChange?.({ target: { value: 'alice' } });
    });
    hashTable = [...antdState.tableProps].reverse().find((props) => props.rowKey === 'field');
    expect(hashTable.dataSource.map((row: any) => row.field)).toEqual(['UserName', 'userEmail']);

    const currentFieldFilter = renderer!.root.findByProps({ 'data-redis-hash-field-filter': 'true' });
    await act(async () => {
      currentFieldFilter.props.onChange?.({ target: { value: 'EMAIL' } });
    });
    hashTable = [...antdState.tableProps].reverse().find((props) => props.rowKey === 'field');
    expect(hashTable.dataSource.map((row: any) => row.field)).toEqual(['userEmail']);
    expect(hashTable.pagination.showTotal()).toBe('1 of 4 items');
    expect(renderer!.root.findByProps({ className: 'redis-value-table-shell' }).props['data-redis-value-total']).toBe(1);

    const currentValueFilter = renderer!.root.findByProps({ 'data-redis-hash-value-filter': 'true' });
    await act(async () => {
      currentFieldFilter.props.onChange?.({ target: { value: '' } });
      currentValueFilter.props.onChange?.({ target: { value: '' } });
    });
    hashTable = [...antdState.tableProps].reverse().find((props) => props.rowKey === 'field');
    expect(hashTable.dataSource).toHaveLength(4);

    renderer!.unmount();
  });

  it('keeps Hash filters on refresh and clears them when switching Keys', async () => {
    redisBackend.RedisGetValue.mockImplementation(async (_config: any, key: string) => ({
      success: true,
      data: key === 'app:user:1'
        ? {
            key,
            type: 'hash',
            ttl: -1,
            value: { userName: 'Alice', team: 'Platform' },
            length: 2,
          }
        : {
            key,
            type: 'hash',
            ttl: -1,
            value: { account: 'Bob', status: 'ACTIVE' },
            length: 2,
          },
    }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const firstLeaf = findLeafNodeByRawKey(antdState.treeProps.treeData, 'app:user:1');
    await act(async () => {
      antdState.treeProps.onSelect?.([firstLeaf.key]);
    });
    await flushEffects();

    let fieldFilter = renderer!.root.findByProps({ 'data-redis-hash-field-filter': 'true' });
    await act(async () => {
      fieldFilter.props.onChange?.({ target: { value: 'user' } });
    });
    await flushEffects();

    const detailActions = renderer!.root.findByProps({ className: 'redis-key-detail-actions' });
    const refreshButton = detailActions.findAllByType('button')
      .find((node) => collectRenderedText(node.props.children).includes('Refresh'));
    await act(async () => {
      refreshButton!.props.onClick?.();
    });
    await flushEffects();
    fieldFilter = renderer!.root.findByProps({ 'data-redis-hash-field-filter': 'true' });
    expect(fieldFilter.props.value).toBe('user');

    const secondLeaf = findLeafNodeByRawKey(antdState.treeProps.treeData, 'app:user:2');
    await act(async () => {
      antdState.treeProps.onSelect?.([secondLeaf.key]);
    });
    await flushEffects();

    fieldFilter = renderer!.root.findByProps({ 'data-redis-hash-field-filter': 'true' });
    const valueFilter = renderer!.root.findByProps({ 'data-redis-hash-value-filter': 'true' });
    expect(fieldFilter.props.value).toBe('');
    expect(valueFilter.props.value).toBe('');
    const hashTable = [...antdState.tableProps].reverse().find((props) => props.rowKey === 'field');
    expect(hashTable.dataSource.map((row: any) => row.field)).toEqual(['account', 'status']);

    renderer!.unmount();
  });

  it.each([
    { buttonText: 'Push to tail', inputId: 'new-list-value', value: 'tail-item', position: 'right' },
    { buttonText: 'Push to head', inputId: 'new-list-value-left', value: 'head-item', position: 'left' },
  ] as const)('pushes a List value through the $buttonText action', async ({ buttonText, inputId, value, position }) => {
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['existing'], length: 1 },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const pushButton = findButtonByText(renderer!, buttonText);
    expect(pushButton).toBeTruthy();
    await act(async () => {
      pushButton!.props.onClick?.();
    });

    expect(antdState.modalConfirm).toHaveBeenCalledTimes(1);
    const modalConfig = antdState.modalConfirm.mock.calls[0][0];
    const getElementById = vi.fn((id: string) => id === inputId ? { value } : null);
    vi.stubGlobal('document', { getElementById });
    await act(async () => {
      await modalConfig.onOk();
    });
    await flushEffects();

    expect(getElementById).toHaveBeenCalledWith(inputId);
    expect(redisBackend.RedisListPush).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      'app:user:1',
      { values: [value], position },
    );

    renderer!.unmount();
  });

  it('removes the selected duplicate List value by its original index after descending sort', async () => {
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['duplicate', 'middle', 'duplicate'], length: 3 },
    });
    redisBackend.RedisGetListValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['duplicate', 'middle', 'duplicate'], length: 3 },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const listTables = antdState.tableProps.filter((props) => Array.isArray(props.dataSource)
      && props.dataSource[0]?.value === 'duplicate'
      && props.dataSource[0]?.index === 0);
    const listTable = listTables[listTables.length - 1];
    expect(listTable).toBeTruthy();

    await act(async () => {
      listTable.onChange?.({}, {}, { columnKey: 'index', order: 'descend' });
    });
    await flushEffects();

    const descendingTables = antdState.tableProps.filter((props) => Array.isArray(props.dataSource)
      && props.dataSource[0]?.value === 'duplicate'
      && props.dataSource[0]?.index === 2);
    const descendingTable = descendingTables[descendingTables.length - 1];
    expect(descendingTable).toBeTruthy();
    const actionColumn = descendingTable.columns.find((column: any) => column.key === 'action');
    let actionRenderer: ReactTestRenderer;
    await act(async () => {
      actionRenderer = create(actionColumn.render(null, descendingTable.dataSource[0]));
    });
    const confirmation = actionRenderer!.root
      .findAllByType('span')
      .find((node) => typeof node.props.onConfirm === 'function');
    expect(confirmation).toBeTruthy();

    await act(async () => {
      await confirmation!.props.onConfirm();
    });
    await flushEffects();

    expect(redisBackend.RedisListRemove).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      'app:user:1',
      2,
      'duplicate',
    );
    expect(antdState.message.success).toHaveBeenCalledWith('Deleted');

    actionRenderer!.unmount();
    renderer!.unmount();
  });

  it('keeps List pagination visible and reports the full item count', async () => {
    const values = Array.from({ length: 211 }, (_, index) => `item-${index}`);
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: values, length: 211 },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const listTable = antdState.tableProps.find((props) => props.dataSource?.length === 211);
    expect(listTable).toBeTruthy();
    expect(listTable.pagination).toMatchObject({ pageSize: 50, showSizeChanger: false });
    expect(listTable.pagination.showTotal()).toBe('211 items');
    expect(listTable.scroll.y).toBeTypeOf('number');

    const tableShell = renderer!.root.findByProps({ className: 'redis-value-table-shell' });
    expect(tableShell.props['data-redis-value-total']).toBe(211);
    expect(tableShell.props.style).toMatchObject({ flex: 1, minHeight: 0, overflow: 'hidden' });

    renderer!.unmount();
  });

  it('loads the List tail in descending order while preserving the default order', async () => {
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['item-0', 'item-1', 'item-2'], length: 1203 },
    });
    redisBackend.RedisGetListValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['item-1202', 'item-1201', 'item-1200'], length: 1203 },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const listTable = antdState.tableProps.find((props) => props.dataSource?.[0]?.value === 'item-0');
    expect(listTable.dataSource.map((row: any) => row.index)).toEqual([0, 1, 2]);

    const indexColumn = listTable.columns.find((column: any) => column.key === 'index');
    expect(indexColumn.sortDirections).toEqual(['descend', 'ascend']);
    expect(indexColumn.sortOrder).toBeNull();

    await act(async () => {
      listTable.onChange?.({}, {}, { columnKey: 'index', order: 'descend' });
    });
    await flushEffects();

    expect(redisBackend.RedisGetListValue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }),
      'app:user:1',
      true,
    );
    const descendingTables = antdState.tableProps.filter((props) => props.dataSource?.[0]?.value === 'item-1202');
    const descendingTable = descendingTables[descendingTables.length - 1];
    expect(descendingTable.dataSource.map((row: any) => [row.index, row.value])).toEqual([
      [1202, 'item-1202'],
      [1201, 'item-1201'],
      [1200, 'item-1200'],
    ]);
    expect(descendingTable.columns.find((column: any) => column.key === 'index').sortOrder).toBe('descend');

    renderer!.unmount();
  });

  it('only shows the Redis value table scrollbar when its rows overflow', () => {
    expect(appCss).toMatch(
      /\.redis-value-table-shell \.ant-table-body\s*\{[^}]*overflow-y:\s*auto\s*!important;/s,
    );
  });

  it('keeps the V2 Redis Key hover highlight on a single row surface', () => {
    expect(v2WorkbenchCss).toMatch(
      /body\[data-ui-version="v2"\] \.gn-v2-redis-workbench \.ant-tree \.ant-tree-treenode:hover\s*\{[^}]*background:\s*var\(--gn-bg-hover\)\s*!important;/s,
    );
    expect(v2WorkbenchCss).toMatch(
      /\.ant-tree-treenode\.ant-tree-treenode-selected:hover\s*\{[^}]*background:\s*var\(--gn-bg-selected\)\s*!important;[^}]*border:\s*none\s*!important;/s,
    );
    expect(v2WorkbenchCss).toMatch(
      /body\[data-ui-version="v2"\] \.gn-v2-redis-workbench \.ant-tree \.ant-tree-node-content-wrapper:hover,[^{]*\{[^}]*background:\s*transparent\s*!important;/s,
    );
  });

  it('allows the V2 Redis header and Key card to shrink inside the sidebar grid column', () => {
    expect(v2WorkbenchCss).toMatch(
      /body\[data-ui-version="v2"\] \.gn-v2-redis-header,\s*body\[data-ui-version="v2"\] \.gn-v2-redis-tree-card\s*\{[^}]*min-width:\s*0\s*;/s,
    );
  });

  it('opens a List item in a read-only value viewer without writing to Redis', async () => {
    redisBackend.RedisGetValue.mockResolvedValue({
      success: true,
      data: { key: 'app:user:1', type: 'list', ttl: -1, value: ['{"status":"ok"}'], length: 1 },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const leafNode = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([leafNode.key]);
    });
    await flushEffects();

    const listTable = antdState.tableProps.find((props) => props.dataSource?.[0]?.value === '{"status":"ok"}');
    const actionColumn = listTable.columns.find((column: any) => column.key === 'action');
    let actionRenderer: ReactTestRenderer;
    await act(async () => {
      actionRenderer = create(actionColumn.render(null, listTable.dataSource[0]));
    });

    const viewButton = actionRenderer!.root.findByProps({ 'aria-label': 'View value' });
    await act(async () => {
      viewButton.props.onClick();
    });
    await flushEffects();

    const modalTitle = renderer!.root.findAllByProps({ 'data-modal-title': true })
      .find((node) => collectRenderedText(node).includes('View index 0'));
    expect(modalTitle).toBeTruthy();
    const readOnlyEditor = renderer!.root.findAll((node) =>
      node.props.gonaviTypography === 'data' && node.props.options?.readOnly === true,
    );
    expect(readOnlyEditor.length).toBeGreaterThan(0);

    const modalOkButton = findButtonByText(renderer!, 'modal-ok');
    await act(async () => {
      await modalOkButton!.props.onClick?.();
    });
    expect(redisBackend.RedisListSet).not.toHaveBeenCalled();

    actionRenderer!.unmount();
    renderer!.unmount();
  });
});
