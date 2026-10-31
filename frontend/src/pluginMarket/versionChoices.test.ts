import { expect, it } from 'vitest';
import { isMarketDowngrade, isPrerelease, recommendedMarketVersion } from './versionChoices';
import type { MarketVersionChoice } from './versionsApi';
const choice=(version:string,compatible=true):MarketVersionChoice=>({plugin:{id:'acme.example',name:'Example',description:'',author:'',publisherId:'acme',official:false,version,platforms:['any'],ratingAverage:0,ratingCount:0,downloadCount:0,updatedAt:'2026-10-25T00:00:00Z'},compatible,reason:compatible?'':'host_version'});
it('recommends the highest compatible stable version, not the newest prerelease',()=>{expect(recommendedMarketVersion([choice('9.0.0',false),choice('3.0.0-rc.1'),choice('1.0.0'),choice('2.0.0')])).toBe('2.0.0')});
it('never silently selects a prerelease',()=>{expect(recommendedMarketVersion([choice('3.0.0-rc.1')])).toBeUndefined()});
it('ignores build metadata when classifying prereleases',()=>{expect(isPrerelease('1.0.0+build-dev')).toBe(false);expect(isPrerelease('1.0.0-rc.1+build')).toBe(true)});
it('requires additional confirmation only for a real downgrade',()=>{expect(isMarketDowngrade('1.0.0','2.0.0')).toBe(true);expect(isMarketDowngrade('1.0.0','1.0.0+build')).toBe(false);expect(isMarketDowngrade('2.0.0','1.0.0')).toBe(false);expect(isMarketDowngrade('1.0.0')).toBe(false)});
