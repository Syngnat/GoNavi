import { compareMarketVersions } from './versionCompare';
import type { MarketVersionChoice } from './versionsApi';
export const isPrerelease = (version: string): boolean => version.split('+')[0].includes('-');
export function orderVersionChoices(choices: readonly MarketVersionChoice[]): MarketVersionChoice[] {
 return [...choices].sort((a, b) => compareMarketVersions(b.plugin.version, a.plugin.version));
}
export function recommendedMarketVersion(choices: readonly MarketVersionChoice[]): string | undefined {
 return orderVersionChoices(choices).find((choice) => choice.compatible && !isPrerelease(choice.plugin.version))?.plugin.version;
}
export function isMarketDowngrade(selected: string, installed?: string): boolean {
 return Boolean(installed && compareMarketVersions(selected, installed) < 0);
}
