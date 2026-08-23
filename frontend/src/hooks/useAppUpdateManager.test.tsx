import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveUpdateInstallAction, useAppUpdateManager } from './useAppUpdateManager';

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

  it('resolves Portable and MSI install actions from backend metadata', () => {
    expect(resolveUpdateInstallAction({ packageType: 'portable', autoRelaunch: true })).toBe('restart');
    expect(resolveUpdateInstallAction({ packageType: 'msi', autoRelaunch: true })).toBe('install-and-restart');
    expect(resolveUpdateInstallAction({ packageType: 'msi', autoRelaunch: false })).toBe('launch-installer');
  });

  it('schedules silent update checks when auto-check is enabled', async () => {
    backendApp.CheckForUpdatesSilently.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        currentVersion: '0.8.1',
        latestVersion: '0.8.1',
      },
    });

    renderHook();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(backendApp.CheckForUpdatesSilently).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    });

    expect(backendApp.CheckForUpdatesSilently).toHaveBeenCalledTimes(2);
  });

  it('uses the configured auto-check interval for subsequent silent checks', async () => {
    storeApi.autoCheckForUpdatesIntervalMinutes = 15;
    backendApp.CheckForUpdatesSilently.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        currentVersion: '0.8.1',
        latestVersion: '0.8.1',
      },
    });

    renderHook();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(backendApp.CheckForUpdatesSilently).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    });
    expect(backendApp.CheckForUpdatesSilently).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(backendApp.CheckForUpdatesSilently).toHaveBeenCalledTimes(2);
  });

  it('does not schedule silent update checks when auto-check is disabled', async () => {
    storeApi.autoCheckForUpdates = false;
    backendApp.CheckForUpdatesSilently.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: false,
        currentVersion: '0.8.1',
        latestVersion: '0.8.1',
      },
    });

    renderHook();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    });

    expect(backendApp.CheckForUpdatesSilently).not.toHaveBeenCalled();
    expect(backendApp.CheckForUpdates).not.toHaveBeenCalled();
  });

  it('exposes a loading state while checking for updates', async () => {
    let resolveCheck: ((result: Record<string, unknown>) => void) | undefined;
    const checkPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveCheck = resolve;
    });
    backendApp.CheckForUpdates.mockReturnValue(checkPromise);

    renderHook();

    let pendingCheck: Promise<void> | undefined;
    act(() => {
      pendingCheck = hook?.checkForUpdates(false);
    });

    expect(hook?.isCheckingForUpdates).toBe(true);
    expect(hook?.aboutUpdateStatus).toBe('app.about.update_status.checking');

    await act(async () => {
      resolveCheck?.({
        success: true,
        data: {
          hasUpdate: false,
          currentVersion: '0.8.1',
          latestVersion: '0.8.1',
        },
      });
      await pendingCheck;
    });

    expect(hook?.isCheckingForUpdates).toBe(false);
  });

  it('merges complete MSI download metadata returned by the backend', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'latest',
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        releaseName: 'Initial release metadata',
        assetName: 'GoNavi-0.8.2-Windows-Amd64-Installer.msi',
        packageType: 'msi',
        installMode: 'msi',
        autoRelaunch: true,
        downloaded: false,
        assetSize: 4096,
      },
    });
    backendApp.DownloadUpdate.mockResolvedValue({
      success: true,
      data: {
        info: {
          hasUpdate: true,
          channel: 'latest',
          currentVersion: '0.8.1',
          latestVersion: '0.8.2',
          releaseName: 'Resolved release metadata',
          assetName: 'GoNavi-0.8.2-Windows-Amd64-Installer.msi',
          packageType: 'msi',
          installMode: 'msi',
          autoRelaunch: true,
        },
        downloadPath: 'C:\\ProgramData\\GoNavi\\GoNavi-0.8.2-Windows-Amd64-Installer.msi',
        packageType: 'msi',
        installMode: 'msi',
        autoRelaunch: false,
      },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });

    expect(hook?.lastUpdateInfo).toMatchObject({
      releaseName: 'Resolved release metadata',
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Installer.msi',
      packageType: 'msi',
      installMode: 'msi',
      autoRelaunch: false,
      downloaded: true,
      downloadPath: 'C:\\ProgramData\\GoNavi\\GoNavi-0.8.2-Windows-Amd64-Installer.msi',
    });
    expect(hook?.installMode).toBe('msi');
    expect(hook?.updateInstallAction).toBe('launch-installer');
    expect(hook?.updateDownloadProgress.message).toBe('app.about.download_progress.ready_to_install');
    expect(messageApi.success).toHaveBeenCalledWith(expect.objectContaining({
      content: 'app.about.message.download_ready_install_with_path:C:\\ProgramData\\GoNavi\\GoNavi-0.8.2-Windows-Amd64-Installer.msi',
    }));
  });

  it('uses the backend download result version for progress and cached update metadata', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'dev',
        currentVersion: 'dev-current',
        latestVersion: 'dev-old',
        assetName: 'GoNavi-dev-old-Windows-Amd64-Portable.exe',
        packageType: 'portable',
        installMode: 'portable',
        autoRelaunch: true,
        downloaded: false,
        assetSize: 4096,
      },
    });
    backendApp.DownloadUpdate.mockResolvedValue({
      success: true,
      data: {
        info: {
          hasUpdate: true,
          channel: 'dev',
          currentVersion: 'dev-current',
          latestVersion: 'dev-new',
          assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
          packageType: 'portable',
          installMode: 'portable',
          autoRelaunch: true,
        },
        downloadPath: 'C:\\GoNavi\\GoNavi-dev-new-Windows-Amd64-Portable.exe',
        packageType: 'portable',
        installMode: 'portable',
        autoRelaunch: true,
      },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });

    expect(hook?.lastUpdateInfo).toMatchObject({
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
      downloaded: true,
      downloadPath: 'C:\\GoNavi\\GoNavi-dev-new-Windows-Amd64-Portable.exe',
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      version: 'dev-new',
      key: 'dev:dev-new:portable:gonavi-dev-new-windows-amd64-portable.exe',
      status: 'done',
    });
  });

  it('shows the refreshed dev version as soon as the backend starts downloading it', async () => {
    let resolveDownload: ((result: Record<string, unknown>) => void) | undefined;
    const downloadPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveDownload = resolve;
    });
    const refreshedInfo = {
      hasUpdate: true,
      channel: 'dev',
      currentVersion: 'dev-current',
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 8192,
    };
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: refreshedInfo,
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
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'start',
      message: 'app.about.download_progress.downloading',
    });

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.({
        status: 'start',
        downloaded: 0,
        total: refreshedInfo.assetSize,
        info: refreshedInfo,
      });
    });

    expect(hook?.lastUpdateInfo).toMatchObject({
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      version: 'dev-new',
      key: 'dev:dev-new:portable:gonavi-dev-new-windows-amd64-portable.exe',
      status: 'start',
      total: 8192,
      message: 'app.about.download_progress.downloading',
    });

    await act(async () => {
      resolveDownload?.({ success: true, data: { info: refreshedInfo } });
      await pendingDownload;
    });
  });

  it('starts package downloads through the detached task API and ignores stale task events', async () => {
    const updateInfo = {
      hasUpdate: true,
      channel: 'dev',
      currentVersion: 'dev-current',
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 8192,
    };
    backendApp.CheckForUpdates.mockResolvedValue({ success: true, data: updateInfo });
    backendApp.StartUpdateDownload = vi.fn(async () => ({
      success: true,
      data: {
        task: {
          taskId: 'update-task-current',
          status: 'start',
          percent: 0,
          downloaded: 0,
          total: 8192,
          running: true,
          info: updateInfo,
        },
      },
    }));

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });

    expect(backendApp.StartUpdateDownload).toHaveBeenCalledTimes(1);
    expect(backendApp.DownloadUpdate).not.toHaveBeenCalled();
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'start',
      percent: 0,
      key: 'dev:dev-new:portable:gonavi-dev-new-windows-amd64-portable.exe',
    });

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');

    act(() => {
      progressListener?.({
        taskId: 'update-task-stale',
        status: 'error',
        percent: 0,
        message: 'stale task failed',
      });
    });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'start', percent: 0 });

    act(() => {
      progressListener?.({
        taskId: 'update-task-current',
        status: 'downloading',
        percent: 45,
        downloaded: 3686,
        total: 8192,
      });
    });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'downloading', percent: 45, downloaded: 3686 });
  });

  it('does not regress a completed task when its start response arrives late', async () => {
    const updateInfo = {
      hasUpdate: true,
      channel: 'latest',
      currentVersion: '0.8.1',
      latestVersion: '0.8.2',
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 10000,
    };
    let resolveStart!: (value: unknown) => void;
    backendApp.CheckForUpdates.mockResolvedValue({ success: true, data: updateInfo });
    backendApp.StartUpdateDownload = vi.fn(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    let pendingStart: Promise<void> | undefined;
    act(() => {
      pendingStart = hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.({
        taskId: 'update-task-fast-complete',
        status: 'done',
        percent: 100,
        downloaded: 10000,
        total: 10000,
        info: { ...updateInfo, downloaded: true, downloadPath: 'D:/GoNavi/GoNavi-0.8.2.exe' },
      });
    });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'done', percent: 100 });

    await act(async () => {
      resolveStart({
        success: true,
        data: {
          task: {
            taskId: 'update-task-fast-complete',
            status: 'start',
            percent: 0,
            downloaded: 0,
            total: 10000,
            running: true,
            info: updateInfo,
          },
        },
      });
      await pendingStart;
    });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'done', percent: 100 });
    expect(hook?.lastUpdateInfo).toMatchObject({ downloaded: true, downloadPath: 'D:/GoNavi/GoNavi-0.8.2.exe' });
  });

  it('rehydrates an active background update task after the update hook remounts', async () => {
    const updateInfo = {
      hasUpdate: true,
      channel: 'dev',
      currentVersion: 'dev-current',
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 10000,
    };
    const activeTask = {
      taskId: 'update-task-rehydrate',
      status: 'downloading',
      percent: 45,
      downloaded: 4500,
      total: 10000,
      message: 'downloading update package',
      running: true,
      info: updateInfo,
    };
    backendApp.GetUpdateDownloadTask.mockResolvedValue({ success: true, data: { task: activeTask } });

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(hook?.lastUpdateInfo).toMatchObject({ latestVersion: 'dev-new', channel: 'dev' });
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: false,
      status: 'downloading',
      percent: 45,
      downloaded: 4500,
      key: 'dev:dev-new:portable:gonavi-dev-new-windows-amd64-portable.exe',
    });

    await act(async () => {
      renderer?.unmount();
      await flushMicrotasks();
    });

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendApp.GetUpdateDownloadTask).toHaveBeenCalledTimes(2);
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: false,
      status: 'downloading',
      percent: 45,
      downloaded: 4500,
    });

    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.({
        taskId: 'old-update-task',
        status: 'error',
        percent: 0,
        message: 'old task failed',
      });
    });
    expect(hook?.updateDownloadProgress).toMatchObject({ status: 'downloading', percent: 45 });

    act(() => {
      progressListener?.({
        taskId: 'update-task-rehydrate',
        status: 'downloading',
        percent: 60,
        downloaded: 6000,
        total: 10000,
      });
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: false,
      status: 'downloading',
      percent: 60,
      downloaded: 6000,
    });
  });

  it('keeps a persisted dev-channel task after the first dev update check', async () => {
    const updateInfo = {
      hasUpdate: true,
      channel: 'dev',
      currentVersion: 'dev-current',
      latestVersion: 'dev-new',
      assetName: 'GoNavi-dev-new-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 10000,
    };
    backendApp.GetUpdateChannel.mockResolvedValue({ success: true, data: { channel: 'dev' } });
    backendApp.GetUpdateDownloadTask.mockResolvedValue({
      success: true,
      data: {
        task: {
          taskId: 'persisted-dev-task',
          status: 'downloading',
          percent: 45,
          downloaded: 4500,
          total: 10000,
          running: true,
          info: updateInfo,
        },
      },
    });
    backendApp.CheckForUpdates.mockResolvedValue({ success: true, data: updateInfo });

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'downloading',
      percent: 45,
      key: 'dev:dev-new:portable:gonavi-dev-new-windows-amd64-portable.exe',
    });

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    expect(hook?.updateChannel).toBe('dev');
    expect(hook?.lastUpdateInfo).toMatchObject({ channel: 'dev', latestVersion: 'dev-new' });
    expect(hook?.updateDownloadProgress).toMatchObject({
      status: 'downloading',
      percent: 45,
      downloaded: 4500,
    });
  });

  it('keeps an event arriving before task hydration in the background', async () => {
    const updateInfo = {
      hasUpdate: true,
      channel: 'latest',
      currentVersion: '0.8.1',
      latestVersion: '0.8.2',
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 10000,
    };
    const activeTask = {
      taskId: 'update-task-hydration-race',
      status: 'downloading',
      percent: 45,
      downloaded: 4500,
      total: 10000,
      running: true,
      info: updateInfo,
    };
    let resolveTask!: (value: unknown) => void;
    backendApp.GetUpdateDownloadTask.mockImplementation(() => new Promise((resolve) => {
      resolveTask = resolve;
    }));

    renderHook();
    await act(async () => {
      await flushMicrotasks();
    });
    const progressListener = (runtimeApi.EventsOn.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([eventName]) => eventName === 'update:download-progress')
      .slice(-1)[0]?.[1] as ((event: Record<string, unknown>) => void) | undefined;
    expect(progressListener).toBeTypeOf('function');
    act(() => {
      progressListener?.(activeTask);
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: false,
      status: 'downloading',
      percent: 45,
    });

    await act(async () => {
      resolveTask({ success: true, data: { task: activeTask } });
      await flushMicrotasks();
    });
    expect(hook?.updateDownloadProgress).toMatchObject({
      open: false,
      status: 'downloading',
      percent: 45,
    });
  });

  it('keeps same-version Portable and MSI downloads in separate cache identities', async () => {
    const portableInfo = {
      hasUpdate: true,
      channel: 'latest',
      currentVersion: '0.8.1',
      latestVersion: '0.8.2',
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Portable.exe',
      packageType: 'portable',
      installMode: 'portable',
      autoRelaunch: true,
      downloaded: false,
      assetSize: 2048,
    };
    const msiInfo = {
      ...portableInfo,
      assetName: 'GoNavi-0.8.2-Windows-Amd64-Installer.msi',
      packageType: 'msi',
      installMode: 'msi',
    };
    backendApp.CheckForUpdates
      .mockResolvedValueOnce({ success: true, data: portableInfo })
      .mockResolvedValueOnce({ success: true, data: msiInfo });
    backendApp.DownloadUpdate
      .mockResolvedValueOnce({ success: true, data: { info: portableInfo, packageType: 'portable' } })
      .mockResolvedValueOnce({ success: true, data: { info: msiInfo, packageType: 'msi' } });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });
    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    expect(hook?.lastUpdateInfo?.packageType).toBe('msi');
    expect(hook?.isLatestUpdateDownloaded).toBe(false);

    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });
    expect(backendApp.DownloadUpdate).toHaveBeenCalledTimes(2);
    expect(hook?.lastUpdateInfo?.packageType).toBe('msi');
    expect(hook?.isLatestUpdateDownloaded).toBe(true);
  });

  it('reports a launched MSI installer instead of claiming an automatic restart', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        channel: 'latest',
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        assetName: 'GoNavi-0.8.2-Windows-Amd64-Installer.msi',
        packageType: 'msi',
        installMode: 'msi',
        autoRelaunch: false,
        downloaded: true,
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({
      success: true,
      data: { packageType: 'msi', autoRelaunch: false },
    });

    renderHook();
    await act(async () => {
      await hook?.checkForUpdates(false);
    });
    await act(async () => {
      await hook?.handleInstallFromProgress(true);
    });

    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledTimes(1);
    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledWith(true);
    expect(hook?.updateInstallAction).toBe('launch-installer');
    expect(hook?.updateDownloadProgress.message).toBe('app.about.download_progress.installer_started');
  });

  it('uses InstallUpdateAndRestart for downloaded macOS updates', async () => {
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
    backendApp.InstallUpdateAndRestart.mockResolvedValue({ success: true });
    backendApp.OpenDownloadedUpdateDirectory.mockResolvedValue({ success: true });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    await act(async () => {
      await hook?.handleInstallFromProgress();
    });

    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledTimes(1);
    expect(backendApp.InstallUpdateAndRestart).toHaveBeenCalledWith(false);
    expect(backendApp.OpenDownloadedUpdateDirectory).not.toHaveBeenCalled();
  });

  it('does not auto-open the downloaded macOS package directory after download succeeds', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: false,
        assetSize: 2048,
      },
    });
    backendApp.DownloadUpdate.mockResolvedValue({
      success: true,
      data: {
        downloadPath: '/Users/test/Desktop/GoNavi-0.8.2-MacOS-Arm64.dmg',
      },
    });
    backendApp.OpenDownloadedUpdateDirectory.mockResolvedValue({ success: true });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });

    expect(backendApp.DownloadUpdate).toHaveBeenCalledTimes(1);
    expect(backendApp.OpenDownloadedUpdateDirectory).not.toHaveBeenCalled();
    expect(backendApp.InstallUpdateAndRestart).not.toHaveBeenCalled();
    expect(hook?.lastUpdateInfo?.downloaded).toBe(true);
  });

  it('keeps download at 100% ready-to-restart without auto-installing after download completes', async () => {
    backendApp.CheckForUpdates.mockResolvedValue({
      success: true,
      data: {
        hasUpdate: true,
        currentVersion: '0.8.1',
        latestVersion: '0.8.2',
        downloaded: false,
        assetSize: 2048,
      },
    });
    backendApp.DownloadUpdate.mockResolvedValue({
      success: true,
      data: {
        platform: 'darwin',
        autoRelaunch: true,
        downloadPath: '/Users/test/Desktop/GoNavi-0.8.2/GoNavi-0.8.2-MacOS-Arm64.dmg',
      },
    });
    backendApp.InstallUpdateAndRestart.mockResolvedValue({ success: true });

    renderHook();

    await act(async () => {
      await hook?.checkForUpdates(false);
    });

    await act(async () => {
      await hook?.downloadUpdate(hook?.lastUpdateInfo!, false);
    });

    expect(backendApp.DownloadUpdate).toHaveBeenCalledTimes(1);
    // 下载完成后不自动安装；用户需点击「重启应用更新」
    expect(backendApp.InstallUpdateAndRestart).not.toHaveBeenCalled();
    expect(backendApp.OpenDownloadedUpdateDirectory).not.toHaveBeenCalled();
    expect(hook?.updateDownloadProgress.status).toBe('done');
    expect(hook?.updateDownloadProgress.percent).toBe(100);
    expect(hook?.updateDownloadProgress.open).toBe(true);
    expect(hook?.lastUpdateInfo?.downloaded).toBe(true);
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
      hook?.setIsAboutOpen(true);
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

  it('opens settings-center bridge instead of legacy about modal on silent update discovery', async () => {
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
    expect(hook?.isAboutOpen).toBe(false);
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
