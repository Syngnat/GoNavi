import { GetBrandIconDataURL } from '../../wailsjs/go/app/App';
import { isBrandAssetLoaded, setLoadedBrandIconSources } from './brandIcons';

// 远端品牌资源（缎带 SVG 与 07–16 吉祥物）的按需加载：Go 侧负责下载、SHA-256 校验与本地缓存，
// 这里只做按资源键去重与变更通知，供应用外壳与图标选择器共用同一份加载状态。

const inflightBrandAssets = new Map<string, Promise<boolean>>();
const brandAssetListeners = new Set<() => void>();
let brandAssetsRevision = 0;

export function subscribeBrandAssets(listener: () => void): () => void {
  brandAssetListeners.add(listener);
  return () => {
    brandAssetListeners.delete(listener);
  };
}

export function getBrandAssetsRevision(): number {
  return brandAssetsRevision;
}

function loadBrandAsset(key: string): Promise<boolean> {
  const inflight = inflightBrandAssets.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const source = await GetBrandIconDataURL(key);
      if (!source) return false;
      setLoadedBrandIconSources({ [key]: source });
      return true;
    } catch {
      // 离线或镜像不可达时保持占位图，UI 依旧可用；下次请求会重试。
      return false;
    } finally {
      inflightBrandAssets.delete(key);
    }
  })();
  inflightBrandAssets.set(key, task);
  return task;
}

/** Loads the given asset keys once; resolves true when every key is available. */
export async function ensureBrandAssets(keys: string[]): Promise<boolean> {
  const missing = keys.filter((key) => !isBrandAssetLoaded(key));
  if (missing.length > 0) {
    const results = await Promise.all(missing.map(loadBrandAsset));
    if (results.some(Boolean)) {
      brandAssetsRevision += 1;
      brandAssetListeners.forEach((listener) => listener());
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('gonavi-brand-assets-ready'));
      }
    }
  }
  return keys.every(isBrandAssetLoaded);
}
