import type { PluginStatus } from '../plugins/types';
import { safeHTTPURL } from './decode';
import { assertInspectionRequest } from './inspectionQuote';
import { isPrerelease } from './versionChoices';
import { compareMarketVersions } from './versionCompare';
import type { MarketPlugin, MarketSource } from './types';
import type { MarketVersionChoice } from './versionsApi';

export interface InstalledPluginUpdate {
  installedVersion: string;
  plugin: MarketPlugin;
  source: MarketSource;
}
export type InstalledPluginIdentity = Pick<PluginStatus['manifest'], 'id' | 'version'>;

const validVersion = (version: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);

export function findInstalledPluginUpdate(installed: InstalledPluginIdentity, source: MarketSource, choices: readonly MarketVersionChoice[]): InstalledPluginUpdate | undefined {
  if (!source.enabled || !validVersion(installed.version)) return undefined;
  let selected: MarketPlugin | undefined;
  for (const { plugin, compatible } of choices) {
    if (!compatible || plugin.id !== installed.id || plugin.sourceId !== source.sourceId || !validVersion(plugin.version)
      || compareMarketVersions(plugin.version, installed.version) <= 0 || (!isPrerelease(installed.version) && isPrerelease(plugin.version))) continue;
    const artifact = plugin.artifact;
    if (!artifact || artifact.version !== plugin.version || !safeHTTPURL(artifact.url)) continue;
    try { assertInspectionRequest({ id: plugin.id, version: plugin.version, sourceId: source.sourceId, artifactDigest: artifact.sha256, sizeBytes: artifact.sizeBytes }); }
    catch { continue; }
    if (!selected || compareMarketVersions(plugin.version, selected.version) > 0) selected = plugin;
  }
  return selected ? { installedVersion: installed.version, plugin: selected, source } : undefined;
}

// Prefer the configured official registry when duplicate IDs exist. The source
// remains visible, and the host revalidates install provenance before replacing.
export function preferredInstalledPluginUpdate(candidates: readonly InstalledPluginUpdate[]): InstalledPluginUpdate | undefined {
  return [...candidates].sort((a, b) => Number(b.source.trustedOfficial) - Number(a.source.trustedOfficial)
    || compareMarketVersions(b.plugin.version, a.plugin.version) || a.source.sourceId.localeCompare(b.source.sourceId))[0];
}
