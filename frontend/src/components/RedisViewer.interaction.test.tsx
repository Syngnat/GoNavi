import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RedisViewer from './RedisViewer';

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');

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
    uiVersion: 'v1' as 'v1' | 'v2',
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

const createRedisKeyBatch = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
  key: `matched:${start + index}`,
  type: 'string',
  ttl: -1,
}));

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
    storeState.appearance.uiVersion = 'v1';
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

  it('toggles namespace expansion from row clicks without checking the group', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const appGroup = antdState.treeProps.treeData.find((node: any) => node.key === 'group:app');
    expect(appGroup).toBeTruthy();
    // rc-tree maps a click on an unselectable, checkable node to onCheck.
    // Groups must remain selectable so a row click reaches onSelect (which
    // RedisViewer safely ignores for nodes without a raw Redis key).
    expect(appGroup.selectable).not.toBe(false);
    expect(antdState.treeProps.expandedKeys).not.toContain('group:app');

    const groupTitle = antdState.treeProps.titleRender(appGroup);
    expect(typeof groupTitle.props.onClick).toBe('function');

    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      groupTitle.props.onClick(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(antdState.treeProps.expandedKeys).toContain('group:app');
    expect(antdState.treeProps.checkedKeys.checked).toEqual([]);

    renderer!.unmount();
  });

  it('filters keys by the full namespace path from a group action', async () => {
    let renderer: ReactTestRenderer;
    let groupTitleRenderer: ReactTestRenderer;
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

    const appGroup = antdState.treeProps.treeData.find((node: any) => node.key === 'group:app');
    const userGroup = appGroup.children.find((node: any) => node.key === 'group:app:user');
    await act(async () => {
      groupTitleRenderer = create(antdState.treeProps.titleRender(userGroup));
    });

    const filterButton = groupTitleRenderer!.root.findByProps({ 'aria-label': 'Filter by namespace' });
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => {
      filterButton.props.onClick(event);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input').find(node => typeof node.props.onSearch === 'function');
    const updatedSearchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(searchInput?.props.value).toBe('app:user');
    expect(updatedSearchModeGroup.props.value).toBe('prefix');
    expect(redisBackend.RedisScanKeys).toHaveBeenLastCalledWith(
      expect.any(Object),
      '[aA][pP][pP]:[uU][sS][eE][rR]*',
      '0',
      600,
    );

    groupTitleRenderer!.unmount();
    renderer!.unmount();
  });

  it('shows Redis Cluster topology context in the key explorer header', async () => {
    storeState.connections = [
      {
        id: 'redis-1',
        name: 'redis-cluster',
        config: {
          type: 'redis',
          host: '10.0.0.1',
          port: 6379,
          hosts: ['10.0.0.2:6379', '10.0.0.3:6379'],
          topology: 'cluster',
          password: '',
          database: '',
        } as any,
      },
    ];

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={2} />);
    });
    await flushEffects();

    const renderedText = collectRenderedText(renderer!.toJSON());
    expect(renderedText).toContain('db2');
    expect(renderedText).toContain('Cluster');
    expect(renderedText).toContain('3 nodes');

    renderer!.unmount();
  });

  it('renders key detail actions on a separate row below the metadata', async () => {
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

    const header = renderer!.root.findByProps({ className: 'redis-key-detail-header' });
    const top = renderer!.root.findByProps({ className: 'redis-key-detail-top' });
    const viewMode = renderer!.root.findByProps({ className: 'redis-key-view-mode' });
    const summary = renderer!.root.findByProps({ className: 'redis-key-detail-summary' });
    const identity = renderer!.root.findByProps({ className: 'redis-key-detail-identity' });
    const metadata = renderer!.root.findByProps({ className: 'redis-key-detail-metadata' });
    const actions = renderer!.root.findByProps({ className: 'redis-key-detail-actions' });

    expect(header.props.style).toMatchObject({ flexDirection: 'column' });
    expect(header.parent).toBe(top);
    expect(viewMode.parent).toBe(top);
    expect(summary.props.style).toMatchObject({ minWidth: 0, width: '100%' });
    expect(identity.props.style).toMatchObject({ minWidth: 0, width: '100%' });
    expect(identity.parent).toBe(summary);
    expect(metadata.parent).toBe(summary);
    expect(actions.parent).toBe(summary);
    expect(summary.children.indexOf(identity)).toBeLessThan(summary.children.indexOf(metadata));
    expect(summary.children.indexOf(metadata)).toBeLessThan(summary.children.indexOf(actions));
    expect(actions.props.style).toMatchObject({
      alignSelf: 'flex-start',
      flexWrap: 'wrap',
      maxWidth: '100%',
    });
    const activeKey = renderer!.root.findByProps({ 'data-redis-active-key': 'true' });
    expect(activeKey.props.style).toMatchObject({ flex: '0 1 auto', minWidth: 0, textOverflow: 'ellipsis' });
    expect(activeKey.props.style).not.toHaveProperty('maxWidth');
    expect(findButtonByText(renderer!, 'Set TTL')).toBeTruthy();
    expect(findButtonByText(renderer!, 'Refresh')).toBeTruthy();
    expect(findButtonByText(renderer!, 'Delete Key')).toBeTruthy();

    renderer!.unmount();
  });

  it('keeps the V2 value grid mounted while refresh and key switches are pending', async () => {
    storeState.appearance.uiVersion = 'v2';

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const firstLeaf = findFirstLeafNode(antdState.treeProps.treeData);
    await act(async () => {
      antdState.treeProps.onSelect?.([firstLeaf.key]);
    });
    await flushEffects();

    let resolveRefresh!: (value: any) => void;
    const pendingRefresh = new Promise<any>((resolve) => {
      resolveRefresh = resolve;
    });
    redisBackend.RedisGetValue.mockReturnValueOnce(pendingRefresh);

    const detailActions = renderer!.root.findByProps({ className: 'redis-key-detail-actions' });
    const refreshButton = detailActions.findAllByType('button')
      .find((node) => collectRenderedText(node.props.children).includes('Refresh'));
    await act(async () => {
      refreshButton!.props.onClick?.();
      await Promise.resolve();
    });

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:1']);
    const loadingOverlay = renderer!.root.findByProps({ 'data-redis-value-loading-overlay': 'true' });
    expect(loadingOverlay.parent?.props.className).toBe('gn-v2-redis-value-pane');
    expect(loadingOverlay.props.style).toMatchObject({
      position: 'absolute',
      inset: 0,
    });
    expect(loadingOverlay.props.style).not.toHaveProperty('gridColumn');
    expect(loadingOverlay.props.style).not.toHaveProperty('gridRow');

    await act(async () => {
      resolveRefresh({
        success: true,
        data: { key: 'app:user:1', type: 'string', ttl: -1, value: 'refreshed', length: 9 },
      });
      await pendingRefresh;
    });
    await flushEffects();
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(0);

    const secondLeaf = antdState.treeProps.treeData
      .flatMap((node: any) => node.children || [])
      .flatMap((node: any) => node.children || [])
      .find((node: any) => node.rawKey === 'app:user:2');
    let resolveSwitch!: (value: any) => void;
    const pendingSwitch = new Promise<any>((resolve) => {
      resolveSwitch = resolve;
    });
    redisBackend.RedisGetValue.mockReturnValueOnce(pendingSwitch);

    await act(async () => {
      antdState.treeProps.onSelect?.([secondLeaf.key]);
      await Promise.resolve();
    });

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:1']);
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(1);

    await act(async () => {
      resolveSwitch({
        success: true,
        data: { key: 'app:user:2', type: 'string', ttl: -1, value: 'next', length: 4 },
      });
      await pendingSwitch;
    });
    await flushEffects();

    expect(renderer!.root.findByProps({ 'data-redis-active-key': 'true' }).children).toEqual(['app:user:2']);
    expect(renderer!.root.findAllByProps({ 'data-redis-value-loading-overlay': 'true' })).toHaveLength(0);

    renderer!.unmount();
  });

  it('continues a filtered scan when the first cursor page has no matching keys', async () => {
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
        data: { cursor: '27', keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [{ key: 'sub:v2:lock', type: 'string', ttl: 2400 }],
        },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    expect(searchInput).toBeTruthy();

    await act(async () => {
      searchInput!.props.onSearch('sub:v2');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(redisBackend.RedisScanKeys.mock.calls[1]?.[2]).toBe('0');
    expect(redisBackend.RedisScanKeys.mock.calls[2]?.[2]).toBe('27');
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);
    expect(findFirstLeafNode(antdState.treeProps.treeData)?.rawKey).toBe('sub:v2:lock');

    renderer!.unmount();
  });

  it('loads and deduplicates every filtered cursor page automatically', async () => {
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
          keys: [
            { key: 'sub:v2:first', type: 'string', ttl: -1 },
            { key: 'sub:v2:shared', type: 'string', ttl: -1 },
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '31', keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          cursor: '0',
          keys: [
            { key: 'sub:v2:shared', type: 'string', ttl: -1 },
            { key: 'sub:v2:last', type: 'string', ttl: -1 },
          ],
        },
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

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(4);
    expect(redisBackend.RedisScanKeys.mock.calls.slice(1).map((call) => call[2])).toEqual(['0', '27', '31']);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(3);
    expect(collectRenderedText(renderer!.toJSON())).toContain('Loaded 3 Keys');
    expect(findButtonByText(renderer!, 'Load more')).toBeUndefined();

    renderer!.unmount();
  });

  it('loads more than two thousand filtered keys without manual paging', async () => {
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
        data: { cursor: '27', keys: createRedisKeyBatch(0, 1000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '31', keys: createRedisKeyBatch(1000, 1000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: createRedisKeyBatch(2000, 1) },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('matched');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.slice(1).map((call) => call[2])).toEqual(['0', '27', '31']);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2001);
    expect(collectRenderedText(renderer!.toJSON())).toContain('Loaded 2001 Keys');
    expect(findButtonByText(renderer!, 'Load more')).toBeUndefined();

    renderer!.unmount();
  });

  it('rejects filtered searches that exceed the result safety limit', async () => {
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
        data: { cursor: '27', keys: createRedisKeyBatch(0, 5000) },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: createRedisKeyBatch(5000, 5001) },
      });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('matched');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenCalledTimes(3);
    expect(antdState.message.error).toHaveBeenCalledWith(expect.stringContaining('10000'));
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(1);

    renderer!.unmount();
  });

  it('keeps exact searches on the existing initial page size', async () => {
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

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('app:user');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys).toHaveBeenLastCalledWith(
      expect.any(Object),
      'app:user',
      '0',
      600,
    );

    renderer!.unmount();
  });

  it('runs and refreshes fuzzy searches to completion with the same pattern', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RedisViewer connectionId="redis-1" redisDB={0} />);
    });
    await flushEffects();

    expect(findButtonByText(renderer!, 'Fuzzy')).toBeTruthy();
    const searchModeGroup = renderer!.root.findAll(
      node => node.props.buttonStyle === 'solid' && typeof node.props.onChange === 'function',
    )[0];
    await act(async () => {
      searchModeGroup.props.onChange({ target: { value: 'fuzzy' } });
    });
    await flushEffects();

    redisBackend.RedisScanKeys.mockReset();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [{ key: 'TmpProxy', type: 'string', ttl: -1 }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:TmpProfile', type: 'string', ttl: -1 }] },
      });

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('mpP');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.map((call) => call.slice(1))).toEqual([
      ['*[mM][pP][pP]*', '0', 600],
      ['*[mM][pP][pP]*', '27', 600],
    ]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2);

    redisBackend.RedisScanKeys.mockClear();
    redisBackend.RedisScanKeys
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '27', keys: [{ key: 'TmpProxy', type: 'string', ttl: -1 }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:TmpProfile', type: 'string', ttl: -1 }] },
      });
    await act(async () => {
      findButtonByText(renderer!, 'Refresh')!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls.map((call) => call.slice(1))).toEqual([
      ['*[mM][pP][pP]*', '0', 600],
      ['*[mM][pP][pP]*', '27', 600],
    ]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(2);

    renderer!.unmount();
  });

  it('keeps exact search continuation available after the first page', async () => {
    const firstPage = Array.from({ length: 600 }, (_, index) => ({
      key: `app:user:${index}`,
      type: 'string',
      ttl: -1,
    }));
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
        data: { cursor: '27', keys: firstPage },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:user:600', type: 'string', ttl: -1 }] },
      });

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
        data: { cursor: '27', keys: firstPage },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { cursor: '0', keys: [{ key: 'app:user:600', type: 'string', ttl: -1 }] },
      });

    const searchInput = renderer!.root.findAllByType('input')
      .find((node) => typeof node.props.onSearch === 'function');
    await act(async () => {
      searchInput!.props.onSearch('app:user');
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[0]?.slice(1)).toEqual(['app:user', '0', 600]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(600);
    const loadMoreButton = findButtonByText(renderer!, 'Load more');
    expect(loadMoreButton).toBeTruthy();
    await act(async () => {
      loadMoreButton!.props.onClick?.();
    });
    await flushEffects();

    expect(redisBackend.RedisScanKeys.mock.calls[1]?.slice(1)).toEqual(['app:user', '27', 1000]);
    expect(countLeafNodes(antdState.treeProps.treeData)).toBe(601);

    renderer!.unmount();
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
