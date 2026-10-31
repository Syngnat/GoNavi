import { t } from '../i18n';
const keys: Record<string, string> = {
  not_configured: 'plugin.market.no_source',
  cache_unavailable: 'plugin.market.error.cache_unavailable',
  request_failed: 'plugin.backend.error.market_unavailable',
  invalid_response: 'plugin.market.error.invalid_response',
  filters_unsupported: 'plugin.market.filters_unsupported',
  response_too_large: 'plugin.market.error.response_too_large',
  redirect_rejected: 'plugin.market.error.redirect_rejected',
  canceled: 'plugin.market.error.canceled',
  timeout: 'plugin.market.error.timeout',
  source_changed: 'plugin.market.error.source_changed',
  rate_limited: 'plugin.market.error.busy',
  server_busy: 'plugin.market.error.busy',
  http_error: 'plugin.backend.error.market_unavailable',
  auth_unavailable: 'plugin.backend.error.auth_unavailable',
  forbidden: 'plugin.backend.error.forbidden',
  not_found: 'plugin.backend.error.not_found',
  authentication_required: 'plugin.backend.error.authentication_required',
};
export function marketErrorText(code: string): string {
  return t(Object.prototype.hasOwnProperty.call(keys, code) ? keys[code] : 'plugin.backend.error.market_unavailable');
}
