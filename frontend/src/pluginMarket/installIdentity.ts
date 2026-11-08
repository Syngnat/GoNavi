import type { MarketInspectionRequest, MarketPlugin } from './types';

export interface MarketInstallIdentity { name: string; repository: string }

export function marketInstallRepository(plugin: MarketPlugin, sourceBaseUrl: string): string {
  return plugin.sourceUrl?.trim() || sourceBaseUrl.trim();
}

export function marketInstallIdentity(manifestName: string, plugin: MarketPlugin, sourceBaseUrl: string): MarketInstallIdentity {
  return { name: manifestName, repository: marketInstallRepository(plugin, sourceBaseUrl) };
}

export function marketInstallConfirmationMatches(expected: MarketInstallIdentity, name: string, repository: string): boolean {
  return name.trim() === expected.name.trim() && repository.trim() === expected.repository.trim();
}

export function marketInspectionRequest(plugin: MarketPlugin, sourceId: string | undefined): MarketInspectionRequest | null {
  const artifact = plugin.artifact;
  if (!artifact || !sourceId || !/^[a-f0-9]{64}$/.test(sourceId) || plugin.sourceId !== sourceId
    || artifact.version !== plugin.version || artifact.sizeBytes <= 0) return null;
  return { id: plugin.id, version: plugin.version, artifactDigest: artifact.sha256, sourceId, sizeBytes: artifact.sizeBytes };
}
