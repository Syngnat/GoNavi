import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrandIconSync } from './useBrandIconSync';
import type { BrandIconId } from './brandIcons';

const messageApi = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  brandIconId: 'legacy',
  setBrandIconId: (_id: string) => {},
}));

const setApplicationBrandIcon = vi.hoisted(() => vi.fn());

vi.mock('antd', () => ({ message: messageApi }));
vi.mock('../store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));
vi.mock('../../wailsjs/go/app/App', () => ({
  SetApplicationBrandIcon: setApplicationBrandIcon,
  GetBrandIconDataURL: vi.fn(),
}));
vi.mock('../../wailsjs/runtime', () => ({
  Environment: vi.fn(async () => ({ platform: 'windows' })),
}));
vi.mock('../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
}));
vi.mock('./brandIcons', () => ({
  resolveBrandIconSrc: () => 'asset:icon',
  resolveBrandDockSrc: (id: string) => `dock:${id}`,
  resolveBrandIcon: () => ({ bundled: true }),
  setLoadedBrandIconSources: vi.fn(),
  BRAND_ICONS: [],
}));
vi.mock('./macDockIcon', () => ({
  composeWindowsNativeIconBase64: vi.fn(async () => 'b64'),
  composeMacOSDockIconBase64: vi.fn(async () => 'b64'),
  LEGACY_MASCOT_DOCK_ICON_INSET: 0,
  shouldSyncApplicationBrandIcon: () => false,
}));

let capturedHandler: (id: BrandIconId) => Promise<void>;

const Harness = (): null => {
  const { handleBrandIconChange } = useBrandIconSync('windows');
  capturedHandler = handleBrandIconChange;
  return null;
};

describe('useBrandIconSync handleBrandIconChange', () => {
  beforeEach(() => {
    messageApi.success.mockClear();
    messageApi.warning.mockClear();
    messageApi.error.mockClear();
    setApplicationBrandIcon.mockReset();
    storeState.brandIconId = 'legacy';
    storeState.setBrandIconId = (id: string) => { storeState.brandIconId = id; };
    vi.spyOn(storeState, 'setBrandIconId');
  });

  // 审查发现的回归场景：A 在途失败时用户已改选 B，无条件回退会把过期的
  // previousId 写回 store，选择器与已成功应用的原生表面脱节。
  it('does not revert to a stale previous id when a newer selection took over', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(Harness));
    });

    let rejectInFlight!: (error: Error) => void;
    setApplicationBrandIcon.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectInFlight = reject; }),
    );
    const firstApply = capturedHandler('aurora' as BrandIconId);

    setApplicationBrandIcon.mockImplementationOnce(async () => ({ success: true }));
    await act(async () => {
      await capturedHandler('nova' as BrandIconId);
    });
    rejectInFlight(new Error('superseded'));
    await act(async () => {
      await firstApply;
    });
    void renderer;

    expect(storeState.setBrandIconId).toHaveBeenCalledTimes(2);
    expect(storeState.setBrandIconId).toHaveBeenNthCalledWith(1, 'aurora');
    expect(storeState.setBrandIconId).toHaveBeenNthCalledWith(2, 'nova');
    expect(messageApi.error).toHaveBeenCalledTimes(1);
  });

  it('reverts to the previous id when the apply fails without a newer selection', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(Harness));
    });

    setApplicationBrandIcon.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await act(async () => {
      await capturedHandler('aurora' as BrandIconId);
    });
    void renderer;

    expect(storeState.setBrandIconId).toHaveBeenCalledTimes(2);
    expect(storeState.setBrandIconId).toHaveBeenNthCalledWith(1, 'aurora');
    expect(storeState.setBrandIconId).toHaveBeenNthCalledWith(2, 'legacy');
    expect(messageApi.error).toHaveBeenCalledTimes(1);
  });

  it('reports success and keeps the selection when the apply succeeds', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(Harness));
    });

    setApplicationBrandIcon.mockImplementationOnce(async () => ({ success: true }));
    await act(async () => {
      await capturedHandler('aurora' as BrandIconId);
    });
    void renderer;

    expect(storeState.setBrandIconId).toHaveBeenCalledTimes(1);
    expect(storeState.setBrandIconId).toHaveBeenCalledWith('aurora');
    expect(messageApi.success).toHaveBeenCalledTimes(1);
    expect(messageApi.error).not.toHaveBeenCalled();
  });
});
