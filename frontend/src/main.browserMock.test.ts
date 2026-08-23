import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./App', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mock-app' }),
}));

let renderRootImpl: ((node: React.ReactNode) => void) | null = null;

const createRootMock = vi.fn(() => ({
  render: vi.fn((node: React.ReactNode) => {
    renderRootImpl?.(node);
  }),
}));

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: createRootMock,
  },
  createRoot: createRootMock,
}));

const dayjsLocaleMock = vi.fn();

vi.mock('dayjs', () => ({
  default: Object.assign(() => null, {
    locale: dayjsLocaleMock,
  }),
}));

vi.mock('dayjs/locale/zh-cn', () => ({}));
vi.mock('dayjs/locale/zh-tw', () => ({}));
vi.mock('dayjs/locale/ja', () => ({}));
vi.mock('dayjs/locale/de', () => ({}));
vi.mock('dayjs/locale/ru', () => ({}));

const loaderConfigMock = vi.fn();

vi.mock('@monaco-editor/react', () => ({
  loader: {
    config: loaderConfigMock,
  },
}));

const defineThemeMock = vi.fn();

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: defineThemeMock,
  },
}));

vi.mock('monaco-editor/esm/nls.messages.zh-cn', () => ({}));

const syncLanguageRuntimeMock = vi.fn(async (_language: string) => undefined);

vi.mock('./i18n/runtime', async () => {
  const actual = await vi.importActual<typeof import('./i18n/runtime')>('./i18n/runtime');
  return {
    ...actual,
    syncLanguageRuntime: (language: string) => syncLanguageRuntimeMock(language),
  };
});

const importMain = async () => {
  await import('./main');
  return (globalThis as typeof globalThis & {
    window: {
      go?: {
        app?: {
          App?: {
            ImportConfigFile: () => Promise<{ success: boolean; message?: string }>;
            ImportConnectionsPayload: (raw: string, password?: string) => Promise<unknown>;
            ExportConnectionsPackage: (options?: { includeSecrets?: boolean; filePassword?: string }) => Promise<{ success: boolean; message?: string }>;
            ApplyDataRootDirectory: (path: string) => Promise<{ success: boolean; message?: string; data?: { path?: string } }>;
            ApplyLogDirectory: (path: string) => Promise<{ success: boolean; message?: string; data?: { logDirectory?: string; logDirectoryRestartRequired?: boolean } }>;
            ApplySavedQueryDirectory: (path: string) => Promise<{ success: boolean; message?: string; data?: { savedQueryDirectory?: string; savedQueryDirectorySource?: string } }>;
            SaveQuery: (input: { id?: string; name?: string; sql?: string }) => Promise<{ name: string; sql: string }>;
            RenameSavedQuery: (id: string, name: string) => Promise<{ id: string; name: string; sql: string }>;
            RevealSavedQueryInFolder: (id: string) => Promise<{ success: boolean; message?: string; data?: { path?: string } }>;
            CheckForUpdates: () => Promise<{ success: boolean; data?: Record<string, unknown> }>;
            CheckForUpdatesSilently: () => Promise<{ success: boolean; data?: Record<string, unknown> }>;
            SetUpdateChannel: (channel: string) => Promise<{ success: boolean; data?: { channel?: string } }>;
            SaveConnection: (input: Record<string, unknown>) => Promise<any>;
            GetEditableSavedConnection: (id: string) => Promise<any>;
            RevealSavedConnectionPrimaryPassword: (id: string) => Promise<string>;
            DeleteConnection: (id: string) => Promise<null>;
            DuplicateConnection: (id: string) => Promise<any>;
          };
        };
      };
    };
  }).window.go?.app?.App;
};

describe('main browser mock', () => {
  beforeEach(() => {
    vi.resetModules();
    renderRootImpl = null;
    syncLanguageRuntimeMock.mockClear();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => ({})),
    });
    vi.stubGlobal('navigator', {
      languages: ['zh-CN'],
      language: 'zh-CN',
    });
  });

  afterEach(() => {
    vi.doUnmock('./store');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns localized browser-mode messages for import picker and unsupported browser mock exports', async () => {
    const app = await importMain();
    const { t } = await import('./i18n');

    expect(app).toBeDefined();
    await expect(app!.ImportConfigFile()).resolves.toEqual({
      success: false,
      message: '已取消',
    });
    await expect(app!.ExportSQLFile('demo.sql', 'select 1')).resolves.toEqual({
      success: false,
      message: t('app.browser_mock.export_sql_unsupported'),
    });
    await expect(app!.ExportConnectionsPackage({ includeSecrets: true, filePassword: '' })).resolves.toEqual({
      success: false,
      message: t('app.browser_mock.export_connection_package_unsupported'),
    });
  }, 30000);

  it('includes release metadata in browser mock update checks', async () => {
    const app = await importMain();

    await expect(app!.CheckForUpdates()).resolves.toMatchObject({
      success: true,
      data: {
        channel: 'latest',
        releaseName: 'Browser Mock Release',
        releasePublishedAt: '2026-07-08T11:15:00Z',
        releaseNotesUrl: 'https://github.com/Syngnat/GoNavi/releases/latest',
      },
    });

    await expect(app!.SetUpdateChannel('dev')).resolves.toMatchObject({
      success: true,
      data: { channel: 'dev' },
    });
    await expect(app!.CheckForUpdatesSilently()).resolves.toMatchObject({
      success: true,
      data: {
        channel: 'dev',
        releaseName: 'Dev Build (dev-browser-mock)',
        releasePublishedAt: '2026-07-08T11:15:00Z',
        releaseNotesUrl: 'https://github.com/Syngnat/GoNavi/releases/tag/dev-latest',
      },
    });
  });

  it('rejects non-array payloads with the localized browser mock import limitation', async () => {
    const app = await importMain();
    const { t } = await import('./i18n');

    await expect(app!.ImportConnectionsPayload('{"version":1}')).rejects.toThrow(
      t('app.browser_mock.import_connection_package_unsupported'),
    );
  });

  it('reveals saved host passwords on demand without exposing them in editable connection metadata', async () => {
    const app = await importMain();
    const saved = await app!.SaveConnection({
      id: 'browser-mock-password',
      name: 'Password host',
      config: {
        id: 'browser-mock-password',
        type: 'mysql',
        host: 'db.local',
        port: 3306,
        user: 'root',
        password: 'primary-secret',
      },
    });

    await expect(app!.GetEditableSavedConnection(saved.id)).resolves.toMatchObject({
      config: { password: '' },
      hasPrimaryPassword: true,
    });
    await expect(app!.RevealSavedConnectionPrimaryPassword(saved.id)).resolves.toBe('primary-secret');

    const duplicated = await app!.DuplicateConnection(saved.id);
    await expect(app!.RevealSavedConnectionPrimaryPassword(duplicated.id)).resolves.toBe('primary-secret');

    await app!.SaveConnection({
      ...saved,
      name: 'Renamed host',
      config: { ...saved.config, password: '' },
    });
    await expect(app!.RevealSavedConnectionPrimaryPassword(saved.id)).resolves.toBe('primary-secret');

    await app!.SaveConnection({
      ...saved,
      config: { ...saved.config, password: '' },
      clearPrimaryPassword: true,
    });
    await expect(app!.RevealSavedConnectionPrimaryPassword(saved.id)).rejects.toThrow('no stored primary password');

    await app!.SaveConnection({
      ...saved,
      config: { ...saved.config, password: 'must-not-survive-delete' },
    });
    await app!.DeleteConnection(saved.id);
    await expect(app!.RevealSavedConnectionPrimaryPassword(saved.id)).rejects.toThrow('saved connection not found');

    const recreated = await app!.SaveConnection({
      id: saved.id,
      name: 'Recreated without password',
      config: { ...saved.config, password: '' },
    });
    expect(recreated.hasPrimaryPassword).toBe(false);
    await expect(app!.RevealSavedConnectionPrimaryPassword(saved.id)).rejects.toThrow('no stored primary password');
  }, 30000);

  it('localizes generated browser mock saved query names', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    const app = await importMain();

    await expect(app!.SaveQuery({
      id: 'browser-mock-generated-query',
      sql: 'select 1',
    })).resolves.toEqual(expect.objectContaining({
      name: 'Query 1',
      sql: 'select 1',
    }));
  });

  it('localizes browser mock MCP HTTP server status messages', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    await importMain();
    const { t } = await import('./i18n');
    const service = (globalThis as any).window.go.aiservice.Service;

    await expect(service.AIGetMCPHTTPServerStatus()).resolves.toEqual(expect.objectContaining({
      enabled: false,
      message: t('app.browser_mock.mcp_http.not_running'),
    }));
    await expect(service.AIStartMCPHTTPServer({ addr: '127.0.0.1:8765', path: '/mcp', schemaOnly: false })).resolves.toEqual(expect.objectContaining({
      enabled: true,
      schemaOnly: false,
      message: t('app.browser_mock.mcp_http.started'),
    }));
    await expect(service.AIStopMCPHTTPServer()).resolves.toEqual(expect.objectContaining({
      enabled: false,
      message: t('app.browser_mock.mcp_http.stopped'),
    }));
  });

  it('localizes browser mock data root update messages', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    const app = await importMain();
    const { t } = await import('./i18n');

    await expect(app!.ApplyDataRootDirectory('C:/mock/custom-root')).resolves.toEqual(expect.objectContaining({
      success: true,
      message: t('app.data_root.message.updated'),
      data: expect.objectContaining({
        path: 'C:/mock/custom-root',
      }),
    }));
  });

  it('keeps browser mock log directory state available for the data-root page', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    const app = await importMain();
    const { t } = await import('./i18n');

    await expect(app!.ApplyLogDirectory('C:/mock/custom-logs')).resolves.toEqual(expect.objectContaining({
      success: true,
      message: t('app.data_root.log_directory.message.updated'),
      data: expect.objectContaining({
        logDirectory: 'C:/mock/custom-logs',
        logDirectoryRestartRequired: true,
      }),
    }));
  });

  it('keeps browser mock saved query directory state available for the data-root page', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    const app = await importMain();
    const { t } = await import('./i18n');

    await expect(app!.ApplySavedQueryDirectory('C:/mock/custom-saved-queries')).resolves.toEqual(expect.objectContaining({
      success: true,
      message: t('app.data_root.saved_query_directory.message.updated'),
      data: expect.objectContaining({
        savedQueryDirectory: 'C:/mock/custom-saved-queries',
        savedQueryDirectorySource: 'custom',
      }),
    }));
  });

  it('renames browser mock saved queries without replacing their SQL', async () => {
    const app = await importMain();
    const saved = await app!.SaveQuery({
      id: 'browser-mock-rename-query',
      name: 'Before',
      sql: 'select 42',
    });

    await expect(app!.RenameSavedQuery('browser-mock-rename-query', 'After')).resolves.toEqual(expect.objectContaining({
      id: 'browser-mock-rename-query',
      name: 'After',
      sql: saved.sql,
    }));
  });

  it('reveals browser mock saved query files in their configured directory', async () => {
    const app = await importMain();
    await app!.SaveQuery({
      id: 'browser-mock-reveal-query',
      name: 'Reveal',
      sql: 'select 7',
    });

    await expect(app!.RevealSavedQueryInFolder('browser-mock-reveal-query')).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        path: 'C:/mock/.gonavi/saved_queries/browser-mock-reveal-query.sql',
      }),
    }));
  });

  it('localizes browser mock MCP server test messages', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    await importMain();
    const { t } = await import('./i18n');
    const service = (globalThis as any).window.go.aiservice.Service;

    await expect(service.AITestMCPServer({ command: 'node' })).resolves.toEqual(expect.objectContaining({
      success: true,
      message: t('app.browser_mock.mcp_server.test_success'),
    }));
    await expect(service.AITestMCPServer({ command: '   ' })).resolves.toEqual(expect.objectContaining({
      success: false,
      message: t('app.browser_mock.mcp_server.command_required'),
    }));
  });

  it('localizes browser mock MCP tool call unavailable content', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    await importMain();
    const { t } = await import('./i18n');
    const service = (globalThis as any).window.go.aiservice.Service;

    await expect(service.AICallMCPTool('demo.tool', '{"x":1}')).resolves.toEqual(expect.objectContaining({
      alias: 'demo.tool',
      originalName: 'demo.tool',
      content: t('app.browser_mock.mcp_tool.unavailable'),
      isError: true,
    }));
  });

  it('localizes browser mock provider test messages', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    await importMain();
    const { t } = await import('./i18n');
    const service = (globalThis as any).window.go.aiservice.Service;

    await expect(service.AITestProvider({ apiKey: 'sk-demo' })).resolves.toEqual(expect.objectContaining({
      success: true,
      message: t('app.browser_mock.provider.test_success'),
    }));
    await expect(service.AITestProvider({ apiKey: '   ' })).resolves.toEqual(expect.objectContaining({
      success: false,
      message: t('app.browser_mock.provider.test_failed_detail', { detail: 'missing api key' }),
    }));
  });

  it('localizes browser mock MCP client status and blocks writes for undetected local clients', async () => {
    vi.stubGlobal('navigator', {
      languages: ['en-US'],
      language: 'en-US',
    });

    await importMain();
    const { t } = await import('./i18n');
    const service = (globalThis as any).window.go.aiservice.Service;

    await expect(service.AIGetMCPClientInstallStatuses()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        client: 'claude-code',
        message: t('app.browser_mock.mcp_client.claude_code.not_detected'),
      }),
      expect.objectContaining({
        client: 'codex',
        message: t('app.browser_mock.mcp_client.codex.path_mismatch'),
      }),
      expect.objectContaining({
        client: 'opencode',
        message: t('app.browser_mock.mcp_client.opencode.not_detected'),
      }),
      expect.objectContaining({
        client: 'zcode',
        message: t('ai_chat.mcp_client.install.summary.missing', { label: 'ZCode' }),
      }),
      expect.objectContaining({
        client: 'deepseek-harness',
        message: t('ai_chat.mcp_client.install.summary.missing', { label: 'DeepSeek Harness' }),
      }),
      expect.objectContaining({
        client: 'kimi',
        message: t('ai_chat.mcp_client.install.summary.missing', { label: 'Kimi Code' }),
      }),
      expect.objectContaining({
        client: 'grok-build',
        message: t('ai_chat.mcp_client.install.summary.missing', { label: 'Grok Build' }),
      }),
    ]));

    await expect(service.AIInstallClaudeCodeMCP()).rejects.toThrow(t('ai.service.mcp_client.local_client_not_detected', {
      label: 'Claude Code',
      command: 'claude',
    }));
    await expect(service.AIInstallCodexMCP()).resolves.toEqual(expect.objectContaining({
      client: 'codex',
      message: t('app.browser_mock.mcp_client.codex.installed'),
    }));
    await expect(service.AIInstallOpenCodeMCP()).rejects.toThrow(t('ai.service.mcp_client.local_client_not_detected', {
      label: 'OpenCode',
      command: 'opencode',
    }));
    for (const [method, label, command] of [
      ['AIInstallZCodeMCP', 'ZCode', 'zcode'],
      ['AIInstallDeepSeekHarnessMCP', 'DeepSeek Harness', 'dsh'],
      ['AIInstallKimiMCP', 'Kimi Code', 'kimi'],
      ['AIInstallGrokBuildMCP', 'Grok Build', 'grok'],
    ]) {
      await expect(service[method]()).rejects.toThrow(t('ai.service.mcp_client.local_client_not_detected', { label, command }));
    }
    await expect(service.AIGetMCPClientInstallStatuses()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        client: 'codex',
        installed: true,
        message: t('app.browser_mock.mcp_client.codex.installed'),
      }),
      expect.objectContaining({
        client: 'deepseek-harness',
        installed: false,
        clientDetected: false,
      }),
    ]));
  });

  it('waits for store hydration before syncing an explicit persisted language over a different system language', async () => {
    let languagePreference = 'system';
    let hydrated = false;
    const storeListeners = new Set<VoidFunction>();
    const hydrationListeners = new Set<VoidFunction>();
    const setLanguagePreference = vi.fn((nextPreference: string) => {
      languagePreference = nextPreference;
      storeListeners.forEach((listener) => listener());
    });
    const finishHydration = (nextPreference: string) => {
      hydrated = true;
      languagePreference = nextPreference;
      storeListeners.forEach((listener) => listener());
      hydrationListeners.forEach((listener) => listener());
    };

    vi.doMock('./store', () => ({
      useStore: Object.assign(
        <T,>(selector: (state: { languagePreference: string; setLanguagePreference: (nextPreference: string) => void }) => T): T =>
          React.useSyncExternalStore(
            (listener) => {
              storeListeners.add(listener);
              return () => storeListeners.delete(listener);
            },
            () => selector({ languagePreference, setLanguagePreference }),
            () => selector({ languagePreference, setLanguagePreference }),
          ),
        {
          persist: {
            hasHydrated: () => hydrated,
            onFinishHydration: (listener: VoidFunction) => {
              hydrationListeners.add(listener);
              return () => hydrationListeners.delete(listener);
            },
          },
        },
      ),
    }));

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    renderRootImpl = (node) => {
      act(() => {
        renderer = TestRenderer.create(node as React.ReactElement);
      });
    };

    await importMain();
    const { getCurrentLanguage } = await import('./i18n');

    expect(renderer).not.toBeNull();
    expect(getCurrentLanguage()).toBe('en-US');
    expect(syncLanguageRuntimeMock).not.toHaveBeenCalled();

    act(() => {
      finishHydration('ja-JP');
    });

    expect(getCurrentLanguage()).toBe('ja-JP');
    expect(syncLanguageRuntimeMock.mock.calls.map(([language]) => language)).toEqual(['ja-JP']);
  });

  it('applies the resolved runtime locale on the first visible frame after hydration', async () => {
    let languagePreference = 'system';
    let hydrated = false;
    const storeListeners = new Set<VoidFunction>();
    const hydrationListeners = new Set<VoidFunction>();
    const setLanguagePreference = vi.fn((nextPreference: string) => {
      languagePreference = nextPreference;
      storeListeners.forEach((listener) => listener());
    });
    const finishHydration = (nextPreference: string) => {
      hydrated = true;
      languagePreference = nextPreference;
      storeListeners.forEach((listener) => listener());
      hydrationListeners.forEach((listener) => listener());
    };

    vi.doMock('./store', () => ({
      useStore: Object.assign(
        <T,>(selector: (state: { languagePreference: string; setLanguagePreference: (nextPreference: string) => void }) => T): T =>
          React.useSyncExternalStore(
            (listener) => {
              storeListeners.add(listener);
              return () => storeListeners.delete(listener);
            },
            () => selector({ languagePreference, setLanguagePreference }),
            () => selector({ languagePreference, setLanguagePreference }),
          ),
        {
          persist: {
            hasHydrated: () => hydrated,
            onFinishHydration: (listener: VoidFunction) => {
              hydrationListeners.add(listener);
              return () => hydrationListeners.delete(listener);
            },
          },
        },
      ),
    }));

    renderRootImpl = (node) => {
      act(() => {
        TestRenderer.create(node as React.ReactElement);
      });
    };

    await importMain();
    const { getCurrentLanguage } = await import('./i18n');

    dayjsLocaleMock.mockClear();

    act(() => {
      finishHydration('ja-JP');
    });

    expect(getCurrentLanguage()).toBe('ja-JP');
    expect(dayjsLocaleMock).toHaveBeenCalledWith('ja');
    expect(syncLanguageRuntimeMock.mock.calls.map(([language]) => language)).toEqual(['ja-JP']);
  });

  it('does not stay blank when hydration finishes in the gap before finish-hydration subscription starts listening', async () => {
    let languagePreference = 'ja-JP';
    let hydrated = false;
    const storeListeners = new Set<VoidFunction>();
    const hydrationListeners = new Set<VoidFunction>();
    const setLanguagePreference = vi.fn((nextPreference: string) => {
      languagePreference = nextPreference;
      storeListeners.forEach((listener) => listener());
    });
    let hydrationSubscriptionCount = 0;

    vi.doMock('./store', () => ({
      useStore: Object.assign(
        <T,>(selector: (state: { languagePreference: string; setLanguagePreference: (nextPreference: string) => void }) => T): T =>
          React.useSyncExternalStore(
            (listener) => {
              storeListeners.add(listener);
              return () => storeListeners.delete(listener);
            },
            () => selector({ languagePreference, setLanguagePreference }),
            () => selector({ languagePreference, setLanguagePreference }),
          ),
        {
          persist: {
            hasHydrated: () => hydrated,
            onFinishHydration: (listener: VoidFunction) => {
              hydrationSubscriptionCount += 1;
              hydrated = true;
              hydrationListeners.add(listener);
              return () => hydrationListeners.delete(listener);
            },
          },
        },
      ),
    }));

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    renderRootImpl = (node) => {
      renderer = TestRenderer.create(node as React.ReactElement);
    };

    await importMain();
    const { getCurrentLanguage } = await import('./i18n');

    await act(async () => {});

    expect(hydrationSubscriptionCount).toBeGreaterThan(0);
    expect(renderer).not.toBeNull();
    expect(renderer!.toJSON()).not.toBeNull();
    expect(getCurrentLanguage()).toBe('ja-JP');
    expect(dayjsLocaleMock).toHaveBeenCalledWith('ja');
    expect(syncLanguageRuntimeMock.mock.calls.map(([language]) => language)).toEqual(['ja-JP']);
  });

  it('renders immediately with the resolved locale when hydration is already complete on first load', async () => {
    const setLanguagePreference = vi.fn();

    vi.doMock('./store', () => ({
      useStore: Object.assign(
        <T,>(selector: (state: { languagePreference: string; setLanguagePreference: (nextPreference: string) => void }) => T): T =>
          React.useSyncExternalStore(
            () => () => {},
            () => selector({ languagePreference: 'ja-JP', setLanguagePreference }),
            () => selector({ languagePreference: 'ja-JP', setLanguagePreference }),
          ),
        {
          persist: {
            hasHydrated: () => true,
            onFinishHydration: () => () => {},
          },
        },
      ),
    }));

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    renderRootImpl = (node) => {
      act(() => {
        renderer = TestRenderer.create(node as React.ReactElement);
      });
    };

    await importMain();
    const { getCurrentLanguage } = await import('./i18n');
    await act(async () => {});

    expect(renderer).not.toBeNull();
    expect(renderer!.toJSON()).not.toBeNull();
    expect(getCurrentLanguage()).toBe('ja-JP');
    expect(dayjsLocaleMock).toHaveBeenCalledWith('ja');
    expect(syncLanguageRuntimeMock.mock.calls.map(([language]) => language)).toEqual(['ja-JP']);
  });

  it('updates the resolved locale when the system browser language changes', async () => {
    const windowListeners = new Map<string, Set<EventListener>>();
    const windowMock = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const listeners = windowListeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        windowListeners.set(type, listeners);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.get(type)?.delete(listener);
      }),
      dispatchEvent: vi.fn((event: Event) => {
        windowListeners.get(event.type)?.forEach((listener) => listener(event));
        return true;
      }),
    };
    vi.stubGlobal('window', windowMock);

    let navigatorLanguages = ['en-US'];
    const navigatorMock = {};
    Object.defineProperty(navigatorMock, 'languages', {
      configurable: true,
      get: () => navigatorLanguages,
    });
    Object.defineProperty(navigatorMock, 'language', {
      configurable: true,
      get: () => navigatorLanguages[0] ?? '',
    });
    vi.stubGlobal('navigator', navigatorMock);

    const setLanguagePreference = vi.fn();
    vi.doMock('./store', () => ({
      useStore: Object.assign(
        <T,>(selector: (state: { languagePreference: string; setLanguagePreference: (nextPreference: string) => void }) => T): T =>
          React.useSyncExternalStore(
            () => () => {},
            () => selector({ languagePreference: 'system', setLanguagePreference }),
            () => selector({ languagePreference: 'system', setLanguagePreference }),
          ),
        {
          persist: {
            hasHydrated: () => true,
            onFinishHydration: () => () => {},
          },
        },
      ),
    }));

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    renderRootImpl = (node) => {
      act(() => {
        renderer = TestRenderer.create(node as React.ReactElement);
      });
    };

    await importMain();
    const { getCurrentLanguage } = await import('./i18n');
    await act(async () => {});

    expect(renderer).not.toBeNull();
    expect(getCurrentLanguage()).toBe('en-US');

    dayjsLocaleMock.mockClear();
    syncLanguageRuntimeMock.mockClear();

    await act(async () => {
      navigatorLanguages = ['zh-CN'];
      windowMock.dispatchEvent(new Event('languagechange'));
    });

    expect(getCurrentLanguage()).toBe('zh-CN');
    expect(dayjsLocaleMock).toHaveBeenCalledWith('zh-cn');
    expect(syncLanguageRuntimeMock.mock.calls.map(([language]) => language)).toEqual(['zh-CN']);
  });
});
