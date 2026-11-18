import { describe, expect, it } from 'vitest';
import { isWebRequestTooLargeError } from './exportErrorMessage';

describe('isWebRequestTooLargeError', () => {
  it('matches the web bridge status message', () => {
    expect(isWebRequestTooLargeError(new Error('invoke failed with status 413'), 'invoke failed with status 413')).toBe(true);
    expect(isWebRequestTooLargeError(undefined, 'HTTP 413')).toBe(true);
  });

  it('matches an explicit status property', () => {
    expect(isWebRequestTooLargeError({ status: 413 }, 'request failed')).toBe(true);
  });

  it('leaves unrelated export failures alone', () => {
    expect(isWebRequestTooLargeError(new Error('disk full'), 'disk full')).toBe(false);
    expect(isWebRequestTooLargeError({ status: 500 }, 'invoke failed with status 500')).toBe(false);
  });
});
