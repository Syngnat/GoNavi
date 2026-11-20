/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueryEditorViewportStabilizer } from './useQueryEditorViewportStabilizer';

const layout = vi.fn();
const render = vi.fn();
const updateOptions = vi.fn();

interface HarnessProps {
  isActive: boolean;
  editorRef: React.MutableRefObject<{
    updateOptions: (options: { automaticLayout: boolean }) => void;
    layout: () => void;
    render: (forceRedraw?: boolean) => void;
  } | null>;
  stageRef: React.MutableRefObject<HTMLElement | null>;
  shellRef: React.MutableRefObject<HTMLElement | null>;
}

const Harness: React.FC<HarnessProps> = ({ isActive, editorRef, stageRef, shellRef }) => {
  useQueryEditorViewportStabilizer({
    isActive,
    editorRef,
    editorStageRef: stageRef,
    editorShellRef: shellRef,
  });
  return null;
};

describe('useQueryEditorViewportStabilizer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let resizeObserverCallback: ResizeObserverCallback | null;

  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }

    observe = vi.fn();

    disconnect = vi.fn();
  }

  const flushFrame = async () => {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    await act(async () => {
      callbacks.forEach((callback) => callback(Date.now()));
    });
  };

  const runInitialLayout = async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushFrame();
  };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    layout.mockReset();
    render.mockReset();
    updateOptions.mockReset();
    rafCallbacks = new Map();
    nextRafId = 0;
    resizeObserverCallback = null;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextRafId;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const mount = async ({
    isActive,
    width = 800,
    height = 600,
  }: {
    isActive: boolean;
    width?: number;
    height?: number;
  }) => {
    const editorRef = { current: { updateOptions, layout, render } };
    const target = {
      getBoundingClientRect: () => ({ width, height }),
    } as unknown as HTMLElement;
    const stageRef = { current: target };
    const shellRef = { current: null };
    await act(async () => {
      root.render(
        <Harness
          isActive={isActive}
          editorRef={editorRef}
          stageRef={stageRef}
          shellRef={shellRef}
        />,
      );
    });
    return { editorRef, stageRef, shellRef, target };
  };

  it('lays out and redraws after the active editor mounts', async () => {
    await mount({ isActive: true });
    await runInitialLayout();

    expect(layout).toHaveBeenCalled();
    expect(updateOptions).toHaveBeenCalledWith({ automaticLayout: true });
    expect(render).toHaveBeenCalled();
  });

  it('forces layout when the window becomes focused again', async () => {
    await mount({ isActive: true });
    await runInitialLayout();
    layout.mockClear();
    render.mockClear();

    window.dispatchEvent(new Event('focus'));
    await flushFrame();

    expect(layout).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalled();
  });

  it('lays out again when the observed editor container changes size', async () => {
    const { stageRef } = await mount({ isActive: true, width: 800, height: 600 });
    await runInitialLayout();
    layout.mockClear();
    render.mockClear();

    stageRef.current = {
      getBoundingClientRect: () => ({ width: 1200, height: 900 }),
    } as unknown as HTMLElement;
    resizeObserverCallback?.([], {} as ResizeObserver);
    await flushFrame();

    expect(layout).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  it('does not touch an inactive editor', async () => {
    await mount({ isActive: false });
    await runInitialLayout();
    window.dispatchEvent(new Event('focus'));
    await flushFrame();

    expect(layout).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('repairs an editor that mounted while inactive and became active later', async () => {
    const editorRef: HarnessProps['editorRef'] = { current: { updateOptions, layout, render } };
    const stageRef: HarnessProps['stageRef'] = {
      current: {
        getBoundingClientRect: () => ({ width: 1000, height: 720 }),
      } as unknown as HTMLElement,
    };
    const shellRef: HarnessProps['shellRef'] = { current: null };
    const renderHarness = async (active: boolean) => {
      await act(async () => {
        root.render(
          <Harness
            isActive={active}
            editorRef={editorRef}
            stageRef={stageRef}
            shellRef={shellRef}
          />,
        );
      });
    };

    await renderHarness(false);
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(layout).not.toHaveBeenCalled();

    await renderHarness(true);
    await runInitialLayout();

    expect(updateOptions).toHaveBeenCalledWith({ automaticLayout: true });
    expect(layout).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });
});
