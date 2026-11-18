// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SortableTabLabel } from './SortableTabLabel';
import type { TabData } from '../../types';
import type { TabDisplayModel } from '../../utils/tabDisplay';

const TAB: TabData = {
  id: 'tab-users',
  title: 'users',
  type: 'table',
  connectionId: 'conn-1',
  tableName: 'users',
};

const buildModel = (layout: 'single' | 'double', secondaryText = ''): TabDisplayModel => ({
  layout,
  primaryParts: [{ key: 'object', value: 'users', text: 'users' }],
  secondaryParts: secondaryText
    ? [{ key: 'connection', value: 'local', text: '[local]' }]
    : [],
  primaryText: 'users',
  secondaryText,
  fullTitle: secondaryText ? `users · ${secondaryText}` : 'users',
});

const renderLabel = (layout: 'single' | 'double', secondaryText = '') => {
  const displayModel = buildModel(layout, secondaryText);
  const markup = renderToStaticMarkup(
    <SortableTabLabel
      tab={TAB}
      displayModel={displayModel}
      displayTitle={displayModel.fullTitle}
      menuItems={[]}
      onClose={() => undefined}
    />,
  );
  const label = new DOMParser()
    .parseFromString(markup, 'text/html')
    .querySelector<HTMLElement>('.tab-dnd-label');
  if (!label) throw new Error(`tab label was not rendered: ${markup}`);
  return label;
};

describe('SortableTabLabel double-line slot', () => {
  it('keeps the double class and an empty secondary row when the row has no content', () => {
    const label = renderLabel('double');

    expect(label.classList.contains('gn-v2-tab-label-double')).toBe(true);
    const secondary = label.querySelector('.gn-v2-tab-label-secondary');
    expect(secondary).not.toBeNull();
    expect(secondary?.textContent).toBe('');
    expect(secondary?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders secondary parts into the reserved row', () => {
    const label = renderLabel('double', '[local]');

    expect(label.classList.contains('gn-v2-tab-label-double')).toBe(true);
    const secondary = label.querySelector('.gn-v2-tab-label-secondary');
    expect(secondary?.textContent).toBe('[local]');
    expect(secondary?.getAttribute('title')).toBe('[local]');
  });

  it('does not render a secondary row in single-line layout', () => {
    const label = renderLabel('single');

    expect(label.classList.contains('gn-v2-tab-label-double')).toBe(false);
    expect(label.querySelector('.gn-v2-tab-label-secondary')).toBeNull();
  });
});
