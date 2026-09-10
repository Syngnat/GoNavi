import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateMacOSDockCornerRadius,
  calculateMacOSDockImageRect,
  composeMacOSDockIconBase64,
  shouldSyncApplicationBrandIcon,
} from './macDockIcon';

describe('shouldSyncApplicationBrandIcon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows native macOS and Windows runtimes', () => {
    expect(shouldSyncApplicationBrandIcon({ platform: 'darwin', buildType: 'production' })).toBe(true);
    expect(shouldSyncApplicationBrandIcon({ platform: 'DARWIN', buildType: 'debug' })).toBe(true);
    expect(shouldSyncApplicationBrandIcon({ platform: 'windows', buildType: 'production' })).toBe(true);
    expect(shouldSyncApplicationBrandIcon({ platform: 'WINDOWS', buildType: 'debug' })).toBe(true);
  });

  it('skips browser and unsupported desktop runtimes before image composition', () => {
    expect(shouldSyncApplicationBrandIcon({ platform: 'darwin', buildType: 'web' })).toBe(false);
    expect(shouldSyncApplicationBrandIcon({ platform: 'windows', buildType: 'web' })).toBe(false);
    expect(shouldSyncApplicationBrandIcon({ platform: 'linux', buildType: 'production' })).toBe(false);
    expect(shouldSyncApplicationBrandIcon()).toBe(false);
  });

  it('fills the Dock canvas so GoNavi matches neighboring macOS app icons', () => {
    const rect = calculateMacOSDockImageRect(512, 512);

    expect(rect).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 1024,
    });
    expect(calculateMacOSDockCornerRadius(rect)).toBe(229);
  });

  it('centres portrait brand lockups without stretching them into a square', () => {
    expect(calculateMacOSDockImageRect(272, 449)).toEqual({
      x: 202,
      y: 0,
      width: 620,
      height: 1024,
    });
  });

  it('clips the complete brand image to the standard macOS rounded tile before drawing', async () => {
    const calls: string[] = [];
    const arcTo = vi.fn((...args: number[]) => calls.push(`arcTo:${args[4]}`));
    const context = {
      beginPath: vi.fn(() => calls.push('beginPath')),
      moveTo: vi.fn(() => calls.push('moveTo')),
      lineTo: vi.fn(() => calls.push('lineTo')),
      arcTo,
      closePath: vi.fn(() => calls.push('closePath')),
      clip: vi.fn(() => calls.push('clip')),
      drawImage: vi.fn(() => calls.push('drawImage')),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => 'data:image/png;base64,encoded'),
    } as unknown as HTMLCanvasElement;

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 512;
      naturalHeight = 512;
      width = 512;
      height = 512;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });

    await expect(composeMacOSDockIconBase64('/brand-icons/03-ribbon-graphite-glow.webp')).resolves.toBe('encoded');
    expect(arcTo.mock.calls.map((args) => args[4])).toEqual([229, 229, 229, 229]);
    expect(calls.indexOf('clip')).toBeGreaterThan(calls.indexOf('beginPath'));
    expect(calls.indexOf('drawImage')).toBeGreaterThan(calls.indexOf('clip'));
  });
});
