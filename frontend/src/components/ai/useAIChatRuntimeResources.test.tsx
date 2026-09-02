import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIChatRuntimeResources } from './useAIChatRuntimeResources';
const runtimeService = vi.hoisted(() => ({
  AIListModels: vi.fn(),
}));
const windowStub = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  setTimeout,
}));

let latestHook: ReturnType<typeof useAIChatRuntimeResources> | undefined;

const flushAsyncWork = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const Harness = () => {
  latestHook = useAIChatRuntimeResources({});
  return null;
};

describe('useAIChatRuntimeResources', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    latestHook = undefined;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      ...windowStub,
      go: {
        aiservice: {
          Service: runtimeService,
        },
      },
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('uses English notice chrome for thrown model load failures while preserving raw detail', async () => {
    runtimeService.AIListModels.mockRejectedValue(new Error('HTTP 401 raw error'));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await flushAsyncWork();

    await act(async () => {
      await latestHook!.fetchDynamicModels();
    });
    await flushAsyncWork();

    expect(latestHook!.composerNotice).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'HTTP 401 raw error',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('uses the default English description when the thrown model load error has no message', async () => {
    runtimeService.AIListModels.mockRejectedValue({});

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await flushAsyncWork();

    await act(async () => {
      await latestHook!.fetchDynamicModels();
    });
    await flushAsyncWork();

    expect(latestHook!.composerNotice).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'Check the provider endpoint, API Key, or account permissions, then reopen the model dropdown.',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('does not require a browser window while a detached surface is rendered server-side', async () => {
    vi.unstubAllGlobals();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.unmount();
    });
  });
});
