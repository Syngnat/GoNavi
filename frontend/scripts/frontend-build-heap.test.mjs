import { describe, expect, it } from 'vitest';
import {
  MIN_BUILD_HEAP_MB,
  PREFERRED_BUILD_HEAP_MB,
  isOutOfMemoryExit,
  resolveBuildHeapLimitMB,
} from './frontend-build-heap.mjs';

describe('resolveBuildHeapLimitMB', () => {
  it('raises the ~2GB V8 default on an 8GB machine to the preferred limit', () => {
    expect(resolveBuildHeapLimitMB({ memoryMB: 7812, currentLimitMB: 2096 })).toBe(PREFERRED_BUILD_HEAP_MB);
  });

  it('grants only the minimum workable limit on a small machine', () => {
    expect(resolveBuildHeapLimitMB({ memoryMB: 3900, currentLimitMB: 1950 })).toBe(MIN_BUILD_HEAP_MB);
  });

  it('keeps a limit that is already large enough', () => {
    expect(resolveBuildHeapLimitMB({ memoryMB: 32000, currentLimitMB: 4144 })).toBeNull();
    expect(resolveBuildHeapLimitMB({ memoryMB: 7812, currentLimitMB: 8240 })).toBeNull();
  });
});

describe('isOutOfMemoryExit', () => {
  it.each([
    [{ status: null, signal: 'SIGABRT' }, true],
    [{ status: null, signal: 'SIGKILL' }, true],
    [{ status: 134, signal: null }, true],
    [{ status: 137, signal: null }, true],
    [{ status: 2, signal: null }, false],
    [{ status: null, signal: 'SIGINT' }, false],
  ])('classifies %o as %s', (result, expected) => {
    expect(isOutOfMemoryExit(result)).toBe(expected);
  });
});
