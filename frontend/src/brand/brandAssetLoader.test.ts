import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBrandIconDataURL = vi.hoisted(() => vi.fn());

vi.mock('../../wailsjs/go/app/App', () => ({
  GetBrandIconDataURL: getBrandIconDataURL,
}));

describe('brand asset loader', () => {
  beforeEach(() => {
    vi.resetModules();
    getBrandIconDataURL.mockReset();
  });

  it('downloads each asset key once even when requested concurrently', async () => {
    let release!: () => void;
    getBrandIconDataURL.mockImplementation((key: string) => new Promise((resolve) => {
      release = () => resolve(`data:image/webp;base64,${key}`);
    }));
    const { ensureBrandAssets } = await import('./brandAssetLoader');
    const { resolveBrandIconSrc } = await import('./brandIcons');

    const first = ensureBrandAssets(['07']);
    const second = ensureBrandAssets(['07']);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(getBrandIconDataURL).toHaveBeenCalledTimes(1);
    expect(resolveBrandIconSrc('07')).toBe('data:image/webp;base64,07');
    await expect(ensureBrandAssets(['07'])).resolves.toBe(true);
    expect(getBrandIconDataURL).toHaveBeenCalledTimes(1);
  });

  it('bumps the revision and notifies subscribers only when something loaded', async () => {
    getBrandIconDataURL.mockImplementation(async (key: string) => (key === '09' ? 'data:image/webp;base64,09' : ''));
    const { ensureBrandAssets, getBrandAssetsRevision, subscribeBrandAssets } = await import('./brandAssetLoader');
    const listener = vi.fn();
    const unsubscribe = subscribeBrandAssets(listener);

    await expect(ensureBrandAssets(['10'])).resolves.toBe(false);
    expect(getBrandAssetsRevision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    await expect(ensureBrandAssets(['09', '10'])).resolves.toBe(false);
    expect(getBrandAssetsRevision()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps the placeholder when the mirror is unreachable and retries on the next request', async () => {
    getBrandIconDataURL.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('data:image/webp;base64,11');
    const { ensureBrandAssets } = await import('./brandAssetLoader');
    const { BRAND_ICON_FALLBACK_SRC, resolveBrandIconSrc } = await import('./brandIcons');

    await expect(ensureBrandAssets(['11'])).resolves.toBe(false);
    expect(resolveBrandIconSrc('11')).toBe(BRAND_ICON_FALLBACK_SRC);
    await expect(ensureBrandAssets(['11'])).resolves.toBe(true);
    expect(resolveBrandIconSrc('11')).toBe('data:image/webp;base64,11');
  });
});
