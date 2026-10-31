import type { PluginInspection, PluginManifest } from '../plugins/types';
export interface MarketArtifact { url: string; sha256: string; sizeBytes: number; platform: string; version: string }
export interface MarketPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  publisherId: string;
  official: boolean;
  version: string;
  category?: string;
  minHostVersion?: string;
  platforms: string[];
  ratingAverage: number;
  ratingCount: number;
  downloadCount: number;
  updatedAt: string;
  manifest?: PluginManifest;
  artifact?: MarketArtifact;
  sourceId?: string;
}
export interface MarketSourceConfig { baseUrl: string; enabled: boolean }
export interface MarketSource extends MarketSourceConfig { sourceId: string; trustedOfficial: boolean }
export interface CatalogPage { filterVersion?: number; items: MarketPlugin[]; nextCursor?: string; stale?: boolean; error?: string; cachedAt?: string; sourceId?: string }
export interface MarketRating { userId: string; pluginId: string; stars: number; body: string; version: string; updatedAt: string }
export interface MarketSettings { baseUrl: string; sourceId?: string; trustedOfficial?: boolean }
export type MarketSort = 'updated' | 'rating' | 'downloads';
export interface MarketInspectionRequest { id: string; version: string; artifactDigest: string; sourceId: string; sizeBytes?: number }
export interface MarketInspectionQuote {
  inspection: PluginInspection;
  sourceId: string;
  artifactDigest: string;
  approvalToken: string;
  expiresAt: string;
}
