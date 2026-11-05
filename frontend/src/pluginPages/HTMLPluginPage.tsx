import { useMemo, useRef, useState } from 'react';
import { Alert } from 'antd';
import { useI18n } from '../i18n/provider';
import { sandboxedPageDocument } from './pageDocument';
import { showPluginPageNotification } from './pageNotify';
import { createPageToken } from './pageToken';
import { usePageBridge } from './usePageBridge';
import { useStore } from '../store';
import {
  APPEARANCE_MAX_ARGUMENT_BYTES, APPEARANCE_WRITE_PERMISSION, createAppearanceResolver,
} from '../pluginSettings/appearanceBridge';
import { pluginHostPreferences, type PluginHostPreferences } from './hostPreferences';
import { useHostThemePalette } from './useHostThemePalette';

const FRAME_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; midi 'none'; clipboard-read 'none'; clipboard-write 'none'";

export function HTMLPluginPage({
  pluginID,
  pageID,
  title,
  source,
  launch,
  autoHeight = false,
  permissions = [],
}: {
  pluginID: string;
  pageID: string;
  title: string;
  source: string;
  launch?: unknown;
  /** Embedded surfaces let the page report its own height; tabs keep filling the view. */
  autoHeight?: boolean;
  /** Manifest permissions gate the host-window appearance capabilities. */
  permissions?: string[];
}) {
  const { t, language } = useI18n();
  const theme = useStore(state => state.theme);
  const [blocked, setBlocked] = useState(false);
  const [frameHeight, setFrameHeight] = useState(0);
  const { palette, appearance, ready } = useHostThemePalette(!blocked);
  const preferences = pluginHostPreferences(language, theme, palette, appearance);
  const initialPreferences = useRef<PluginHostPreferences>();
  if (ready && !initialPreferences.current) initialPreferences.current = preferences;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [token] = useState(createPageToken);
  const loads = useRef(0);
  const document = useMemo(() => sandboxedPageDocument(source, token, launch, initialPreferences.current), [launch, source, token, ready]);
  usePageBridge({
    frameRef,
    pluginID,
    pageID,
    token,
    enabled: !blocked,
    preferences,
    onNotify: showPluginPageNotification,
    onResize: autoHeight ? setFrameHeight : undefined,
    resolveLocalCall: createAppearanceResolver(permissions),
    maxArgumentBytes: permissions.includes(APPEARANCE_WRITE_PERMISSION)
      ? APPEARANCE_MAX_ARGUMENT_BYTES
      : undefined,
  });
  // The bridge now starts over a per-document MessagePort, so a second load can only mean
  // the page navigated itself away; tear the frame down instead of trusting the new document.
  const handleLoad = () => {
    loads.current += 1;
    if (loads.current > 1) setBlocked(true);
  };
  if (blocked) {
    return <div className="plugin-page-status">
      <Alert type="error" showIcon message={t('plugin.pages.unavailable')} description={t('plugin.pages.error.navigation')} />
    </div>;
  }
  if (!ready) return null;
  return (
    <iframe
      ref={frameRef}
      className="plugin-page-frame"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      allow={FRAME_ALLOW}
      srcDoc={document}
      onLoad={handleLoad}
      style={autoHeight
        ? { height: frameHeight || 240, minHeight: 0, flex: '0 0 auto' }
        : undefined}
    />
  );
}
