import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ensureBrandAssetsMock = vi.hoisted(() => vi.fn(async () => true));
const composeMacOSDockIcon = vi.hoisted(() => vi.fn(async () => 'b64'));
const composeWindowsNativeIcon = vi.hoisted(() => vi.fn(async () => 'b64'));
// 可配置的运行环境与品牌定义：默认保持原生同步不触发，避免影响既有用例。
const environmentState = vi.hoisted(() => ({ shouldSync: false, platform: 'windows' }));
const brandDefinitionState = vi.hoisted(() => ({
  value: { mascot: true } as { mascot?: boolean; bundled?: boolean },
}));

vi.mock('antd', () => ({ message: messageApi }));
vi.mock('../store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));
vi.mock('../../wailsjs/go/app/App', () => ({
  SetApplicationBrandIcon: setApplicationBrandIcon,
  GetBrandIconDataURL: vi.fn(),
}));
vi.mock('../../wailsjs/runtime', () => ({
  Environment: vi.fn(async () => ({ platform: environmentState.platform, buildType: 'production' })),
}));
vi.mock('../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
}));
vi.mock('./brandIcons', () => ({
  resolveBrandIconSrc: () => 'asset:icon',
  resolveBrandDockSrc: (id: string) => `dock:${id}`,
  resolveBrandNativeSrc: (id: string) => `dock:${id}`,
  resolveBrandIcon: () => brandDefinitionState.value,
  brandAssetKeysFor: () => [],
  startupBrandAssetKeys: () => ['startup-keys'],
  previewBrandAssetKeys: () => ['preview-keys'],
}));
vi.mock('./brandAssetLoader', () => ({
  ensureBrandAssets: ensureBrandAssetsMock,
  subscribeBrandAssets: () => () => {},
  getBrandAssetsRevision: () => 0,
}));
vi.mock('./macDockIcon', () => ({
  composeWindowsNativeIconBase64: composeWindowsNativeIcon,
  composeMacOSDockIconBase64: composeMacOSDockIcon,
  LEGACY_MASCOT_DOCK_ICON_INSET: 100,
  shouldSyncApplicationBrandIcon: () => environmentState.shouldSync,
}));

let capturedHandler: (id: BrandIconId) => Promise<void>;

const Harness = (): null => {
  const { handleBrandIconChange } = useBrandIconSync('windows');
  capturedHandler = handleBrandIconChange;
  return null;
};

describe('useBrandIconSync startup asset prefetch', () => {
  beforeEach(() => {
    ensureBrandAssetsMock.mockClear();
  });

  it('prefetches startup keys and the full picker preview set on mount', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(Harness));
    });
    await act(async () => {});
    void renderer;

    expect(ensureBrandAssetsMock).toHaveBeenCalledWith(['startup-keys']);
    // 首装首次打开选择器时吉祥物必须已就绪或处于骨架态，
    // 不能渲染深色兜底剪影——启动即后台补齐全部预览资源。
    expect(ensureBrandAssetsMock).toHaveBeenCalledWith(['preview-keys']);
  });
});

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

describe('useBrandIconSync native dock icon composition', () => {
  const DarwinHarness = (): null => {
    useBrandIconSync('darwin');
    return null;
  };

  beforeEach(() => {
    storeState.brandIconId = 'legacy';
    setApplicationBrandIcon.mockReset();
    setApplicationBrandIcon.mockResolvedValue({ success: true });
    composeMacOSDockIcon.mockClear();
    composeWindowsNativeIcon.mockClear();
    environmentState.shouldSync = true;
    environmentState.platform = 'darwin';
    brandDefinitionState.value = { mascot: false, bundled: true };
    // node 测试环境没有 document：提供最小的 favicon 存根，
    // 让同步 effect 越过入口守卫走到原生合成。
    vi.stubGlobal('document', {
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => {} }),
      head: { appendChild: () => {} },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    environmentState.shouldSync = false;
    environmentState.platform = 'windows';
    brandDefinitionState.value = { mascot: true };
  });

  it('composes the bundled dark-tile default full-bleed without the mascot safe-area inset', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(DarwinHarness));
    });
    await act(async () => {});
    void renderer;

    expect(composeMacOSDockIcon).toHaveBeenCalledTimes(1);
    expect(composeMacOSDockIcon).toHaveBeenCalledWith('dock:legacy', { inset: undefined });
    expect(composeWindowsNativeIcon).not.toHaveBeenCalled();
    expect(setApplicationBrandIcon).toHaveBeenCalledWith('b64');
  });

  it('keeps the white-tile mascot safe-area inset on macOS', async () => {
    brandDefinitionState.value = { mascot: true, bundled: false };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(React.createElement(DarwinHarness));
    });
    await act(async () => {});
    void renderer;

    expect(composeMacOSDockIcon).toHaveBeenCalledTimes(1);
    expect(composeMacOSDockIcon).toHaveBeenCalledWith('dock:legacy', { inset: 100 });
    expect(setApplicationBrandIcon).toHaveBeenCalledWith('b64');
  });
});
