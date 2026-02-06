const DEFAULT_OPACITY = 0.95;
const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1.0;

// macOS 端进一步增强通透感：同滑块值下更低等效不透明度、降低过重模糊。
const MAC_OPACITY_FACTOR = 0.20;
const MAC_BLUR_FACTOR = 1.00;
const WINDOWS_OPACITY_FACTOR = 0.20;
const WINDOWS_BLUR_FACTOR = 1.00;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const isMacLikePlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /(Mac|iPhone|iPad|iPod)/i.test(`${platform} ${ua}`);
};

export const isWindowsPlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /(Win|Windows)/i.test(`${platform} ${ua}`);
};

const getPlatformFactors = () => {
  if (isMacLikePlatform()) {
    return { opacity: MAC_OPACITY_FACTOR, blur: MAC_BLUR_FACTOR };
  }
  if (isWindowsPlatform()) {
    return { opacity: WINDOWS_OPACITY_FACTOR, blur: WINDOWS_BLUR_FACTOR };
  }
  return undefined;
};

export const normalizeOpacityForPlatform = (opacity: number | undefined): number => {
  const raw = clamp(opacity ?? DEFAULT_OPACITY, MIN_OPACITY, MAX_OPACITY);
  const factors = getPlatformFactors();
  if (!factors) {
    return raw;
  }

  return clamp(MIN_OPACITY + (raw - MIN_OPACITY) * factors.opacity, MIN_OPACITY, MAX_OPACITY);
};

export const normalizeBlurForPlatform = (blur: number | undefined): number => {
  const raw = Math.max(0, blur ?? 0);
  const factors = getPlatformFactors();
  if (!factors) {
    return raw;
  }
  return Math.round(raw * factors.blur);
};

export const blurToFilter = (blur: number): string | undefined => {
  return blur > 0 ? `blur(${blur}px)` : undefined;
};
