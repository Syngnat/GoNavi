const DEFAULT_OPACITY = 1.0;
const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1.0;

// 平台透明度映射因子：值越大，滑块变化越平滑（1.0 = 线性映射）
const MAC_OPACITY_FACTOR = 0.60;
const MAC_BLUR_FACTOR = 1.00;
const WINDOWS_OPACITY_FACTOR = 0.70;
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
  // 用户显式拉到 100%% 时，必须保持完全不透明，不能再被平台映射压低。
  if (raw >= MAX_OPACITY - 1e-6) {
    return MAX_OPACITY;
  }
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
