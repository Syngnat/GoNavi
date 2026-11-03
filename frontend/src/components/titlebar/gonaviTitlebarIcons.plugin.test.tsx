// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GONAVI_TITLEBAR_ICON_COLORS, TitlebarPluginIcon } from './gonaviTitlebarIcons';

describe('TitlebarPluginIcon', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('uses the left-toolbar tile kit: four rounded blocks in primary and highlight', async () => {
    await act(async () => {
      root.render(<TitlebarPluginIcon />);
    });
    const rects = [...container.querySelectorAll('rect')];
    expect(rects).toHaveLength(4);
    expect(rects.every((node) => node.getAttribute('rx') === '2.4')).toBe(true);
    expect(rects.slice(0, 3).every((node) => node.style.fill === GONAVI_TITLEBAR_ICON_COLORS.primary)).toBe(true);
    expect(rects[3]?.style.fill).toBe(GONAVI_TITLEBAR_ICON_COLORS.highlight);
    expect(container.querySelector('circle')).toBeNull();
    expect(container.innerHTML).not.toContain('--gn-titlebar-icon-accent');
  });
});
