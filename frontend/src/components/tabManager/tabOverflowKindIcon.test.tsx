// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabOverflowKindIcon } from './tabOverflowKindIcon';

describe('TabOverflowKindIcon', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it('maps kind labels to the workbench icon family', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <>
          <TabOverflowKindIcon kind="SQL" />
          <TabOverflowKindIcon kind="PLUGIN" />
          <TabOverflowKindIcon kind="TABLE" />
        </>,
      );
    });
    expect(container.querySelector('.gn-icon-sql-doc')).not.toBeNull();
    expect(container.querySelector('.gn-icon-package')).not.toBeNull();
    expect(container.querySelector('.gn-icon-table')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
