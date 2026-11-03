import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppUpdateManager } from './useAppUpdateManager';

const runtimeApi = vi.hoisted(() => ({
  EventsOn: vi.fn(() => vi.fn()),
}));

const messageApi = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

const storeApi = vi.hoisted(() => ({
  autoCheckForUpdates: true,
  autoCheckForUpdatesIntervalMinutes: 30,
}));

vi.mock('../../wailsjs/runtime', () => runtimeApi);

vi.mock('antd', () => ({
  message: messageApi,
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: {
    autoCheckForUpdates: boolean;
    autoCheckForUpdatesIntervalMinutes: number;
  }) => unknown) =>
    selector({
      autoCheckForUpdates: storeApi.autoCheckForUpdates,
      autoCheckForUpdatesIntervalMinutes: storeApi.autoCheckForUpdatesIntervalMinutes,
    }),
}));

type BackendAppMock = {
  CheckForUpdates: ReturnType<typeof vi.fn>;
  CheckForUpdatesSilently: ReturnType<typeof vi.fn>;
  DownloadUpdate: ReturnType<typeof vi.fn>;
  GetUpdateDownloadTask: ReturnType<typeof vi.fn>;
  GetUpdateChannel: ReturnType<typeof vi.fn>;
  InstallUpdateAndRestart: ReturnType<typeof vi.fn>;
  OpenDownloadedUpdateDirectory: ReturnType<typeof vi.fn>;
  SetUpdateChannel: ReturnType<typeof vi.fn>;
  GetAppInfo: ReturnType<typeof vi.fn>;
  StartUpdateDownload: ReturnType<typeof vi.fn>;
  CancelUpdateDownload: ReturnType<typeof vi.fn>;
};

const createBackendAppMock = (): BackendAppMock => ({
  CheckForUpdates: vi.fn(),
  CheckForUpdatesSilently: vi.fn(),
  DownloadUpdate: vi.fn(),
  GetUpdateDownloadTask: vi.fn(async () => ({ success: true, data: { task: null } })),
  GetUpdateChannel: vi.fn(async () => ({ success: true, data: { channel: 'latest' } })),
  InstallUpdateAndRestart: vi.fn(),
  OpenDownloadedUpdateDirectory: vi.fn(),
  SetUpdateChannel: vi.fn(async (channel: string) => ({ success: true, data: { channel } })),
  GetAppInfo: vi.fn(async () => ({ success: true, data: { version: '0.8.1', author: 'Syngnat' } })),
  StartUpdateDownload: vi.fn(),
  CancelUpdateDownload: vi.fn(),
});

const UPDATE_INFO = {
  hasUpdate: true,
  channel: 'latest',
  currentVersion: '0.8.1',
  latestVersion: '0.8.2',
  assetName: 'GoNavi-0.8.2-Windows-Amd64-Portable.exe',
  assetUrl: 'https://example.test/GoNavi-0.8.2.exe',
  packageType: 'portable',
  installMode: 'portable',
  autoRelaunch: true,
  assetSize: 2048,
};

const activeTask = (taskId: string, status: string) => ({
  taskId,
  status,
  percent: status === 'canceled' ? 0 : 37,
  downloaded: status === 'canceled' ? 0 : 512,
  total: 2048,
  running: status === 'start' || status === 'downloading',
  info: UPDATE_INFO,
});

describe('useAppUpdateManager 更新下载取消', () => {
  let backendApp: BackendAppMock;

  let hook: ReturnType<typeof useAppUpdateManager> | null = null;

  let renderer: ReactTestRenderer | null = null;

  const t = (key: string, params?: Record<string, any>) => {
    if (params?.version) return `${key}:${params.version}`;
    if (params?.path) return `${key}:${params.path}`;
    if (params?.error) return `${key}:${params.error}`;
    return key;
  };

  const renderHook = () => {
    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
  };

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /** 让 hook 处于「下载中」，并返回后端任务 id。 */
  const startDownloading = async (taskId: string) => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: { ...UPDATE_INFO },
    });
    backendApp.StartUpdateDownload.mockResolvedValue({
      success: true,
      data: { task: activeTask(taskId, 'downloading'), alreadyRunning: false },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      await hook?.downloadUpdate(UPDATE_INFO, true);
    });
    expect(hook?.updateDownloadProgress.status).toBe('downloading');
    // 检查更新本身会弹「发现新版本」，这里只关心取消流程产生的提示。
    messageApi.info.mockClear();
  };

  beforeEach(() => {
    backendApp = createBackendAppMock();
    hook = null;
    renderer = null;
    storeApi.autoCheckForUpdates = true;
    storeApi.autoCheckForUpdatesIntervalMinutes = 30;
    runtimeApi.EventsOn.mockClear();
    messageApi.info.mockReset();
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      go: {
        app: {
          App: backendApp,
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancels the running download and reports cancellation as an informational notice', async () => {
    await startDownloading('task-1');
    backendApp.CancelUpdateDownload.mockResolvedValue({
      success: true,
      data: { task: activeTask('task-1', 'canceled') },
    });

    let canceled = false;
    await act(async () => {
      canceled = await hook!.cancelUpdate();
    });

    expect(canceled).toBe(true);
    expect(backendApp.CancelUpdateDownload).toHaveBeenCalledTimes(1);
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'canceled',
      key: 'latest:0.8.2:portable:gonavi-0.8.2-windows-amd64-portable.exe',
    });
    expect(hook?.updateDownloadProgress.message).toBe('app.about.download_progress.canceled');
    // 取消是用户主动行为，不能按失败弹错误提示。
    expect(messageApi.info).toHaveBeenCalledWith({
      content: 'app.about.message.update_download_canceled',
      duration: 4,
    });
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('keeps the download running when the backend refuses to cancel', async () => {
    await startDownloading('task-2');
    backendApp.CancelUpdateDownload.mockResolvedValue({
      success: false,
      message: 'no-active-download',
    });

    let canceled = true;
    await act(async () => {
      canceled = await hook!.cancelUpdate();
    });

    expect(canceled).toBe(false);
    expect(hook?.updateDownloadProgress.status).toBe('downloading');
    expect(messageApi.error).toHaveBeenCalledWith(
      'app.about.message.cancel_update_failed_with_error:no-active-download',
    );
    expect(messageApi.info).not.toHaveBeenCalled();
  });

  it('returns false without touching the backend when no download is running', async () => {
    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });

    let canceled = true;
    await act(async () => {
      canceled = await hook!.cancelUpdate();
    });

    expect(canceled).toBe(false);
    expect(backendApp.CancelUpdateDownload).not.toHaveBeenCalled();
  });

  it('lets the user start the download again after canceling', async () => {
    await startDownloading('task-4');
    backendApp.CancelUpdateDownload.mockResolvedValue({
      success: true,
      data: { task: activeTask('task-4', 'canceled') },
    });
    await act(async () => {
      await hook!.cancelUpdate();
    });

    backendApp.StartUpdateDownload.mockResolvedValue({
      success: true,
      data: { task: activeTask('task-5', 'downloading'), alreadyRunning: false },
    });
    await act(async () => {
      await hook?.downloadUpdate(UPDATE_INFO, true);
    });

    expect(backendApp.StartUpdateDownload).toHaveBeenCalledTimes(2);
    expect(hook?.updateDownloadProgress.status).toBe('downloading');
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('does not cancel a download that already finished', async () => {
    await startDownloading('task-6');
    backendApp.StartUpdateDownload.mockResolvedValue({
      success: true,
      data: { task: activeTask('task-6', 'done'), alreadyRunning: false },
    });
    // 让任务在本地进入终态：完成事件到达后状态不再可取消。
    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    act(() => {
      progressListener?.({
        taskId: 'task-6',
        status: 'done',
        percent: 100,
        downloaded: 2048,
        total: 2048,
        info: UPDATE_INFO,
      });
    });
    expect(hook?.updateDownloadProgress.status).toBe('done');

    let canceled = true;
    await act(async () => {
      canceled = await hook!.cancelUpdate();
    });

    expect(canceled).toBe(false);
    expect(backendApp.CancelUpdateDownload).not.toHaveBeenCalled();
    expect(hook?.updateDownloadProgress.status).toBe('done');
  });
});
