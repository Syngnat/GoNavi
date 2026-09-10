import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Modal, type ModalFuncProps } from 'antd';
import { t } from '../i18n';

const storeState = {
  theme: 'light',
  languagePreference: 'zh-CN',
  setLanguagePreference: vi.fn(async (languagePreference: 'zh-CN' | 'en-US') => {
    storeState.languagePreference = languagePreference;
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage(languagePreference);
    notifyStoreSubscribers();
  }),
  appearance: { opacity: 1 },
};

const storeSubscribers = new Set<() => void>();
const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

const backendApp = {
  CheckDriverNetworkStatus: vi.fn(),
  DownloadDriverPackage: vi.fn(),
  GetDriverVersionList: vi.fn(),
  GetDriverVersionPackageSize: vi.fn(),
  GetDriverStatusList: vi.fn(),
  InstallLocalDriverPackage: vi.fn(),
  ListDriverDownloadTasks: vi.fn(),
  OpenDriverDownloadDirectory: vi.fn(),
  RemoveDriverPackage: vi.fn(),
  SelectDriverPackageDirectory: vi.fn(),
  SelectDriverPackageFile: vi.fn(),
  StartDriverPackageDownload: vi.fn(),
};

const textContent = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join('');
  return textContent(node.children || []);
};

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === 'button' && textContent(node).includes(text))[0];

const findInputByPlaceholder = (renderer: ReactTestRenderer, placeholder: string) =>
  renderer.root.findAll((node) => node.type === 'input' && node.props?.placeholder === placeholder)[0];

const buildNetworkStatusResult = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    reachable: true,
    summary: 'reachable',
    downloadChainReachable: true,
    downloadRequiredHosts: [],
    recommendedProxy: false,
    proxyConfigured: false,
    proxyEnv: {},
    checks: [],
    logPath: 'D:/logs/driver-network.log',
    ...overrides,
  },
});

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) =>
    React.useSyncExternalStore(
      (subscriber) => {
        storeSubscribers.add(subscriber);
        return () => {
          storeSubscribers.delete(subscriber);
        };
      },
      () => selector(storeState),
      () => selector(storeState),
    ),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('../../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => vi.fn()),
}));

vi.mock('../utils/driverManagerWorkbenchTheme', () => ({
  buildDriverManagerWorkbenchTheme: () => ({
    pageBg: '#fff',
    titleText: '#111',
    sectionBorder: '1px solid #eee',
    sectionBg: '#fff',
    statBorder: '1px solid #eee',
    statBg: '#fff',
    updateNoteBorder: '1px solid #eee',
    updateNoteBg: '#fff',
    cardWarningBorder: '1px solid #faad14',
    cardReadyBorder: '1px solid #52c41a',
    cardBorder: '1px solid #eee',
    cardBg: '#fff',
    warningText: '#faad14',
    isDark: false,
  }),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    AppstoreOutlined: Icon,
    CheckCircleOutlined: Icon,
    DeleteOutlined: Icon,
    DownOutlined: Icon,
    DownloadOutlined: Icon,
    FileSearchOutlined: Icon,
    FolderOpenOutlined: Icon,
    InfoCircleFilled: Icon,
    ReloadOutlined: Icon,
    StopOutlined: Icon,
    WarningOutlined: Icon,
  };
});

vi.mock('antd', () => {
  const Button = ({ children, disabled, loading, onClick, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...rest}>
      {children}
    </button>
  );
  const Dropdown: any = ({ children }: any) => <>{children}</>;
  Dropdown.Button = ({ children, disabled, loading, onClick, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...rest}>
      {children}
    </button>
  );

  const Modal: any = ({ title, children, footer, open }: any) =>
    open ? (
      <section>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </section>
    ) : null;
  Modal.confirm = vi.fn();

  const Collapse = ({ items }: any) => (
    <div>
      {items?.map((item: any) => (
        <div key={item.key}>
          <div>{item.label}</div>
          <div>{item.children}</div>
        </div>
      ))}
    </div>
  );

  const Input: any = ({ value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );
  Input.Search = ({ value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );

  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Switch = ({ checked, onChange, ...rest }: any) => (
    <button type="button" data-checked={checked} onClick={() => onChange?.(!checked)} {...rest}>
      switch
    </button>
  );
  const Progress = ({ percent }: any) => <div>{percent}</div>;
  const Select = ({ placeholder }: any) => <div>{placeholder}</div>;
  const Empty: any = ({ description }: any) => <div>{description}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = 'empty';
  const Alert = ({ message, description }: any) => (
    <div>
      <div>{message}</div>
      <div>{description}</div>
    </div>
  );

  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
    Paragraph: ({ children }: any) => <div>{children}</div>,
  };

  const message = {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  };
  const Tooltip = ({ children }: any) => <>{children}</>;
  const Popover = ({ children }: any) => <>{children}</>;

  return {
    Alert,
    Button,
    Collapse,
    Dropdown,
    Empty,
    Input,
    Modal,
    Popover,
    Progress,
    Select,
    Space,
    Switch,
    Tag,
    Tooltip,
    Typography,
    message,
  };
});

describe('DriverManagerModal i18n', () => {

  beforeEach(() => {
    vi.resetModules();
    storeState.theme = 'light';
    storeState.languagePreference = 'zh-CN';
    storeState.setLanguagePreference.mockClear();

    storeState.appearance.opacity = 1;
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'clickhouse',
            name: 'ClickHouse',
            builtIn: false,
            pinnedVersion: 'v1.2.3',
            installedVersion: 'v1.2.3',
            packageSizeText: '12 MB',
            runtimeAvailable: true,
            packageInstalled: true,
            connectable: true,
            installDir: 'D:/drivers/clickhouse',
            executablePath: 'D:/drivers/clickhouse/clickhouse-driver-agent.exe',
            message: 'HTTP 403 from GitHub release asset',
          },
        ],
      },
    });
    backendApp.CheckDriverNetworkStatus.mockResolvedValue({
      success: true,
      data: {
        reachable: true,
        summary: 'HTTP 403 from GitHub release asset',
        downloadChainReachable: true,
        downloadRequiredHosts: [],
        recommendedProxy: false,
        proxyConfigured: false,
        proxyEnv: {},
        checks: [
          {
            probeCode: 'download_mirror',
            name: 'GoNavi Mirror',
            url: 'https://download.syngnat.top/drivers/releases/latest/GoNavi-DriverAgents-Index.json',
            reachable: false,
            httpStatus: 403,
            error: 'HTTP 403',
          },
        ],
        logPath: 'D:/logs/driver-network.log',
      },
    });
    backendApp.GetDriverVersionList.mockResolvedValue({ success: true, data: { versions: [] } });
    backendApp.GetDriverVersionPackageSize.mockResolvedValue({ success: true, data: { packageSizeText: '12 MB' } });
    backendApp.DownloadDriverPackage.mockResolvedValue({ success: true });
    backendApp.InstallLocalDriverPackage.mockResolvedValue({ success: true });
    backendApp.ListDriverDownloadTasks.mockResolvedValue({ success: true, data: [] });
    backendApp.OpenDriverDownloadDirectory.mockResolvedValue({ success: true });
    backendApp.RemoveDriverPackage.mockResolvedValue({ success: true });
    backendApp.SelectDriverPackageDirectory.mockResolvedValue({ success: false, message: '已取消' });
    backendApp.SelectDriverPackageFile.mockResolvedValue({ success: false, message: '已取消' });
    backendApp.StartDriverPackageDownload.mockResolvedValue({ success: true, data: { task: null } });
  });

  it('updates visible copy when languagePreference changes while the modal stays open', async () => {
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    expect(textContent(renderer!.toJSON())).toContain('驱动管理');

    await act(async () => {
      await storeState.setLanguagePreference('en-US');
    });

    expect(storeState.setLanguagePreference).toHaveBeenCalledWith('en-US');
    expect(textContent(renderer!.toJSON())).toContain('Driver Manager');
    expect(textContent(renderer!.toJSON())).not.toContain('驱动管理');
  });

  it.each([
    ['zh-CN', '驱动管理', '安装所有驱动', '搜索驱动名称/类型（如 DuckDB、clickhouse）', '日志', '安装目录：', '驱动可执行文件：', '当前驱动暂无操作日志。'],
    ['en-US', 'Driver Manager', 'Install all drivers', 'Search driver name/type (for example DuckDB, clickhouse)', 'Logs', 'Install directory:', 'Driver executable:', 'This driver has no operation logs yet.'],
  ] as const)(
    'renders localized chrome and preserves raw network summary for %s',
    async (language, titleText, toolbarText, searchText, logLabelText, logInstallDirText, logExecutableText, emptyLogText) => {

      const { setCurrentLanguage } = await import('../i18n');
      setCurrentLanguage(language);
      const { default: DriverManagerModal } = await import('./DriverManagerModal');

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      });

      expect(textContent(renderer!.toJSON())).toContain(titleText);
      expect(textContent(renderer!.toJSON())).toContain(toolbarText);
      expect(findInputByPlaceholder(renderer!, searchText)).toBeTruthy();
      expect(textContent(renderer!.toJSON())).toContain('HTTP 403 from GitHub release asset');

      const logSection = renderer!.root.findByProps({ className: 'driver-manager-log-section' });
      expect(textContent(logSection)).toContain(logLabelText);
      expect(textContent(logSection)).toContain(emptyLogText);
      expect(textContent(renderer!.toJSON())).toContain(logInstallDirText);
      expect(textContent(renderer!.toJSON())).toContain(logExecutableText);
    },
  );

  it('renders the driver manager body in German without falling back to Simplified Chinese', async () => {

    storeState.languagePreference = 'de-DE';
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('de-DE');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('Treiberverwaltung');
    expect(content).toContain('Alle Treiber installieren');
    expect(renderer!.root.findAll((node) => (
      node.type === 'input'
      && String(node.props?.placeholder || '').includes('Treibername/-typ suchen')
    ))).toHaveLength(1);
    expect(content).toContain('Größe: 12 MB');
    expect(content).not.toMatch(/驱动管理|安装所有驱动|搜索驱动|已启用|未启用/);
  });

  it.each([
    ['zh-CN', '暂无驱动数据'],
    ['en-US', 'No drivers available'],
  ] as const)('renders localized empty state for %s', async (language, emptyText) => {

    backendApp.GetDriverStatusList.mockResolvedValueOnce({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [],
      },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage(language);
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    expect(textContent(renderer!.toJSON())).toContain(emptyText);
  });

  it('renders localized card metadata and actions for en-US v2 while preserving raw driver detail', async () => {

    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('Size: 12 MB');
    expect(content).toContain('v1.2.3 · 12 MB');
    expect(content).toContain('Driver version');
    expect(content).not.toContain('Status progress');
    expect(content).toContain('Enabled');
    expect(content).not.toContain('v1.2.3 (installed)');
    expect(findButton(renderer!, 'Remove')).toBeTruthy();
    expect(content).toContain('HTTP 403 from GitHub release asset');
  });

  it('renders en-US driver card status shell without exposing backend Chinese wrappers', async () => {

    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'clickhouse',
            name: 'ClickHouse',
            builtIn: false,
            pinnedVersion: 'v2.0.0',
            installedVersion: 'v1.0.0',
            packageSizeText: '12 MB',
            runtimeAvailable: true,
            packageInstalled: true,
            connectable: true,
            needsUpdate: true,
            affectedConnections: 3,
            agentRevision: 'rev-old',
            expectedRevision: 'rev-new',
            updateReason: '驱动代理需要重装后才能应用当前版本的驱动侧更新',
            message: 'raw runtime reason: checksum mismatch abc123',
          },
        ],
      },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    const titleRow = renderer!.root.findByProps({ className: 'driver-manager-title-row' });
    const updateNote = renderer!.root.findByProps({ className: 'driver-manager-update-note' });
    expect(textContent(titleRow)).toContain('Reinstall needed');
    expect(updateNote.findAll((node) => node.type === 'span' && textContent(node) === 'Reinstall required')).toHaveLength(0);
    expect(content).toContain('The driver component has an update.');
    expect(content).toContain('Affects 3 saved connections');
    expect(content).not.toContain('installed revision rev-old');
    expect(content).not.toContain('expected revision rev-new');
    expect(content).toContain('raw runtime reason: checksum mismatch abc123');
    expect(content).not.toContain('驱动代理需要重装');
  });

  it('requires confirmation before reinstalling a driver with active connections', async () => {
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'sqlserver',
            name: 'SQL Server',
            builtIn: false,
            pinnedVersion: 'v1.9.6',
            installedVersion: 'v1.9.5',
            runtimeAvailable: true,
            packageInstalled: true,
            connectable: true,
            needsUpdate: true,
            activeConnections: 2,
            installDir: 'D:/drivers/sqlserver',
            executablePath: 'D:/drivers/sqlserver/sqlserver-driver-agent.exe',
          },
        ],
      },
    });
    const confirmMock = vi.mocked(Modal.confirm);
    confirmMock.mockReset();
    confirmMock.mockReturnValue({ update: vi.fn(), destroy: vi.fn() } as any);
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('zh-CN');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findButton(renderer!, '重装驱动').props.onClick();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(backendApp.StartDriverPackageDownload).not.toHaveBeenCalled();
    const confirm = confirmMock.mock.calls[0][0] as ModalFuncProps;
    expect(confirm.title).toBe('关闭正在使用的驱动并重装？');
    expect(confirm.content).toBe(
      '检测到该驱动有 2 个活动连接。继续重装会自动断开这些连接、终止正在执行的查询，并回滚尚未提交的事务；已保存的连接配置不会删除，重装后需要重新连接。',
    );

    await act(async () => {
      await confirm.onOk?.();
    });

    expect(backendApp.StartDriverPackageDownload).toHaveBeenCalledTimes(1);
    expect(backendApp.StartDriverPackageDownload).toHaveBeenCalledWith(
      'sqlserver',
      'v1.9.6',
      '',
      'D:/drivers',
    );
  });

  it('renders en-US network summary from structured fields instead of backend Chinese summary', async () => {

    backendApp.CheckDriverNetworkStatus.mockResolvedValueOnce({
      success: true,
      data: {
        reachable: true,
        summary: '驱动下载网络检测通过，可直接安装驱动',
        downloadChainReachable: true,
        downloadRequiredHosts: [],
        recommendedProxy: false,
        proxyConfigured: false,
        proxyEnv: {},
        checks: [
          {
            probeCode: 'download_mirror',
            name: 'GoNavi Mirror',
            url: 'https://download.syngnat.top/drivers/releases/latest/GoNavi-DriverAgents-Index.json',
            reachable: true,
            httpStatus: 200,
            httpLatencyMs: 88,
            error: 'HTTP 200',
          },
        ],
        logPath: 'D:/logs/driver-network.log',
      },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('Driver download network is available. You can install drivers directly.');
    expect(content).toContain('reachable, 88ms, HTTP 200');
    expect(content).not.toContain('驱动下载网络检测通过');
  });

  it('renders checking copy while the network status request is pending', async () => {

    backendApp.CheckDriverNetworkStatus.mockImplementationOnce(() => new Promise(() => {}));
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      await Promise.resolve();
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('Checking driver download network...');
    expect(content).not.toContain('Network check has not completed');
  });

  it('shows the status loading state without a false zero-driver empty result', async () => {

    let resolveStatus!: (value: unknown) => void;
    let resolveNetwork!: (value: unknown) => void;
    backendApp.GetDriverStatusList.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    backendApp.CheckDriverNetworkStatus.mockImplementation(() => new Promise((resolve) => {
      resolveNetwork = resolve;
    }));
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      await Promise.resolve();
    });

    const loadingContent = textContent(renderer!.toJSON());
    expect(loadingContent).toContain('Refreshing status...');
    expect(loadingContent).toContain('Checking driver download network...');
    expect(loadingContent).not.toContain('0 drivers total');
    expect(loadingContent).not.toContain('No drivers available');

    await act(async () => {
      resolveStatus({
        success: true,
        data: {
          downloadDir: 'D:/drivers',
          drivers: [
            {
              type: 'clickhouse',
              name: 'ClickHouse',
              builtIn: false,
              pinnedVersion: 'v1.2.3',
              runtimeAvailable: false,
              packageInstalled: false,
              connectable: false,
            },
          ],
        },
      });
      await Promise.resolve();
    });

    const statusLoadedContent = textContent(renderer!.toJSON());
    expect(statusLoadedContent).toContain('ClickHouse');
    expect(statusLoadedContent).toContain('Total1');
    expect(statusLoadedContent).not.toContain('Refreshing status...');
    expect(statusLoadedContent).toContain('Checking driver download network...');

    await act(async () => {
      resolveNetwork(buildNetworkStatusResult());
      await Promise.resolve();
    });
  });

  it('deduplicates concurrent cold status requests across driver manager instances', async () => {
    let resolveStatus!: (value: unknown) => void;
    backendApp.GetDriverStatusList.mockClear();
    backendApp.GetDriverStatusList.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <>
          <DriverManagerModal open onClose={vi.fn()} />
          <DriverManagerModal open onClose={vi.fn()} />
        </>,
      );
      await Promise.resolve();
    });

    expect(backendApp.GetDriverStatusList).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStatus({ success: true, data: { downloadDir: 'D:/drivers', drivers: [] } });
      await Promise.resolve();
    });
    renderer!.unmount();
  });

  it.each([
    [
      'reachable_with_proxy',
      buildNetworkStatusResult({
        reachable: true,
        proxyConfigured: true,
        proxyEnv: {
          HTTPS_PROXY: 'http://127.0.0.1:7890',
        },
      }),
      'Driver download network is available through the configured proxy.',
      'Driver download network is available. You can install drivers directly.',
    ],
    [
      'mirror_fallback_available',
      buildNetworkStatusResult({
        reachable: true,
        mirrorReachable: false,
        fallbackChecked: true,
        fallbackReachable: true,
        usingFallback: true,
      }),
      'The GoNavi mirror is unavailable, but the GitHub fallback is available. Driver installation can continue.',
      'Driver download network is available. You can install drivers directly.',
    ],
    [
      'unreachable_proxy_configured',
      buildNetworkStatusResult({
        reachable: false,
        summary: 'proxy unreachable',
        proxyConfigured: true,
      }),
      'Some driver download endpoints are unreachable. Check that the configured proxy is working and retry.',
      'Configure an HTTP/HTTPS/SOCKS5 proxy before installing drivers.',
    ],
    [
      'proxy_recommended',
      buildNetworkStatusResult({
        reachable: false,
        summary: 'proxy recommended',
        recommendedProxy: true,
      }),
      'Some driver download endpoints are unreachable. Configure an HTTP/HTTPS/SOCKS5 proxy before installing drivers.',
      'Check that the configured proxy is working and retry.',
    ],
    [
      'unreachable',
      buildNetworkStatusResult({
        reachable: false,
        summary: 'network unreachable',
      }),
      'Some driver download endpoints are unreachable. Check your network and retry.',
      'Configure an HTTP/HTTPS/SOCKS5 proxy before installing drivers.',
    ],
  ] as const)(
    'renders en-US network summary branch %s from structured status',
    async (_caseName, networkResult, expectedText, unexpectedText) => {

      backendApp.CheckDriverNetworkStatus.mockResolvedValueOnce(networkResult);
      const { setCurrentLanguage } = await import('../i18n');
      setCurrentLanguage('en-US');
      const { default: DriverManagerModal } = await import('./DriverManagerModal');

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
      });

      const content = textContent(renderer!.toJSON());
      expect(content).toContain(expectedText);
      expect(content).not.toContain(unexpectedText);
    },
  );

  it('renders en-US mirror network details while preserving raw error text', async () => {

    backendApp.CheckDriverNetworkStatus.mockResolvedValueOnce({
      success: true,
      data: {
        reachable: true,
        summary: 'reachable',
        downloadChainReachable: true,
        downloadRequiredHosts: ['download.syngnat.top'],
        recommendedProxy: false,
        proxyConfigured: true,
        proxyEnv: {
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
        },
        checks: [
          {
            probeCode: 'download_mirror',
            name: 'GoNavi Mirror',
            url: 'https://download.syngnat.top/drivers/releases/latest/GoNavi-DriverAgents-Index.json',
            reachable: true,
            httpStatus: 403,
            httpLatencyMs: 123,
            error: 'HTTP 403',
          },
        ],
        logPath: 'D:/logs/driver-network.log',
      },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('Detected proxy environment variables: HTTP_PROXY, HTTPS_PROXY');
    expect(content).toContain('reachable, 123ms, HTTP 403');
    expect(content).toContain('HTTP 403');
    expect(content).not.toContain('HTTP_PROXY、HTTPS_PROXY');
    expect(content).not.toContain('reachable，123ms，HTTP 403');

    backendApp.CheckDriverNetworkStatus.mockResolvedValueOnce({
      success: true,
      data: {
        reachable: false,
        summary: 'download chain blocked',
        downloadChainReachable: false,
        downloadRequiredHosts: ['download.syngnat.top'],
        recommendedProxy: true,
        proxyConfigured: true,
        proxyEnv: {},
        checks: [],
        logPath: 'D:/logs/driver-network.log',
      },
    });

    await act(async () => {
      findButton(renderer!, 'Network check').props.onClick();
    });

    const unreachableContent = textContent(renderer!.toJSON());
    expect(unreachableContent).toContain('allow these hosts in the proxy rules: download.syngnat.top.');
  });

  it('uses structured slim-build reason code instead of raw Chinese message when importing a directory', async () => {

    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'clickhouse',
            name: 'ClickHouse',
            builtIn: false,
            pinnedVersion: 'v1.2.3',
            runtimeAvailable: false,
            packageInstalled: false,
            connectable: false,
            reasonCode: 'slim_build_missing_driver',
            message: 'ClickHouse is unavailable in this slim build',
          },
        ],
      },
    });
    backendApp.SelectDriverPackageDirectory.mockResolvedValue({
      success: true,
      data: { path: 'D:/manual/drivers' },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findButton(renderer!, 'Import driver directory').props.onClick();
    });

    expect(backendApp.InstallLocalDriverPackage).not.toHaveBeenCalled();
    expect(textContent(renderer!.toJSON())).toContain('ClickHouse is unavailable in this slim build');
  });

  it('uses structured probe codes for mirror and fallback details', async () => {

    backendApp.CheckDriverNetworkStatus.mockResolvedValueOnce({
      success: true,
      data: {
        reachable: true,
        summary: 'fallback available',
        mirrorReachable: false,
        fallbackChecked: true,
        fallbackReachable: true,
        usingFallback: true,
        downloadChainReachable: true,
        downloadRequiredHosts: ['github.com', 'release-assets.githubusercontent.com'],
        recommendedProxy: false,
        proxyConfigured: false,
        proxyEnv: {},
        checks: [
          {
            probeCode: 'download_mirror',
            name: '原始镜像名称',
            url: 'https://download.syngnat.top/drivers/releases/latest/GoNavi-DriverAgents-Index.json',
            reachable: false,
            httpStatus: 403,
            httpLatencyMs: 321,
            error: 'HTTP 403',
          },
          {
            probeCode: 'github_release',
            name: '原始 GitHub 名称',
            url: 'https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents.zip',
            reachable: true,
            httpStatus: 200,
            httpLatencyMs: 456,
          },
        ],
        logPath: 'D:/logs/driver-network.log',
      },
    });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    const content = textContent(renderer!.toJSON());
    expect(content).toContain('GoNavi mirror connectivity: unreachable, 321ms, HTTP 403');
    expect(content).toContain('GitHub driver release connectivity: reachable, 456ms');
    expect(content).not.toContain('原始镜像名称');
    expect(content).not.toContain('原始 GitHub 名称');
  });

  it('renders en-US frontend-generated operation log shell while preserving raw local import details', async () => {

    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        downloadDir: 'D:/drivers',
        drivers: [
          {
            type: 'clickhouse',
            name: 'ClickHouse',
            builtIn: false,
            pinnedVersion: 'v9.8.7',
            installedVersion: '',
            packageSizeText: '12 MB',
            runtimeAvailable: false,
            packageInstalled: false,
            connectable: false,
            installDir: 'D:/drivers/clickhouse',
            executablePath: 'D:/drivers/clickhouse/clickhouse-driver-agent.exe',
            message: 'HTTP 403 from GitHub release asset',
          },
        ],
      },
    });
    backendApp.SelectDriverPackageFile.mockResolvedValue({
      success: true,
      data: { path: 'D:/manual/GoNavi-DriverAgents.zip' },
    });
    backendApp.InstallLocalDriverPackage.mockResolvedValueOnce({
      success: false,
      message: 'raw system unzip error: HTTP 500',
    }).mockResolvedValueOnce({ success: true });
    const { setCurrentLanguage } = await import('../i18n');
    setCurrentLanguage('en-US');
    const { default: DriverManagerModal } = await import('./DriverManagerModal');

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DriverManagerModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findButton(renderer!, t('driver_manager.action.import_package')).props.onClick();
    });
    await act(async () => {
      findButton(renderer!, t('driver_manager.action.import_package')).props.onClick();
    });

    const content = textContent(renderer!.toJSON());
    const logSection = textContent(renderer!.root.findByProps({ className: 'driver-manager-log-section' }));
    expect(logSection).toContain('Starting local import (v9.8.7) (file): D:/manual/GoNavi-DriverAgents.zip');
    expect(logSection).toContain('raw system unzip error: HTTP 500');
    expect(logSection).toContain('Local import installation completed (v9.8.7)');
    expect(logSection).not.toContain('[ERROR]');
    expect(logSection).not.toContain('[START]');
    expect(logSection).not.toContain('[DONE]');
    expect(content).not.toContain('开始本地导入');
    expect(content).not.toContain('本地导入安装完成');
  });
});
