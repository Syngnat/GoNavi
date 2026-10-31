import { PluginAPIError, requireRecord } from '../plugins/apiResult';
import { decodeInspection } from '../plugins/decode';
import type { MarketInspectionQuote, MarketInspectionRequest } from './types';

const invalid = (): never => { throw new PluginAPIError('plugin.error.invalid_response'); };
export function decodeInspectionQuote(data: unknown): MarketInspectionQuote {
  const quote = requireRecord(data);
  if (typeof quote.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(quote.sourceId)
    || typeof quote.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(quote.artifactDigest)
    || typeof quote.approvalToken !== 'string' || !quote.approvalToken.trim() || quote.approvalToken.length > 1024
    || typeof quote.expiresAt !== 'string' || quote.expiresAt.length > 64
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(quote.expiresAt)
    || !Number.isFinite(Date.parse(quote.expiresAt))) return invalid();
  return { ...quote, inspection: decodeInspection(quote.inspection) } as MarketInspectionQuote;
}
export function assertInspectionRequest(request: MarketInspectionRequest): void {
  if (!request.id || !request.version || !/^[a-f0-9]{64}$/.test(request.sourceId)
    || !/^[a-f0-9]{64}$/i.test(request.artifactDigest)
    || (request.sizeBytes !== undefined && (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes <= 0))) throw new PluginAPIError('plugin.market.inspection_mismatch');
}
export function assertInspectionQuote(quote: MarketInspectionQuote, request: MarketInspectionRequest, now = Date.now()): void {
  assertInspectionRequest(request);
  if (quote.sourceId !== request.sourceId || quote.artifactDigest.toLowerCase() !== request.artifactDigest.toLowerCase()
    || quote.inspection.manifest.id !== request.id || quote.inspection.manifest.version !== request.version) {
    throw new PluginAPIError('plugin.market.inspection_mismatch');
  }
  const deadline = Date.parse(quote.expiresAt);
  if (!Number.isFinite(deadline) || deadline <= now) throw new PluginAPIError('plugin.market.inspection_expired');
}
