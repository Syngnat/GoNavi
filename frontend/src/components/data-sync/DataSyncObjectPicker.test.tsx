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
  it('uses modal semantics and closes from Escape or the backdrop', async () => {
    const close = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncObjectPicker
        open
        objects={[]}
        mappedSourceNames={[]}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onClose={close}
        onConfirm={() => undefined}
      />,
    );
    await flush();

    const dialog = renderer.root.findByProps({ 'data-data-sync-object-picker': 'true' });
    expect(dialog.props).toEqual(
      expect.objectContaining({ role: 'dialog', 'aria-modal': 'true' }),
    );

    const preventDefault = vi.fn();
    act(() => dialog.props.onKeyDown({ key: 'Escape', preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    const overlay = renderer.root.findByProps({ 'data-data-sync-overlay': 'object-picker' });
    const backdrop = {};
    act(() => overlay.props.onMouseDown({ target: backdrop, currentTarget: backdrop }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('cannot be dismissed while selected objects are being inspected', async () => {
    let resolveConfirm!: () => void;
    const confirm = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    const close = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncObjectPicker
        open
        objects={[{ name: 'orders', kind: 'table' }]}
        mappedSourceNames={[]}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onClose={close}
        onConfirm={confirm}
      />,
    );
    await flush();

    act(() => {
      renderer.root
        .findByProps({ 'data-object-name': 'orders' })
        .findByType('input').props.onChange({ target: { checked: true } });
    });
    const addButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('添加 1 个对象'))!;
    act(() => addButton.props.onClick());

    const dialog = renderer.root.findByProps({ 'data-data-sync-object-picker': 'true' });
    const preventDefault = vi.fn();
    act(() => dialog.props.onKeyDown({ key: 'Escape', preventDefault }));
    const overlay = renderer.root.findByProps({ 'data-data-sync-overlay': 'object-picker' });
    const backdrop = {};
    act(() => overlay.props.onMouseDown({ target: backdrop, currentTarget: backdrop }));

    expect(
      renderer.root.findByProps({ 'aria-label': '关闭' }).props.disabled,
    ).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledWith(['orders']);
    expect(close).toHaveBeenCalledOnce();
  });

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

  it('renders large result sets in bounded batches and resets the batch on search', async () => {
    const objects = Array.from({ length: 321 }, (_, index) => ({
      name: `object_${String(index + 1).padStart(3, '0')}`,
      kind: 'table' as const,
    }));
    const renderer = TestRenderer.create(
      <DataSyncObjectPicker
        open
        objects={objects}
        mappedSourceNames={[]}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    await flush();

    expect(
      renderer.root.findAll(
        (node) => typeof node.props['data-object-name'] === 'string',
      ),
    ).toHaveLength(160);
    const showMore = () =>
      renderer.root.findByProps({ 'data-object-picker-control': 'show-more' });
    act(() => showMore().props.onClick());
    expect(
      renderer.root.findAll(
        (node) => typeof node.props['data-object-name'] === 'string',
      ),
    ).toHaveLength(320);

    const search = renderer.root.findByProps({
      'data-object-picker-control': 'search',
    });
    act(() => search.props.onChange({ target: { value: 'object_' } }));
    expect(
      renderer.root.findAll(
        (node) => typeof node.props['data-object-name'] === 'string',
      ),
    ).toHaveLength(160);
  });
});
