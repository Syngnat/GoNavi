import { sandboxedPanelDocument } from '../plugins/SandboxedHTMLPanel';
import { createPageBridgeRuntime } from './bridgeRuntime';
import { serializePluginPageLaunch } from './launch';
import type { PluginHostPreferences } from './hostPreferences';

/**
 * The page document keeps the panel CSP unchanged (no network, forms, frames or base
 * changes) and prepends the bridge runtime carrying this frame's token, so page scripts
 * already see window.gonavi and every call is bound to this one iframe.
 */
export function sandboxedPageDocument(source: string, token: string, launch?: unknown, preferences?: PluginHostPreferences): string {
  const launchScript = launch === undefined
    ? ''
    : '<script>window.__gonaviLaunch=' + serializePluginPageLaunch(launch) + ';</script>';
  return sandboxedPanelDocument('<script>' + createPageBridgeRuntime(token, preferences) + '</script>' + launchScript + source);
}
