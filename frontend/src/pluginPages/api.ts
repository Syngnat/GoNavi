import { PluginPageCall } from '../../wailsjs/go/app/App';
import { PluginAPIError } from '../plugins/apiResult';
import { isRecord } from '../plugins/jsonBoundary';
import type { JSONValue } from '../plugins/types';

const MAX_RESULT_BYTES = 256 * 1024;

// Every backend page code owns one catalog key; an unknown code falls back to the generic
// message instead of inventing user-facing text.
// data.code currently arrives with the page_ prefix; the contract also names the bare
// codes, so both spellings resolve to the same message and a future shape change cannot
// silently downgrade every failure to the generic text.
const PAGE_ERROR_KEYS: Record<string, string> = {
  invalid_identity: 'plugin.backend.error.page_invalid_identity',
  not_running: 'plugin.backend.error.page_not_running',
  not_declared: 'plugin.backend.error.page_not_declared',
  permission_denied: 'plugin.backend.error.page_permission_denied',
  unknown_method: 'plugin.backend.error.page_unknown_method',
  invalid_arguments: 'plugin.backend.error.page_invalid_arguments',
  result_too_large: 'plugin.backend.error.page_result_too_large',
  unsupported: 'plugin.backend.error.page_unsupported',
  internal: 'plugin.backend.error.page_internal',
  page_invalid_identity: 'plugin.backend.error.page_invalid_identity',
  page_not_running: 'plugin.backend.error.page_not_running',
  page_not_declared: 'plugin.backend.error.page_not_declared',
  page_permission_denied: 'plugin.backend.error.page_permission_denied',
  page_unknown_method: 'plugin.backend.error.page_unknown_method',
  page_invalid_arguments: 'plugin.backend.error.page_invalid_arguments',
  page_result_too_large: 'plugin.backend.error.page_result_too_large',
  page_unsupported: 'plugin.backend.error.page_unsupported',
  page_internal: 'plugin.backend.error.page_internal',
  management_denied: 'plugin.backend.error.management_denied',
};

const decodePageData = (data: unknown): JSONValue => {
  let encoded: string;
  try {
    encoded = JSON.stringify(data ?? null);
  } catch {
    throw new PluginAPIError('plugin.backend.error.page_internal');
  }
  if (new TextEncoder().encode(encoded).length > MAX_RESULT_BYTES) {
    throw new PluginAPIError('plugin.backend.error.page_result_too_large');
  }
  return JSON.parse(encoded) as JSONValue;
};

/**
 * The only transport a plugin page may use. Plugin identity and page identity travel with
 * every call so the host can re-check that the page is declared and the plugin is running.
 */
export async function pageCall(
  pluginID: string,
  pageID: string,
  method: string,
  argumentsJSON: string,
): Promise<JSONValue> {
  let result: unknown;
  try {
    result = await PluginPageCall(pluginID, pageID, method, argumentsJSON);
  } catch {
    throw new PluginAPIError('plugin.backend.error.page_internal');
  }
  if (!isRecord(result) || typeof result.success !== 'boolean') {
    throw new PluginAPIError('plugin.backend.error.page_internal');
  }
  if (!result.success) {
    const code = isRecord(result.data) && typeof result.data.code === 'string' ? result.data.code : '';
    const detail = typeof result.message === 'string' ? result.message.slice(0, 2048) : '';
    throw new PluginAPIError(PAGE_ERROR_KEYS[code] ?? 'plugin.backend.error.operation_failed', detail);
  }
  return decodePageData(result.data);
}
