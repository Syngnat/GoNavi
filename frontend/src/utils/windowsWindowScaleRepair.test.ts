import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../../wailsjs/runtime';
import { repairWindowsWindowScale } from './windowsWindowScaleRepair';

vi.mock('../../wailsjs/runtime', () => ({
  WindowGetSize: vi.fn(), WindowIsFullscreen: vi.fn(), WindowIsMaximised: vi.fn(),
  WindowMaximise: vi.fn(), WindowUnmaximise: vi.fn(), WindowSetSize: vi.fn(),
}));

describe('Windows automatic surface repair', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runtime.WindowIsFullscreen).mockResolvedValue(false);
    vi.mocked(runtime.WindowIsMaximised).mockResolvedValue(false);
    vi.mocked(runtime.WindowGetSize).mockResolvedValue({ w: 1440, h: 900 });
  });

  const createOptions = () => ({
    reason: 'startup' as const,
    readViewport: () => ({ innerWidth: 1440, devicePixelRatio: 1 }),
    resetZoom: vi.fn(async () => true),
    refreshBounds: vi.fn(async () => true),
    notifyResize: vi.fn(),
    isCancelled: () => false,
  });

  it.each(['startup', 'restore'] as const)(
    'does not shrink a maximised window when %s zoom repair started in normal state',
    async (reason) => {
      const native = { maximised: false, width: 1440, height: 900 };
      vi.mocked(runtime.WindowIsMaximised).mockImplementation(async () => native.maximised);
      vi.mocked(runtime.WindowSetSize).mockImplementation((w, h) => {
        // Wails MoveWindow changes the outer rect without clearing WS_MAXIMIZE.
        native.width = w;
        native.height = h;
      });
      let releaseZoom!: () => void;
      let zoomStarted!: () => void;
      const zoomPending = new Promise<void>((resolve) => { releaseZoom = resolve; });
      const zoomEntered = new Promise<void>((resolve) => { zoomStarted = resolve; });
      const options = createOptions();
      options.resetZoom = vi.fn(async () => { zoomStarted(); await zoomPending; return true; });
      const repair = repairWindowsWindowScale({ ...options, reason });
      await zoomEntered;
      Object.assign(native, { maximised: true, width: 1920, height: 1050 });
      releaseZoom();
      await repair;
      expect(native).toEqual({ maximised: true, width: 1920, height: 1050 });
      expect(runtime.WindowSetSize).not.toHaveBeenCalled();
      expect(options.refreshBounds).toHaveBeenCalledOnce();
    },
  );

  it('refreshes controller bounds even when zoom reset is unavailable', async () => {
    const options = createOptions();
    options.resetZoom.mockRejectedValue(new Error('backend unavailable'));
    await repairWindowsWindowScale(options);
    expect(options.refreshBounds).toHaveBeenCalledOnce();
    expect(options.notifyResize).toHaveBeenCalledOnce();
    expect(runtime.WindowSetSize).not.toHaveBeenCalled();
  });

  it('stops after an awaited zoom reset when the effect is disposed', async () => {
    let cancelled = false;
    const options = createOptions();
    options.resetZoom.mockImplementation(async () => { cancelled = true; return true; });
    await repairWindowsWindowScale({ ...options, isCancelled: () => cancelled });
    expect(options.refreshBounds).not.toHaveBeenCalled();
    expect(options.notifyResize).not.toHaveBeenCalled();
  });

  it('repairs DPI drift without toggling or resizing the native window', async () => {
    const options = createOptions();
    await repairWindowsWindowScale({
      ...options,
      reason: 'ratio-change',
      readViewport: () => ({ innerWidth: 1000, devicePixelRatio: 1.5 }),
    });
    expect(options.resetZoom).toHaveBeenCalledOnce();
    expect(options.refreshBounds).toHaveBeenCalledOnce();
    expect(runtime.WindowSetSize).not.toHaveBeenCalled();
    expect(runtime.WindowUnmaximise).not.toHaveBeenCalled();
    expect(runtime.WindowMaximise).not.toHaveBeenCalled();
  });

  it.each(['activation', 'ratio-change'] as const)('leaves a healthy 150%% DPI window alone on %s', async (reason) => {
    const options = createOptions();
    await repairWindowsWindowScale({
      ...options,
      reason,
      readViewport: () => ({ innerWidth: 1440, devicePixelRatio: 1.5 }),
    });
    expect(options.resetZoom).not.toHaveBeenCalled();
    expect(options.refreshBounds).not.toHaveBeenCalled();
  });

  it('preserves fullscreen without controller or geometry mutations', async () => {
    vi.mocked(runtime.WindowIsFullscreen).mockResolvedValue(true);
    const options = createOptions();
    await repairWindowsWindowScale(options);
    expect(options.resetZoom).not.toHaveBeenCalled();
    expect(options.refreshBounds).not.toHaveBeenCalled();
    expect(options.notifyResize).toHaveBeenCalledOnce();
  });
});
