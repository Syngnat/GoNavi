import type { MarketInspectionRequest, MarketPlugin } from './types';

export interface MarketInstallIdentity { repository: string }

export function marketInstallRepository(plugin: MarketPlugin, sourceBaseUrl: string): string {
  return plugin.sourceUrl?.trim() || sourceBaseUrl.trim();
}

export function marketInstallIdentity(plugin: MarketPlugin, sourceBaseUrl: string): MarketInstallIdentity {
  return { repository: marketInstallRepository(plugin, sourceBaseUrl) };
}

export function marketInstallConfirmationMatches(expected: MarketInstallIdentity, repository: string): boolean {
  const typed = repository.trim();
  return typed.length > 0 && typed === expected.repository.trim();
}

export function marketInspectionRequest(plugin: MarketPlugin, sourceId: string | undefined): MarketInspectionRequest | null {
  const artifact = plugin.artifact;
  if (!artifact || !sourceId || !/^[a-f0-9]{64}$/.test(sourceId) || plugin.sourceId !== sourceId
    || artifact.version !== plugin.version || artifact.sizeBytes <= 0) return null;
  return { id: plugin.id, version: plugin.version, artifactDigest: artifact.sha256, sourceId, sizeBytes: artifact.sizeBytes };
}
