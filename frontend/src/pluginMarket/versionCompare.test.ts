import { describe, expect, it } from 'vitest';
import { compareMarketVersions } from './versionCompare';

describe('compareMarketVersions', () => {
  it.each([
    ['older patch', '1.0.0', '1.0.1', -1],
    ['older minor', '1.0.9', '1.2.0', -1],
    ['older major', '2.9.9', '3.0.0', -1],
    ['equal versions', '1.2.3', '1.2.3', 0],
    ['newer patch', '1.0.2', '1.0.1', 1],
    ['ignores v prefix', 'v1.0.0', '1.0.0', 0],
    ['ignores build metadata', '1.0.0+build.9', '1.0.0', 0],
    ['prerelease below release', '1.0.0-rc.1', '1.0.0', -1],
    ['newer prerelease above older', '1.0.0-rc.2', '1.0.0-rc.1', 1],
    ['numeric identifiers sort numerically', '1.0.0-rc.9', '1.0.0-rc.10', -1],
    ['numeric below alphanumeric', '1.0.0-1', '1.0.0-alpha', -1],
    ['missing patch treated as zero', '1.0', '1.0.0', 0],
    ['empty values are unordered', '', '1.0.0', 0],
  ] as const)('%s', (name, left, right, expected) => {
    expect(compareMarketVersions(left, right)).toBe(expected);
  });
});
