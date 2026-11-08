// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useScrollLock } from './useScrollLock';

function Probe({ locked }: { locked: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  useScrollLock(anchor, locked);
  return <div ref={anchor} />;
}

interface Mounted { host: HTMLElement; wrapper?: HTMLElement; root: Root }
const mounted: Root[] = [];

beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });

function mount(hostOverflow: string, wrapperOverflow?: string): Mounted {
  const host = document.createElement('div');
  host.style.overflowY = hostOverflow;
  document.body.append(host);
  const wrapper = wrapperOverflow === undefined ? undefined : document.createElement('div');
  if (wrapper) {
    wrapper.style.overflowY = wrapperOverflow ?? 'auto';
    host.append(wrapper);
  }
  const root = createRoot(wrapper ?? host);
  mounted.push(root);
  return { host, wrapper, root };
}

async function render(root: Root, locked: boolean) {
  await act(async () => { root.render(<Probe locked={locked} />); });
}

afterEach(() => {
  mounted.splice(0).forEach((root) => { act(() => { root.unmount(); }); });
  document.body.innerHTML = '';
});

describe('scroll lock', () => {
  it('locks every scrollable ancestor and restores it on unlock', async () => {
    const { host, wrapper, root } = mount('auto', 'scroll');
    await render(root, true);
    expect(wrapper!.style.overflowY).toBe('hidden');
    expect(host.style.overflowY).toBe('hidden');
    await render(root, false);
    expect(wrapper!.style.overflowY).toBe('scroll');
    expect(host.style.overflowY).toBe('auto');
  });

  it('leaves non-scrollable ancestors alone', async () => {
    const { host, root } = mount('visible');
    await render(root, true);
    expect(host.style.overflowY).toBe('visible');
  });
});
