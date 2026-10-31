import { isRecord } from './jsonBoundary';
import { t } from '../i18n';

// Backend codes the UI can explain safely. Anything else falls back to a generic message,
// so a new Go code has to be listed here and in the shared catalogs.
export const PLUGIN_ERROR_CODES = ['operation_failed', 'management_denied', 'runtime_unavailable', 'invalid_request', 'market_unavailable', 'authentication_required', 'window_unavailable', 'root_busy', 'datasource_write_effect', 'command_reserved', 'plugin_disabled', 'digest_mismatch', 'not_found', 'path_not_found', 'plugin_busy', 'plugin_enabled', 'spec_invalid', 'release_not_found', 'asset_ambiguous', 'npm_not_found', 'fetch_failed', 'fetch_expired', 'fetch_stale', 'artifact_invalid', 'forbidden', 'conflict', 'auth_unavailable', 'rate_limited', 'server_busy', 'timeout', 'source_changed', 'source_mismatch', 'invalid_response', 'response_too_large', 'redirect_rejected'] as const;

export class PluginAPIError extends Error {
  constructor(public readonly key: string, public readonly detail = '') { super(key); }
}
export async function pluginResult<T>(call: Promise<unknown>, decode: (data: unknown) => T): Promise<T> {
  const result = await call;
  if (!isRecord(result) || typeof result.success !== 'boolean') throw new PluginAPIError('plugin.error.invalid_response');
  if (!result.success) {
    const code = isRecord(result.data) ? result.data.code : undefined;
    if (typeof code === 'string' && (PLUGIN_ERROR_CODES as readonly string[]).includes(code)) throw new PluginAPIError('plugin.backend.error.' + code);
    throw new PluginAPIError('plugin.backend.error.operation_failed', typeof result.message === 'string' ? result.message.slice(0, 2048) : '');
  }
  return decode(result.data);
}
export function pluginErrorText(error: unknown): string {
  if (error instanceof PluginAPIError) return error.detail || t(error.key);
  if (error instanceof Error && error.message.startsWith('plugin.')) return t(error.message);
  return t('plugin.backend.error.operation_failed');
}
export function requireRecord(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw new PluginAPIError('plugin.error.invalid_response');
  return data;
}
export function ignoreResult(): void {}
