/**
 * Getting an image ready for the recognizer. It reads dark text on a light ground
 * best and wants characters around 20-30 px tall: a screenshot of a dark-themed
 * editor, or of small text, is first inverted and enlarged. The decisions are pure
 * functions; the canvas work only applies them.
 */

/** Longest side the recognizer is given, and the longest side below which an image is enlarged. */
export const OCR_TARGET_MAX_SIDE = 3000;
export const OCR_TARGET_MIN_SIDE = 1400;
/** The most an image is enlarged. */
export const OCR_MAX_UPSCALE = 3;
/** Larger images (in pixels) or files (in encoded bytes) are not read. */
export const OCR_MAX_PIXELS = 40_000_000;
export const OCR_MAX_DATA_URL_CHARS = 28 * 1024 * 1024;
/** Below this mean brightness (0-255) an image is taken to be light text on a dark ground. */
export const OCR_DARK_MEAN_LUMINANCE = 118;

export interface OcrCanvasPlan {
  width: number;
  height: number;
  scale: number;
}

export const planOcrCanvas = (width: number, height: number): OcrCanvasPlan => {
  const longest = Math.max(width, height);
  let scale = 1;
  if (longest > OCR_TARGET_MAX_SIDE) {
    scale = OCR_TARGET_MAX_SIDE / longest;
  } else if (longest < OCR_TARGET_MIN_SIDE) {
    scale = Math.min(OCR_MAX_UPSCALE, OCR_TARGET_MIN_SIDE / longest);
  }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
};

const luminance = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/** Mean brightness of RGBA pixels, sampled so a large image costs little. */
export const meanLuminance = (rgba: ArrayLike<number>, sampleEvery = 16): number => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4 * sampleEvery) {
    sum += luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
    count += 1;
  }
  return count === 0 ? 255 : sum / count;
};

export const shouldInvertForOcr = (rgba: ArrayLike<number>): boolean => meanLuminance(rgba) < OCR_DARK_MEAN_LUMINANCE;

/** Grayscale, inverted when the image is light-on-dark, written back in place. */
export const toOcrGrayscale = (rgba: Uint8ClampedArray, invert: boolean): void => {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const gray = luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
    const value = invert ? 255 - gray : gray;
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
};

export class OcrImageError extends Error {
  constructor(readonly reason: 'too_large' | 'unreadable', message: string) {
    super(message);
    this.name = 'OcrImageError';
  }
}

const loadImage = (dataUrl: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new OcrImageError('unreadable', 'the image could not be decoded'));
  image.src = dataUrl;
});

/** Draws the image the way the recognizer reads best and returns it as a PNG. */
export const prepareImageForOcr = async (dataUrl: string): Promise<Blob> => {
  if (dataUrl.length > OCR_MAX_DATA_URL_CHARS) {
    throw new OcrImageError('too_large', 'the image file is too large');
  }
  const image = await loadImage(dataUrl);
  if (image.naturalWidth * image.naturalHeight > OCR_MAX_PIXELS) {
    throw new OcrImageError('too_large', 'the image has too many pixels');
  }
  const plan = planOcrCanvas(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new OcrImageError('unreadable', 'no canvas available');
  }
  // A transparent screenshot would otherwise turn black when flattened.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, plan.width, plan.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, plan.width, plan.height);
  const pixels = context.getImageData(0, 0, plan.width, plan.height);
  toOcrGrayscale(pixels.data, shouldInvertForOcr(pixels.data));
  context.putImageData(pixels, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new OcrImageError('unreadable', 'the image could not be encoded'))), 'image/png');
  });
};
