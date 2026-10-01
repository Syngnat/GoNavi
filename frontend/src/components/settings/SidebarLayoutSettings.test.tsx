/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { useStore } from '../../store';
import { SidebarActionsPlacementSettings, SidebarSearchModeSettings } from './SidebarLayoutSettings';

describe('SidebarLayoutSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.getState().setAppearance({ sidebarActionsPlacement: 'toolbar', v2SidebarSearchMode: 'command' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.getState().setAppearance({ sidebarActionsPlacement: 'toolbar', v2SidebarSearchMode: 'command' });
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={vi.fn()}>
          {node}
        </I18nProvider>,
      );
    });
  };

  it('defaults to the top toolbar and switches to the sidebar rail from the pills', async () => {
    await render(<SidebarActionsPlacementSettings />);
    const pill = (value: string) => container.querySelector(`[data-sidebar-actions-placement="${value}"]`) as HTMLButtonElement;

    expect(pill('toolbar').textContent).toBe('Top toolbar');
    expect(pill('rail').textContent).toBe('Left sidebar rail');
    expect(pill('toolbar').getAttribute('aria-pressed')).toBe('true');
    expect(pill('rail').getAttribute('aria-pressed')).toBe('false');

    await act(async () => { pill('rail').click(); });
    expect(useStore.getState().appearance.sidebarActionsPlacement).toBe('rail');
    expect(pill('rail').getAttribute('aria-pressed')).toBe('true');
    expect(pill('toolbar').getAttribute('aria-pressed')).toBe('false');

    await act(async () => { pill('toolbar').click(); });
    expect(useStore.getState().appearance.sidebarActionsPlacement).toBe('toolbar');
  });

  it('keeps the sidebar search mode pills working after being extracted from App', async () => {
    await render(<SidebarSearchModeSettings />);
    const pills = () => Array.from(container.querySelectorAll('.gonavi-settings-pill')) as HTMLButtonElement[];

    expect(pills()).toHaveLength(2);
    expect(pills()[0].getAttribute('aria-pressed')).toBe('true');

    await act(async () => { pills()[1].click(); });
    expect(useStore.getState().appearance.v2SidebarSearchMode).toBe('filter');
    expect(pills()[1].getAttribute('aria-pressed')).toBe('true');
  });
});
