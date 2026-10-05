import { describe, expect, it } from 'vitest';

import {
  OCR_DARK_MEAN_LUMINANCE,
  OCR_MAX_UPSCALE,
  OCR_TARGET_MAX_SIDE,
  OCR_TARGET_MIN_SIDE,
  meanLuminance,
  planOcrCanvas,
  shouldInvertForOcr,
  toOcrGrayscale,
} from './ocrImagePrepare';

const pixels = (r: number, g: number, b: number, count = 64) => {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) data.set([r, g, b, 255], i * 4);
  return data;
};

describe('planOcrCanvas', () => {
  it('enlarges small text, but never more than the limit', () => {
    const snippet = planOcrCanvas(700, 200);
    expect(snippet.scale).toBeCloseTo(OCR_TARGET_MIN_SIDE / 700);
    expect(snippet.width).toBe(OCR_TARGET_MIN_SIDE);
    const tiny = planOcrCanvas(200, 80);
    expect(tiny.scale).toBe(OCR_MAX_UPSCALE);
    expect(tiny.width).toBe(600);
  });

  it('shrinks very large images to what the recognizer can use', () => {
    const plan = planOcrCanvas(6000, 3000);
    expect(plan.width).toBe(OCR_TARGET_MAX_SIDE);
    expect(plan.height).toBe(OCR_TARGET_MAX_SIDE / 2);
  });

  it('leaves a normal screenshot as it is', () => {
    expect(planOcrCanvas(1920, 1080)).toEqual({ width: 1920, height: 1080, scale: 1 });
  });

  it('never makes an empty canvas', () => {
    const plan = planOcrCanvas(1, 1);
    expect(plan.width).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThan(0);
  });
});

describe('inverting dark screenshots', () => {
  it('measures brightness the way the eye does', () => {
    expect(meanLuminance(pixels(255, 255, 255))).toBeCloseTo(255);
    expect(meanLuminance(pixels(0, 0, 0))).toBe(0);
    expect(meanLuminance(pixels(255, 0, 0))).toBeCloseTo(76.245, 1);
    expect(meanLuminance(new Uint8ClampedArray(0))).toBe(255); // nothing to judge: leave it alone
  });

  it('inverts a dark editor and leaves a light page', () => {
    expect(shouldInvertForOcr(pixels(30, 30, 30))).toBe(true);
    expect(shouldInvertForOcr(pixels(250, 250, 250))).toBe(false);
    const threshold = OCR_DARK_MEAN_LUMINANCE;
    expect(shouldInvertForOcr(pixels(threshold - 1, threshold - 1, threshold - 1))).toBe(true);
    // (a grey of exactly the threshold sums to a hair under it in floating point, so test a step above)
    expect(shouldInvertForOcr(pixels(threshold + 2, threshold + 2, threshold + 2))).toBe(false);
  });

  it('writes grayscale back, inverted when asked, and always opaque', () => {
    const plain = pixels(200, 100, 50, 1);
    plain[3] = 0;
    toOcrGrayscale(plain, false);
    expect(plain[0]).toBe(plain[1]);
    expect(plain[1]).toBe(plain[2]);
    expect(plain[3]).toBe(255);
    const inverted = pixels(10, 10, 10, 1);
    toOcrGrayscale(inverted, true);
    expect(inverted[0]).toBe(245);
  });
});
