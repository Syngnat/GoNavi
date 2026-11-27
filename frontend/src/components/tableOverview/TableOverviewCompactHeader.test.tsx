// @vitest-environment jsdom
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../i18n';
import { resolveTableOverviewCompactColumnDefinitions } from './tableOverviewCompactColumns';
import TableOverviewCompactHeader from './TableOverviewCompactHeader';

const columns = resolveTableOverviewCompactColumnDefinitions(['name', 'comment', 'rows']);

let renderer: ReactTestRenderer | null = null;

const renderHeader = (sortOrder: 'asc' | 'desc' = 'asc') => {
  const toggleSort = vi.fn();
  act(() => {
    renderer = create(
      <TableOverviewCompactHeader
        columns={columns}
        columnWidths={{}}
        sortField="name"
        sortOrder={sortOrder}
        toggleSort={toggleSort}
        onResizeStart={vi.fn()}
        onResizeKeyDown={vi.fn()}
        onAutoFit={vi.fn()}
      />,
    );
  });
  return { toggleSort };
};

beforeEach(() => {
  vi.stubGlobal('ShadowRoot', class ShadowRoot {});
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe('TableOverviewCompactHeader', () => {
  it('uses one sortable button per sortable column and only marks the active header with aria-sort', () => {
    const { toggleSort } = renderHeader();
    const headers = renderer!.root.findAll((node) => (
      node.type === 'div' && node.props.role === 'columnheader'
    ));

    expect(headers).toHaveLength(3);
    expect(headers[0].props['aria-sort']).toBe('ascending');
    expect(headers[1].props['aria-sort']).toBeUndefined();
    expect(headers[2].props['aria-sort']).toBeUndefined();

    const nameButton = renderer!.root.findByProps({ 'data-table-overview-sort': 'name' });
    expect(nameButton.type).toBe('button');
    expect(nameButton.props.type).toBe('button');
    expect(nameButton.props['aria-pressed']).toBeUndefined();
    act(() => nameButton.props.onClick());
    expect(toggleSort).toHaveBeenCalledWith('name');
  });

  it('keeps resize handles named and exposes the current width floor', () => {
    renderHeader('desc');
    const nameHeader = renderer!.root.findByProps({ 'data-table-overview-column-header': 'name' });
    expect(nameHeader.props['aria-sort']).toBe('descending');

    const resizer = renderer!.root.findByProps({ 'data-table-overview-column-resizer': 'comment' });
    expect(resizer.type).toBe('span');
    expect(resizer.props.role).toBe('separator');
    expect(resizer.props.tabIndex).toBe(0);
    expect(resizer.props['aria-valuemin']).toBe(170);
    expect(resizer.props['aria-label']).toBe(
      `${t('table_overview.metric.comment')} · ${t('data_grid.column.resize_tooltip')}`,
    );
  });
});
