import { expect, it } from 'vitest';
import { compareMarketVersions } from './versionCompare';
it.each([['9007199254740992.0.0','9007199254740993.0.0'],['1.0.0-9007199254740992','1.0.0-9007199254740993'],['1.9007199254740992.0','1.9007199254740993.0']])('orders large semver integers without precision loss: %s', (left,right)=>{expect(compareMarketVersions(left,right)).toBeLessThan(0)});
