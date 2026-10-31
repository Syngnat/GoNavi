import { useLayoutEffect, useState } from 'react';
import { readHostAppearance, type PluginHostAppearance } from './hostAppearance';
import { CUSTOM_THEME_STYLE_ID } from '../utils/customTheme';
import { sanitizeHostPalette, type PluginHostPalette } from './hostPreferences';

const HOST_PALETTE_VARS = {
  bg: '--gn-bg-panel-2', panel: '--gn-bg-panel', input: '--gn-bg-input', code: '--gn-bg-app',
  text: '--gn-fg-1', muted: '--gn-fg-4', border: '--gn-br-2', border1: '--gn-br-1',
  accent: '--gn-accent', accentSoft: '--gn-accent-soft', ok: '--gn-status-connected',
  warn: '--gn-warn', warnBg: '--gn-warn-soft', chip: '--gn-bg-active', hover: '--gn-bg-hover',
} as const;

export function readHostThemePalette(): PluginHostPalette | undefined {
  if (typeof document === 'undefined' || !document.body || !document.defaultView) return undefined;
  const view = document.defaultView;
  const computed = view.getComputedStyle(document.body);
  const palette: PluginHostPalette = {};
  const holder = document.createElement('span');
  holder.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;';
  holder.setAttribute('aria-hidden', 'true');
  const probe = document.createElement('span');
  holder.append(probe);
  document.body.append(holder);
  try {
    for (const key of Object.keys(HOST_PALETTE_VARS) as (keyof typeof HOST_PALETTE_VARS)[]) {
      const raw = computed.getPropertyValue(HOST_PALETTE_VARS[key]).trim();
      if (!raw || raw.length > 1024 || /[\\;<>]|(?:url|expression)\s*\(/i.test(raw)) continue;
      holder.style.color = 'rgb(1, 2, 3)';
      probe.style.color = '';
      probe.style.color = raw;
      if (!probe.style.color) continue;
      let color = view.getComputedStyle(probe).color;
      if (color === 'rgb(1, 2, 3)') {
        holder.style.color = 'rgb(4, 5, 6)';
        color = view.getComputedStyle(probe).color;
        if (color === 'rgb(4, 5, 6)') continue;
      }
      const safe = sanitizeHostPalette({ [key]: color });
      if (safe?.[key]) palette[key] = safe[key];
    }
  } finally { holder.remove(); }
  return Object.keys(palette).length ? palette : undefined;
}

export function useHostThemePalette(enabled = true): { palette?: PluginHostPalette; appearance?: PluginHostAppearance; ready: boolean } {
  const [palette, setPalette] = useState<PluginHostPalette>();
  const [appearance, setAppearance] = useState<PluginHostAppearance>();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (disposed) return;
      const next = readHostThemePalette();
      setPalette(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      const metrics = readHostAppearance();
      setAppearance(previous => JSON.stringify(previous) === JSON.stringify(metrics) ? previous : metrics);
    };
    const schedule = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(update);
    };
    const bodyObserver = new MutationObserver(schedule);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-ui-version', 'data-custom-theme', 'data-custom-theme-id', 'style', 'class'] });
    const htmlObserver = new MutationObserver(schedule);
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    const appRoot = document.querySelector('.gn-v2-app-root');
    const backgroundObserver = new MutationObserver(schedule);
    if (appRoot) backgroundObserver.observe(appRoot, { attributes: true, attributeFilter: ['data-background-image', 'style', 'class'] });
    const isThemeStyle = (node: Node | null) => node instanceof Element && node.id === CUSTOM_THEME_STYLE_ID;
    const headObserver = new MutationObserver(records => {
      if (records.some(record => isThemeStyle(record.target) || isThemeStyle(record.target.parentNode)
        || [...record.addedNodes, ...record.removedNodes].some(isThemeStyle))) schedule();
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    // Read after every layout effect has installed its style, before the first plugin document.
    queueMicrotask(() => {
      if (!disposed) {
        if (frame) window.cancelAnimationFrame(frame);
        update(); setReady(true);
      }
    });
    return () => {
      disposed = true;
      bodyObserver.disconnect(); headObserver.disconnect();
      htmlObserver.disconnect(); backgroundObserver.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return { palette, appearance, ready };
}
