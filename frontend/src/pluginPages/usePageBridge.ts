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
  onNotify?: (message: string, type?: string) => void;
}

/**
 * Wires the bridge to one iframe. The frame announces itself with a per-document MessagePort;
 * calls and results then travel over that port only, so a document that navigated away cannot
 * receive them. Window messages are still accepted for calls that carry this frame's token
 * (the token never leaves the srcdoc runtime) and for the first preference paint.
 * Unmounting disposes the pump so no late response can reach a torn-down page.
 */
export function usePageBridge({
  frameRef,
  pluginID,
  pageID,
  token,
  enabled,
  preferences,
  onNotify,
}: UsePageBridgeOptions): void {
  const { t } = useI18n();
  const translate = useRef(t);
  translate.current = t;
  const notify = useRef(onNotify);
  notify.current = onNotify;
  const preferencesJSON = preferences ? serializeHostPreferences(preferences) : undefined;
  const preferencesRef = useRef(preferencesJSON);
  preferencesRef.current = preferencesJSON;
  const portRef = useRef<MessagePort | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const bridge = createPageBridge({
      token,
      post: (payload) => {
        if (disposed) return;
        const port = portRef.current;
        if (port) {
          try { port.postMessage(payload); } catch { /* the document that owned the port is gone */ }
          return;
        }
        frameRef.current?.contentWindow?.postMessage(payload, '*');
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
      const data = event.data as Record<string, unknown> | null;
      if (data?.type === 'gonavi:page-ready' && data.token === token) {
        const port = event.ports && event.ports[0];
        if (!port) return;
        portRef.current?.close();
        portRef.current = port;
        port.onmessage = (message) => { if (!disposed) bridge.handle(message.data); };
        const json = preferencesRef.current;
        if (json) port.postMessage({ type: 'gonavi:host-preferences', preferences: JSON.parse(json) });
        return;
      }
      bridge.handle(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      portRef.current?.close();
      portRef.current = null;
      bridge.dispose();
    };
  }, [enabled, frameRef, pageID, pluginID, token]);
  useEffect(() => {
    if (!enabled || !preferencesJSON) return;
    const payload = { type: 'gonavi:host-preferences', preferences: JSON.parse(preferencesJSON) };
    const port = portRef.current;
    if (port) {
      try { port.postMessage(payload); } catch { /* the document that owned the port is gone */ }
      return;
    }
    frameRef.current?.contentWindow?.postMessage({ ...payload, token }, '*');
  }, [enabled, preferencesJSON, frameRef, token]);
}
