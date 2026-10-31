import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useI18n } from '../i18n/provider';
import { pluginErrorText } from '../plugins/apiResult';
import { pageCall } from './api';
import { createPageBridge } from './pageBridgeCore';
import { serializeHostPreferences, type PluginHostPreferences } from './hostPreferences';

export interface UsePageBridgeOptions {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pluginID: string;
  pageID: string;
  token: string;
  enabled: boolean;
  preferences?: PluginHostPreferences;
  loaded?: boolean;
  onNotify?: (message: string, type?: string) => void;
}

/**
 * Wires the bridge to one iframe. Only messages whose source is that frame and that carry
 * its minted token are accepted; every other window, iframe or host script is ignored.
 * Unmounting disposes the pump so no late response can reach a torn-down page.
 */
export function usePageBridge({
  frameRef,
  pluginID,
  pageID,
  token,
  enabled,
  preferences,
  loaded,
  onNotify,
}: UsePageBridgeOptions): void {
  const { t } = useI18n();
  const translate = useRef(t);
  translate.current = t;
  const notify = useRef(onNotify);
  notify.current = onNotify;
  const preferencesJSON = preferences ? serializeHostPreferences(preferences) : undefined;
  useEffect(() => {
    if (enabled && loaded && preferencesJSON) frameRef.current?.contentWindow?.postMessage({
      type: 'gonavi:host-preferences', token, preferences: JSON.parse(preferencesJSON),
    }, '*');
  }, [enabled, loaded, preferencesJSON, frameRef, token]);
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const bridge = createPageBridge({
      token,
      post: (payload) => {
        if (!disposed) frameRef.current?.contentWindow?.postMessage(payload, '*');
      },
      call: (method, argumentsJSON) => pageCall(pluginID, pageID, method, argumentsJSON),
      translate: (key) => translate.current(key),
      describeError: pluginErrorText,
      onNotify: (message, type) => notify.current?.(message, type),
    });
    const onMessage = (event: MessageEvent) => {
      if (disposed) return;
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      bridge.handle(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      bridge.dispose();
    };
  }, [enabled, frameRef, pageID, pluginID, token]);
}
