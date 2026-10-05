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
  StartUpdateDownload?: ReturnType<typeof vi.fn>;
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
});

describe('useAppUpdateManager', () => {
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

  it('installs and restarts only after the user confirms restart-to-update', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: true,
        assetSize: 2048,
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({ success: true });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    let accepted = false;
    await act(async () => {
      accepted = await hook!.handleInstallFromProgress();
    });

    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledTimes(1);
    expect(accepted).toBe(true);
  });

  it('returns false when the backend rejects restart-to-update', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: true,
        assetSize: 2048,
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({
      success: false,
      message: 'unable-to-start-updater',
    });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    let accepted = true;
    await act(async () => {
      accepted = await hook!.handleInstallFromProgress();
    });

    expect(accepted).toBe(false);
    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledTimes(1);
    expect(hook?.updateDownloadProgress.status).toBe('error');
    expect(messageApi.error).toHaveBeenCalledWith(
      'app.about.message.install_failed_with_error:unable-to-start-updater',
    );
  });

  it('restores the ready state without an error toast when Windows instance confirmation is cancelled', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: true,
        assetSize: 2048,
        installMode: 'portable',
        packageType: 'portable',
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({
      success: false,
      data: { cancelled: true },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    let accepted = true;
    await act(async () => {
      accepted = await hook!.handleInstallFromProgress();
    });

    expect(accepted).toBe(false);
    expect(hook?.updateDownloadProgress.status).toBe('done');
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('returns the Windows instance confirmation request to the GoNavi modal layer', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: true,
        assetSize: 2048,
        installMode: 'portable',
        packageType: 'portable',
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({
      success: false,
      data: { requiresCloseConfirmation: true, instanceCount: 3 },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    let requestedInstanceCount: number | null = null;
    let accepted = true;
    await act(async () => {
      accepted = await hook!.handleInstallFromProgress(false, (instanceCount) => {
        requestedInstanceCount = instanceCount;
      });
    });

    expect(accepted).toBe(false);
    expect(requestedInstanceCount).toBe(3);
    expect(hook?.updateDownloadProgress.status).toBe('done');
    expect(hook?.updateDownloadProgress.open).toBe(false);
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('returns false without calling the backend when no update is ready', async () => {
    renderHook();

    let accepted = true;
    await act(async () => {
      accepted = await hook!.handleInstallFromProgress();
    });

    expect(accepted).toBe(false);
    expect(backendApp.InstallUpdateAndRestart).not.toHaveBeenCalled();
  });

  it('switches update channel and re-checks against the selected channel', async () => {
    backendApp.SetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        channel: 'dev',
        currentVersion: '0.8.1',
        latestVersion: 'dev-a1b2c3d',
      },
    });

    renderHook();

    await act(async () => {
      await hook?.changeUpdateChannel('dev');
    });

    expect(backendApp.SetUpdateChannel).toHaveBeenCalledWith('dev');
    expect(backendApp.CheckForUpdates).toHaveBeenCalledTimes(1);
    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo?.channel).toBe('dev');
  });

  it('does not restore a previous-channel task after switching channels while hydration is pending', async () => {
    const oldTaskInfo = {
      hasUpdate: true,
      channel: 'latest',
      currentVersion: '0.8.1',
      latestVersion: '0.8.2',
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: true,
      downloadPath: 'D:/GoNavi/GoNavi-0.8.2.exe',
      assetSize: 1024,
    };
    let resolveOldTask!: (value: unknown) => void;
    backendApp.GetUpdateDownloadTask.mockImplementation(() => new Promise((resolve) => {
      resolveOldTask = resolve;
    }));
    backendApp.SetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        channel: 'dev',
        currentVersion: 'dev-a1b2c3d',
        latestVersion: 'dev-a1b2c3d',
      },
    });

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendApp.GetUpdateDownloadTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook?.changeUpdateChannel('dev');
    });
    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-a1b2c3d' });
    expect(hook?.updateDownloadProgress.status).toBe('idle');

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.({
        taskId: 'old-latest-task',
        status: 'done',
        percent: 100,
        downloaded: 1024,
        total: 1024,
        info: oldTaskInfo,
      });
    });

    await act(async () => {
      resolveOldTask({
        success: true,
        data: {
          task: {
            taskId: 'old-latest-task',
            status: 'done',
            percent: 100,
            downloaded: 1024,
            total: 1024,
            running: false,
            info: oldTaskInfo,
            result: { info: oldTaskInfo, downloadPath: oldTaskInfo.downloadPath },
          },
        },
      });
      await flushMicrotasks();
    });

    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-a1b2c3d' });
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'idle',
      key: '',
      percent: 0,
    });
  });

  it('does not let a delayed initial channel lookup overwrite a successful channel switch', async () => {
    let resolveInitialChannel!: (value: unknown) => void;
    backendApp.GetUpdateChannel.mockImplementation(() => new Promise((resolve) => {
      resolveInitialChannel = resolve;
    }));
    backendApp.SetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        channel: 'dev',
        currentVersion: 'dev-a1b2c3d',
        latestVersion: 'dev-a1b2c3d',
      },
    });

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendApp.GetUpdateChannel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook?.changeUpdateChannel('dev');
    });
    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-a1b2c3d' });

    await act(async () => {
      resolveInitialChannel({ success: true, data: { channel: 'latest' } });
      await flushMicrotasks();
    });

    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-a1b2c3d' });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'idle', key: '', percent: 0 });
  });

  it('waits for an old check to settle before completing the selected-channel recheck', async () => {
    let resolveOldCheck!: (value: unknown) => void;
    backendApp.CheckForUpdates
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldCheck = resolve;
      }))
      .mockResolvedValueOnce({
        success: true,
        data: {
          hasUpdate: false,
          channel: 'dev',
          currentVersion: 'dev-a1b2c3d',
          latestVersion: 'dev-a1b2c3d',
        },
      });
    backendApp.SetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });

    renderHook();
    let oldCheck: Promise<void> | undefined;
    act(() => {
      oldCheck = hook?.checkForUpdates(false);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(hook?.isCheckingForUpdates).toBe(true);

    let channelChange: Promise<void> | undefined;
    act(() => {
      channelChange = hook?.changeUpdateChannel('dev');
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendApp.SetUpdateChannel).toHaveBeenCalledWith('dev');
    expect(backendApp.CheckForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOldCheck({
        success: true,
        data: {
          hasUpdate: false,
          channel: 'latest',
          currentVersion: '0.8.1',
          latestVersion: '0.8.1',
        },
      });
      await channelChange;
      await oldCheck;
    });

    expect(backendApp.CheckForUpdates).toHaveBeenCalledTimes(2);
    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-a1b2c3d' });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'idle', key: '', percent: 0 });
  });

  it('does not invoke the manual-check bridge when a channel change re-check finds an update', async () => {
    const openReleaseNotes = vi.fn();
    const openReleaseNotesRef = { current: openReleaseNotes };

    backendApp.SetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'dev',
        currentVersion: '0.8.1',
        latestVersion: 'dev-a1b2c3d',
      },
    });

    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
        onManualCheckHasUpdateRef: openReleaseNotesRef,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      await hook?.changeUpdateChannel('dev');
    });

    expect(backendApp.SetUpdateChannel).toHaveBeenCalledWith('dev');
    expect(backendApp.CheckForUpdates).toHaveBeenCalledTimes(1);
    // 通道切换后的自动复查即便发现更新，也不应打开更新日志弹窗（#818 触发边界修正）
    expect(openReleaseNotes).not.toHaveBeenCalled();
    expect(hook?.lastUpdateInfo?.hasUpdate).toBe(true);
    expect(hook?.lastUpdateInfo?.latestVersion).toBe('dev-a1b2c3d');
  });

  it('keeps release metadata from the backend update response', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        releaseName: 'Dev Build (dev-22fab86)',
        releasePublishedAt: '2026-07-08T11:15:00Z',
        releaseNotesUrl: 'https://github.com/Syngnat/GoNavi/releases/tag/dev-latest',
      },
    });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    expect(hook?.lastUpdateInfo?.releaseName).toBe('Dev Build (dev-22fab86)');
    expect(hook?.lastUpdateInfo?.releasePublishedAt).toBe('2026-07-08T11:15:00Z');
    expect(hook?.lastUpdateInfo?.releaseNotesUrl).toBe('https://github.com/Syngnat/GoNavi/releases/tag/dev-latest');
  });

  it('keeps official about metadata usable when backend app info is incomplete', async () => {
    backendApp.GetAppInfo.mockResolvedValue({
      success: true,
      data: {
        version: '',
        author: 'Unknown',
      },
    });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        currentVersion: '0.8.5',
        latestVersion: '0.8.5',
      },
    });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      hook?.prepareAboutSurface();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook?.aboutDisplayVersion).toBe('0.8.5');
    expect(hook?.aboutInfo?.author).toBe('Syngnat');
    expect(hook?.aboutInfo?.repoUrl).toBe('https://github.com/Syngnat/GoNavi');
    expect(hook?.aboutInfo?.issueUrl).toBe('https://github.com/Syngnat/GoNavi/issues');
    expect(hook?.aboutInfo?.releaseUrl).toBe('https://github.com/Syngnat/GoNavi/releases');
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('opens the settings-center bridge on silent update discovery', async () => {
    const bridge = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: vi.fn(() => false),
    };
    const bridgeRef = { current: bridge };

    backendApp.CheckForUpdatesSilently.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        assetSize: 1024,
      },
    });

    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
        updateCenterBridgeRef: bridgeRef,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      await hook?.checkForUpdates(true);
    });

    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(hook?.lastUpdateInfo?.hasUpdate).toBe(true);
    expect(hook?.lastUpdateInfo?.latestVersion).toBe('0.8.2');
  });

  it('invokes the manual-check bridge when a manual check finds an update', async () => {
    const openReleaseNotes = vi.fn();
    const openReleaseNotesRef = { current: openReleaseNotes };

    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'latest',
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        releaseNotesUrl: 'https://github.com/Syngnat/GoNavi/releases/tag/v0.8.2',
      },
    });

    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
        onManualCheckHasUpdateRef: openReleaseNotesRef,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      await hook?.checkForUpdates(false, true);
    });

    expect(openReleaseNotes).toHaveBeenCalledTimes(1);
    expect(hook?.lastUpdateInfo?.hasUpdate).toBe(true);
    expect(hook?.lastUpdateInfo?.latestVersion).toBe('0.8.2');
  });

  it('does not invoke the manual-check bridge when a manual check finds no update', async () => {
    const openReleaseNotes = vi.fn();
    const openReleaseNotesRef = { current: openReleaseNotes };

    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        channel: 'latest',
        currentVersion: '0.8.1',
        latestVersion: '0.8.1',
      },
    });

    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
        onManualCheckHasUpdateRef: openReleaseNotesRef,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      await hook?.checkForUpdates(false, true);
    });

    expect(openReleaseNotes).not.toHaveBeenCalled();
    expect(hook?.lastUpdateInfo?.hasUpdate).toBe(false);
    expect(messageApi.success).toHaveBeenCalled();
  });

  it('does not invoke the manual-check bridge on silent update discovery', async () => {
    const openReleaseNotes = vi.fn();
    const openReleaseNotesRef = { current: openReleaseNotes };

    backendApp.CheckForUpdatesSilently.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'latest',
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
      },
    });

    const Harness = () => {
      hook = useAppUpdateManager({
        runtimeBuildType: 'release',
        t,
        onManualCheckHasUpdateRef: openReleaseNotesRef,
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      await hook?.checkForUpdates(true);
    });

    expect(openReleaseNotes).not.toHaveBeenCalled();
    expect(hook?.lastUpdateInfo?.hasUpdate).toBe(true);
  });

  it('opens the downloaded update directory when a package is already downloaded', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: true,
        assetSize: 1024,
      },
    });
    backendApp.OpenDownloadedUpdateDirectory.mockResolvedValue({
      success: true,
      message: 'opened-install-directory',
    });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    await act(async () => {
      await hook?.openDownloadedUpdateDirectory();
    });

    expect(backendApp.OpenDownloadedUpdateDirectory).toHaveBeenCalledTimes(1);
    expect(messageApi.success).toHaveBeenCalledWith('opened-install-directory');
  });

  it('keeps an in-progress download hidden after later progress events', async () => {
    let resolveDownload: ((result: Record<string, unknown>) => void) | undefined;
    const downloadPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveDownload = resolve;
    });
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: false,
        assetSize: 1024,
      },
    });
    backendApp.DownloadUpdate.mockReturnValue(downloadPromise);

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    let pendingDownload: Promise<void> | undefined;
    act(() => {
      pendingDownload = hook?.downloadUpdate(hook.lastUpdateInfo!, false);
    });
    expect(hook?.updateDownloadProgress.open).toBe(true);
    expect(hook?.updateDownloadProgress.message).toBe('app.about.download_progress.downloading');

    act(() => {
      hook?.markUpdateProgressDismissed();
      hook?.hideUpdateDownloadProgress();
    });
    expect(hook?.updateDownloadProgress.open).toBe(false);

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.({
        status: 'downloading',
        downloaded: 768,
        total: 1024,
        percent: 75,
      });
    });

    expect(hook?.updateDownloadProgress.open).toBe(false);
    expect(hook?.updateDownloadProgress.percent).toBe(75);

    act(() => {
      hook?.showUpdateDownloadProgress();
    });
    expect(hook?.updateDownloadProgress.open).toBe(true);
    expect(hook?.updateDownloadProgress.percent).toBe(75);

    act(() => {
      hook?.hideUpdateDownloadProgress();
    });

    await act(async () => {
      resolveDownload?.({
        success: true,
        data: { downloadPath: 'D:/GoNavi/GoNavi-0.8.2.exe' },
      });
      await pendingDownload;
    });

    expect(hook?.updateDownloadProgress.status).toBe('done');
    expect(hook?.updateDownloadProgress.open).toBe(false);

    act(() => {
      hook?.showUpdateDownloadProgress();
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: true,
      status: 'done',
      percent: 100,
    });
  });
});
