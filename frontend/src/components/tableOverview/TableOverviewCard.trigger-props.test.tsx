// @vitest-environment jsdom
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TableOverviewCard } from './TableOverviewCard';
import type { TableStatRow } from './tableOverviewModel';

const table: TableStatRow = {
  name: 'orders',
  comment: '订单表',
  rows: 10,
  dataSize: 1024,
  indexSize: 512,
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  createTime: '',
  updateTime: '',
};

describe('TableOverviewCard trigger props', () => {
  beforeEach(() => {
    vi.stubGlobal('ShadowRoot', class ShadowRoot {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards hover handlers injected by Tooltip to the card DOM node', () => {
    const onMouseEnter = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <TableOverviewCard
          table={table}
          displayName="orders"
          isSelected={false}
          accentColor="#16a34a"
          textPrimary="#111"
          textSecondary="#666"
          textMuted="#888"
          maxCombinedSize={2048}
          hasKnownTableSize={() => true}
          getCombinedTableSize={() => 1536}
          openTableByDefaultAction={vi.fn()}
          openV2OverviewContextMenu={vi.fn()}
          renderNameNode={(_table, displayName) => <span>{displayName}</span>}
          renderMetaBadges={() => null}
          onMouseEnter={onMouseEnter}
        />,
      );
    });

    const card = renderer.root.findByProps({ 'data-table-overview-card': 'orders' });
    act(() => card.props.onMouseEnter({}));
    expect(onMouseEnter).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });
});
