import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncObjectPicker } from './DataSyncObjectPicker';
import { createDataSyncWorkbenchTranslate } from './text';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('DataSyncObjectPicker', () => {
  it('searches, selects all filtered objects, preserves cross-search choices, and excludes mapped rows', async () => {
    const confirm = vi.fn(async () => undefined);
    const renderer = TestRenderer.create(
      <DataSyncObjectPicker
        open
        objects={[
          { name: 'admin_users', kind: 'table', rowCount: 10 },
          { name: 'messages', kind: 'table', rowCount: 2_000, dataBytes: 4096 },
          { name: 'push_records', kind: 'view' },
          { name: 'orders', kind: 'table' },
        ]}
        mappedSourceNames={['messages']}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onClose={() => undefined}
        onConfirm={confirm}
      />,
    );
    await flush();

    const mapped = renderer.root.findByProps({ 'data-object-name': 'messages' });
    expect(mapped.findByType('input').props.disabled).toBe(true);
    expect(mapped.findAllByType('small')).toHaveLength(2);
    expect(
      renderer.root
        .findByProps({ 'data-object-name': 'orders' })
        .findAllByType('small'),
    ).toHaveLength(1);

    const search = renderer.root.findByProps({
      'data-object-picker-control': 'search',
    });
    act(() => search.props.onChange({ target: { value: 'admin' } }));
    const selectFiltered = renderer.root.findByProps({
      'data-object-picker-control': 'select-filtered',
    });
    act(() => selectFiltered.props.onChange({ target: { checked: true } }));

    act(() => search.props.onChange({ target: { value: 'orders' } }));
    act(() =>
      renderer.root
        .findByProps({ 'data-object-name': 'orders' })
        .findByType('input').props.onChange({ target: { checked: true } }),
    );

    const addButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('添加 2 个对象'))!;
    act(() => addButton.props.onClick());
    await flush();

    expect(confirm).toHaveBeenCalledWith(['admin_users', 'orders']);
  });

  it('excludes views by default and exposes them only after explicit opt-in', async () => {
    const renderer = TestRenderer.create(
      <DataSyncObjectPicker
        open
        objects={[
          { name: 'orders', kind: 'table' },
          { name: 'orders_view', kind: 'view' },
        ]}
        mappedSourceNames={[]}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    await flush();

    expect(renderer.root.findAllByProps({ 'data-object-name': 'orders_view' })).toHaveLength(0);
    const includeViews = renderer.root.findByProps({
      'data-object-picker-control': 'include-views',
    });
    act(() => includeViews.props.onChange({ target: { checked: true } }));
    expect(renderer.root.findByProps({ 'data-object-name': 'orders_view' })).toBeTruthy();
  });
});
