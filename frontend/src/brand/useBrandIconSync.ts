import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { SetApplicationBrandIcon, GetBrandIconDataURL } from '../../wailsjs/go/app/App';
import { Environment } from '../../wailsjs/runtime';
import { useI18n } from '../i18n/provider';
import { useStore } from '../store';
import {
  BRAND_ICONS,
  resolveBrandDockSrc,
  resolveBrandIconSrc,
  resolveBrandIcon,
  setLoadedBrandIconSources,
  type BrandIconId,
} from './brandIcons';
import {
  composeMacOSDockIconBase64,
  composeWindowsNativeIconBase64,
  LEGACY_MASCOT_DOCK_ICON_INSET,
  shouldSyncApplicationBrandIcon,
} from './macDockIcon';

// 品牌图标的原生同步领域逻辑：favicon、Windows/macOS 原生图标应用、
// 远程缎带资源加载与设置面板的选择流程。App.tsx 只保留接线。
export function useBrandIconSync(runtimePlatform: string) {
  const { t } = useI18n();
  const brandIconId = useStore(state => state.brandIconId);
  const setBrandIconId = useStore(state => state.setBrandIconId);
  const [brandAssetRevision, setBrandAssetRevision] = useState(0);
  // Suppresses the brand-icon sync effect while the explicit selection flow is
  // applying the same icon through the native bridge, so the shortcut update
  // and window identity rotation run exactly once.
  const windowsBrandIconApplyingRef = useRef<BrandIconId | null>(null);
  // 最近一次成功应用到原生表面的品牌 ID：选择流程完成后 brandAssetRevision
  // 的自增会重跑同步 effect，没有这个记录就会对同一图标再应用一次。
  const lastNativeAppliedBrandIdRef = useRef<BrandIconId | null>(null);

  // Apply the selected brand mascot to the favicon and supported native OS surfaces.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const href = resolveBrandIconSrc(brandIconId);
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-brand-icon='true']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.setAttribute('data-brand-icon', 'true');
      document.head.appendChild(link);
    }
    // The current ribbon assets are SVG, while the restored 0.9.7 mascot
    // assets are lossless WebP files. Keep the favicon MIME in sync with
    // the selected asset so browsers do not discard the mascot icon.
    link.type = /\.webp(?:[?#]|$)/i.test(href) ? 'image/webp' : 'image/svg+xml';
    link.href = href;

    // The selection flow below updates the live window icon itself;
    // skip this sync while that apply is in flight so the shortcut update
    // and window icon refresh run exactly once.
    if (runtimePlatform === 'windows' && windowsBrandIconApplyingRef.current === brandIconId) {
      return;
    }
    // 同一品牌已经成功应用过（选择流程或上一轮同步），brandAssetRevision
    // 的自增不需要再对同一图标重复应用。
    if (runtimePlatform === 'windows' && lastNativeAppliedBrandIdRef.current === brandIconId) {
      return;
    }

    let cancelled = false;
    const applyNativeIcon = async () => {
      try {
        const environment = await Environment();
        if (cancelled || !shouldSyncApplicationBrandIcon(environment)) {
          return;
        }
        const dockHref = resolveBrandDockSrc(brandIconId);
        // The compact fallback is suitable for UI placeholders, but it
        // must never become the cached Windows taskbar or macOS Dock icon.
        if (!dockHref) return;
        const b64 = runtimePlatform === 'windows'
          ? await composeWindowsNativeIconBase64(dockHref, {
            transparentMark: resolveBrandIcon(brandIconId).bundled ? true : undefined,
          })
          : await composeMacOSDockIconBase64(dockHref, {
            inset: resolveBrandIcon(brandIconId).bundled ? LEGACY_MASCOT_DOCK_ICON_INSET : undefined,
          });
        if (cancelled) return;
        const result = await SetApplicationBrandIcon(b64);
        if (!result.success && !cancelled) {
          console.warn('Failed to update the native application icon:', result.message);
          message.warning(t('app.settings.entry.brand_icon.native_sync_failed'));
        }
        if (result.success) {
          lastNativeAppliedBrandIdRef.current = brandIconId as BrandIconId;
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to update the native application icon:', error);
          message.warning(t('app.settings.entry.brand_icon.native_sync_failed'));
        }
      }
    };
    void applyNativeIcon();
    return () => {
      cancelled = true;
    };
  }, [brandIconId, brandAssetRevision, runtimePlatform, t]);

  const brandAssetsLoadingRef = useRef<Promise<boolean> | null>(null);
  const loadBrandAssets = useCallback(async (): Promise<boolean> => {
    if (brandAssetsLoadingRef.current) return brandAssetsLoadingRef.current;
    const task = (async (): Promise<boolean> => {
      const loaded: Partial<Record<BrandIconId, string>> = {};
      await Promise.all(BRAND_ICONS.filter((icon) => !icon.bundled).map(async (icon) => {
        try {
          const source = await GetBrandIconDataURL(icon.id);
          if (source) loaded[icon.id] = source;
        } catch {
          // 离线或镜像不可达时保持内存占位，UI 依旧可用。
        }
      }));
      if (Object.keys(loaded).length === 0) return false;
      setLoadedBrandIconSources(loaded);
      setBrandAssetRevision((revision) => revision + 1);
      window.dispatchEvent(new Event('gonavi-brand-assets-ready'));
      return true;
    })();
    brandAssetsLoadingRef.current = task;
    try {
      return await task;
    } finally {
      brandAssetsLoadingRef.current = null;
    }
  }, []);
  useEffect(() => {
    void loadBrandAssets();
  }, [loadBrandAssets]);

  const handleBrandIconChange = useCallback(async (id: BrandIconId) => {
    if (id === brandIconId) return;
    const previousId = brandIconId;
    if (runtimePlatform !== 'windows') {
      setBrandIconId(id);
      message.success(t('app.settings.entry.brand_icon.applied'));
      return;
    }

    // Windows writes the new ICO onto existing shortcuts and the live window.
    // The process, live window, and recognized GoNavi pin all keep the same
    // stable Syngnat.GoNavi AppUserModelID — only the icon bitmap changes, so
    // pinned buttons keep launching this process instead of splitting.
    windowsBrandIconApplyingRef.current = id;
    setBrandIconId(id);
    try {
      let source = resolveBrandDockSrc(id);
      if (!source) {
        // 远程缎带资源可能还没下载完成（首屏加载失败/离线）。重试一次；
        // 仍不可用就必须如实回退并警告——绝不能弹「已应用」却什么都不改。
        await loadBrandAssets();
        source = resolveBrandDockSrc(id);
        if (!source) {
          throw Object.assign(new Error(t('app.settings.entry.brand_icon.asset_not_ready')), { assetNotReady: true });
        }
      }
      // Windows fills the whole taskbar tile; the macOS Dock safe-area
      // inset would shrink the ICO mark relative to neighbouring apps.
      // Bundled mascots drop the white tile and the GoNavi word mark —
      // the cut-out dog itself becomes the whole icon, no background.
      const b64 = await composeWindowsNativeIconBase64(source, {
        transparentMark: resolveBrandIcon(id).bundled ? true : undefined,
      });
      const result = await SetApplicationBrandIcon(b64);
      if (!result || result.success === false) {
        throw new Error(result?.message || 'Windows brand icon update failed');
      }
      lastNativeAppliedBrandIdRef.current = id;
      message.success(t('app.settings.entry.brand_icon.applied'));
    } catch (error) {
      // 只有当没有更新的选择接管时才回退：A 失败时用户可能已经改选 B，
      // 无条件回退会把过期的 previousId 写回 store——随后 B 成功时选择器
      // 显示旧图标、原生表面已是 B，直到下一次选择才收敛。
      if (windowsBrandIconApplyingRef.current === id) {
        setBrandIconId(previousId);
      }
      const isAssetNotReady = typeof error === 'object' && error !== null && (error as { assetNotReady?: boolean }).assetNotReady === true;
      if (!isAssetNotReady) {
        console.warn('Failed to apply the Windows brand icon:', error);
      }
      if (isAssetNotReady) {
        message.warning(error instanceof Error ? error.message : t('app.settings.entry.brand_icon.asset_not_ready'));
      } else {
        message.error(t('app.settings.entry.brand_icon.native_sync_failed'));
      }
    } finally {
      if (windowsBrandIconApplyingRef.current === id) {
        windowsBrandIconApplyingRef.current = null;
      }
    }
  }, [brandIconId, loadBrandAssets, runtimePlatform, setBrandIconId, t]);

  return { brandIconId, handleBrandIconChange };
}
