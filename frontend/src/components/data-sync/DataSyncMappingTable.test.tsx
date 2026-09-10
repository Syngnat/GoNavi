import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncMappingTable } from './DataSyncMappingTable';
import {
  createDataSyncTableMapping,
  type DataSyncObjectMetadata,
  type DataSyncTableMapping,
} from './model';
import { createDataSyncWorkbenchTranslate } from './text';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

const metadata = (
  items: DataSyncObjectMetadata[],
): DataSyncMetadataResult<DataSyncObjectMetadata> => ({
  status: 'ready',
  items,
  error: '',
  reload: vi.fn(),
});

const metadataState = (
  status: DataSyncMetadataResult<DataSyncObjectMetadata>['status'],
  items: DataSyncObjectMetadata[] = [],
  reload = vi.fn(),
): DataSyncMetadataResult<DataSyncObjectMetadata> => ({
  status,
  items,
  error: status === 'error' ? 'metadata unavailable' : '',
  reload,
});

const table = (mappings: DataSyncTableMapping[], instanceKey = 'task-1') => {
  const objects = mappings.map((mapping) => ({
    name: mapping.sourceObject,
    kind: 'table' as const,
  }));
  const targets = mappings.map((mapping) => ({
    name: mapping.targetObject,
    kind: 'table' as const,
  }));

  return (
    <DataSyncMappingTable
      key={instanceKey}
      mappings={mappings}
      taskKind="reconcile"
      sourceObjects={metadata(objects)}
      targetObjects={metadata(targets)}
      t={createDataSyncWorkbenchTranslate('en-US')}
      onAdd={() => undefined}
      onAddMany={() => undefined}
      onChange={() => undefined}
      onRemove={() => undefined}
    />
  );
};

const mappingRows = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => typeof node.props['data-mapping-id'] === 'string',
  );

const buttonHasText = (button: TestRenderer.ReactTestInstance, text: string) =>
  button.children.includes(text) ||
  button.findAll((node) => node.children.includes(text)).length > 0;

describe('DataSyncMappingTable', () => {
  it('renders mappings in batches of 100 while keeping the full mapping model', () => {
    const mappings = Array.from({ length: 205 }, (_, index) => ({
      ...createDataSyncTableMapping(
        `mapping-${index + 1}`,
        `source_${index + 1}`,
        `target_${index + 1}`,
      ),
      keyColumns: ['id'],
    }));
    const renderer = TestRenderer.create(table(mappings));

    expect(mappingRows(renderer)).toHaveLength(100);
    expect(
      renderer.root
        .findByProps({ 'data-mapping-catalog': 'true' })
        .findAllByProps({ className: 'gn-data-sync-mapping-catalog__item' }),
    ).toHaveLength(205);

    const showMore = () =>
      renderer.root.findByProps({ 'data-mapping-control': 'show-more' });
    expect(showMore().children).toContain('Show 100 more (105 remaining)');

    act(() => showMore().props.onClick());
    expect(mappingRows(renderer)).toHaveLength(200);
    expect(showMore().children).toContain('Show 5 more (5 remaining)');

    act(() => showMore().props.onClick());
    expect(mappingRows(renderer)).toHaveLength(205);
    expect(
      renderer.root.findAllByProps({ 'data-mapping-control': 'show-more' }),
    ).toHaveLength(0);
  });

  it('keeps a newly added incomplete mapping collapsed until explicitly edited', () => {
    const renderer = TestRenderer.create(table([]));
    const incomplete = createDataSyncTableMapping(
      'mapping-needs-attention',
      'orders',
      'orders',
    );

    act(() => renderer.update(table([incomplete])));

    const row = renderer.root.findByProps({
      'data-mapping-id': 'mapping-needs-attention',
    });
    expect(row.props['data-ready']).toBe('false');
    expect(row.findAllByProps({ 'data-mapping-details': 'true' })).toHaveLength(0);

    const editExceptions = row
      .findAllByType('button')
      .find((button) => buttonHasText(button, 'Edit exception'))!;
    expect(editExceptions.props['aria-expanded']).toBe(false);

    act(() => editExceptions.props.onClick());
    const details = renderer.root.findByProps({ 'data-mapping-details': 'true' });
    expect(row.props['data-expanded']).toBe('true');
    expect(
      details.findByProps({ 'data-mapping-exceptions-for': 'orders' }).children,
    ).toContain('Exceptions for orders');
    expect(details.findAllByProps({ className: 'gn-data-sync-mapping-row__detail' })).toHaveLength(2);
    expect(details.findByProps({ className: 'gn-data-sync-mapping-row__fields' })).toBeTruthy();
    expect(details.findByProps({ className: 'gn-data-sync-mapping-row__fields-action' })).toBeTruthy();
  });

  it('keeps catalog order and still reveals a newly appended mapping', () => {
    const mappings = Array.from({ length: 205 }, (_, index) => ({
      ...createDataSyncTableMapping(
        `existing-${index + 1}`,
        `source_${index + 1}`,
        `target_${index + 1}`,
      ),
      keyColumns: ['id'],
    }));
    const renderer = TestRenderer.create(table(mappings));
    const recent = {
      ...createDataSyncTableMapping('recent-mapping', 'just_added', 'just_added'),
      keyColumns: ['id'],
    };

    act(() => renderer.update(table([...mappings, recent])));

    const rows = mappingRows(renderer);
    expect(rows[0].props['data-mapping-id']).toBe('existing-1');
    expect(
      renderer.root.findByProps({ 'data-mapping-id': 'recent-mapping' }),
    ).toBeTruthy();
    expect(rows[rows.length - 1].props['data-mapping-id']).toBe('recent-mapping');
  });

  it('lists selected mappings in catalog order instead of selection recency', () => {
    const later = {
      ...createDataSyncTableMapping('later', 'customers', 'customers'),
      keyColumns: ['id'],
    };
    const earlier = {
      ...createDataSyncTableMapping('earlier', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[later, earlier]}
        taskKind="reconcile"
        sourceObjects={metadata([
          { name: 'orders', kind: 'table' },
          { name: 'customers', kind: 'table' },
        ])}
        targetObjects={metadata([
          { name: 'orders', kind: 'table' },
          { name: 'customers', kind: 'table' },
        ])}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const rows = mappingRows(renderer);
    expect(rows.map((row) => row.props['data-mapping-id'])).toEqual([
      'earlier',
      'later',
    ]);
    expect(
      rows[0]
        .findByProps({ className: 'gn-data-sync-mapping-row__enabled' })
        .findByType('span').children,
    ).toContain('1');
    expect(
      rows[1]
        .findByProps({ className: 'gn-data-sync-mapping-row__enabled' })
        .findByType('span').children,
    ).toContain('2');
  });

  it('resets the visible batch and expanded rows when the task changes', () => {
    const buildMappings = (taskId: string) =>
      Array.from({ length: 205 }, (_, index) => ({
        ...createDataSyncTableMapping(
          `${taskId}-mapping-${index + 1}`,
          `source_${index + 1}`,
          `target_${index + 1}`,
        ),
        keyColumns: ['id'],
      }));
    const renderer = TestRenderer.create(table(buildMappings('first'), 'first'));

    act(() =>
      renderer.root
        .findByProps({ 'data-mapping-control': 'show-more' })
        .props.onClick(),
    );
    const firstRow = renderer.root.findByProps({
      'data-mapping-id': 'first-mapping-1',
    });
    act(() =>
      firstRow
        .findAllByType('button')
        .find((button) => buttonHasText(button, 'Edit exception'))!
        .props.onClick(),
    );
    expect(mappingRows(renderer)).toHaveLength(200);
    expect(
      renderer.root.findAllByProps({ 'data-mapping-details': 'true' }),
    ).toHaveLength(1);

    act(() => renderer.update(table(buildMappings('second'), 'second')));

    expect(mappingRows(renderer)).toHaveLength(100);
    expect(
      renderer.root.findAllByProps({ 'data-mapping-details': 'true' }),
    ).toHaveLength(0);
  });

  it('offers one central retry when endpoint metadata fails before mappings exist', () => {
    const reloadSource = vi.fn();
    const reloadTarget = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[]}
        taskKind="reconcile"
        sourceObjects={metadataState('error', [], reloadSource)}
        targetObjects={metadataState('ready', [], reloadTarget)}
        endpointsReady
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(renderer.root.findAllByProps({ children: 'Retry' })).toHaveLength(0);
    const retry = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Reload objects'))!;

    act(() => retry.props.onClick());

    expect(reloadSource).toHaveBeenCalledTimes(1);
    expect(reloadTarget).not.toHaveBeenCalled();
  });

  it('refreshes an empty source object list from the empty state', () => {
    const reloadSource = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[]}
        taskKind="reconcile"
        sourceObjects={metadataState('ready', [], reloadSource)}
        targetObjects={metadataState('ready')}
        endpointsReady
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const refresh = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Refresh object list'))!;
    act(() => refresh.props.onClick());

    expect(reloadSource).toHaveBeenCalledTimes(1);
  });

  it('ignores source metadata for query-sink tasks and retries only the target', () => {
    const reloadSource = vi.fn();
    const reloadTarget = vi.fn();
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[]}
        taskKind="querySink"
        sourceObjects={metadataState('error', [], reloadSource)}
        targetObjects={metadataState('error', [], reloadTarget)}
        endpointsReady
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(
      renderer.root.findAllByProps({ 'data-metadata-scope': 'source-objects' }),
    ).toHaveLength(0);
    const retry = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Reload objects'))!;
    act(() => retry.props.onClick());

    expect(reloadSource).not.toHaveBeenCalled();
    expect(reloadTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps a mapping pending until target metadata is ready', () => {
    const mapping = {
      ...createDataSyncTableMapping('pending-target', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[mapping]}
        taskKind="reconcile"
        sourceObjects={metadata([{ name: 'orders', kind: 'table' }])}
        targetObjects={metadataState('loading')}
        endpointsReady
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const row = renderer.root.findByProps({ 'data-mapping-id': 'pending-target' });
    expect(row.props['data-ready']).toBe('false');
    expect(
      row.findByProps({
        'data-mapping-hint': 'target',
        'data-state': 'pending',
      }).children,
    ).toContain('Checking whether this table already exists on the target');
    expect(row.findAllByProps({ children: 'Confirming' })).toHaveLength(0);
    expect(row.findAllByProps({ children: 'Configured' })).toHaveLength(0);
    expect(row.findAllByProps({ children: 'Needs attention' })).toHaveLength(0);
    expect(row.findAllByProps({ className: 'gn-data-sync-mapping-row__status' })).toHaveLength(0);
  });

  it('keeps a matched existing target quiet and only shows actions on the right', () => {
    const mapping = {
      ...createDataSyncTableMapping('ready-map', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[mapping]}
        taskKind="reconcile"
        sourceObjects={metadata([{ name: 'orders', kind: 'table' }])}
        targetObjects={metadata([{ name: 'orders', kind: 'table' }])}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const row = renderer.root.findByProps({ 'data-mapping-id': 'ready-map' });
    expect(row.props['data-ready']).toBe('true');
    expect(row.findAllByProps({ 'data-mapping-hint': 'target' })).toHaveLength(0);
    expect(row.findAllByProps({ children: 'Writes to the existing table' })).toHaveLength(0);
    expect(row.findAllByProps({ children: 'Configured' })).toHaveLength(0);

    const actions = row.findByProps({ className: 'gn-data-sync-mapping-row__actions' });
    const actionButtons = actions.findAllByType('button');
    expect(actionButtons).toHaveLength(2);
    expect(buttonHasText(actionButtons[0], 'Edit exception')).toBe(true);
    expect(buttonHasText(actionButtons[0], 'Collapse')).toBe(false);
    expect(actionButtons[0].props['aria-expanded']).toBe(false);
    expect(buttonHasText(actionButtons[1], 'Remove')).toBe(true);
    act(() => actionButtons[0].props.onClick());
    expect(buttonHasText(actionButtons[0], 'Collapse')).toBe(true);
    expect(buttonHasText(actionButtons[0], 'Edit exception')).toBe(false);
    expect(actionButtons[0].props['aria-expanded']).toBe(true);
  });

  it('explains when the target table is missing and will be created', () => {
    const mapping = {
      ...createDataSyncTableMapping('create-map', 'orders', 'orders_archive'),
      keyColumns: ['id'],
      targetMode: 'create_or_reuse' as const,
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[mapping]}
        taskKind="reconcile"
        sourceObjects={metadata([{ name: 'orders', kind: 'table' }])}
        targetObjects={metadata([])}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const row = renderer.root.findByProps({ 'data-mapping-id': 'create-map' });
    expect(
      row.findByProps({ 'data-mapping-hint': 'target', 'data-state': 'create' }).children,
    ).toContain('This table is not on the target yet; it will be created during sync');
  });

  it('lets the source catalog add and remove mappings without opening the picker', () => {
    const onAddMany = vi.fn();
    const onRemove = vi.fn();
    const mapping = {
      ...createDataSyncTableMapping('mapped-orders', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[mapping]}
        taskKind="reconcile"
        sourceObjects={metadata([
          { name: 'orders', kind: 'table' },
          { name: 'customers', kind: 'table' },
        ])}
        targetObjects={metadata([{ name: 'orders', kind: 'table' }])}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onAdd={() => undefined}
        onAddMany={onAddMany}
        onChange={() => undefined}
        onRemove={onRemove}
      />,
    );

    const catalog = renderer.root.findByProps({ 'data-mapping-catalog': 'true' });
    const items = catalog.findAllByProps({ className: 'gn-data-sync-mapping-catalog__item' });
    expect(items).toHaveLength(2);
    expect(items[0].props['data-checked']).toBe('true');
    expect(items[1].props['data-checked']).toBe('false');

    const row = renderer.root.findByProps({ 'data-mapping-id': 'mapped-orders' });
    expect(row.props['data-source-locked']).toBe('true');
    expect(
      row.findByProps({ 'data-object-side': 'source', 'data-object-name': 'orders' }).children,
    ).toContain('orders');
    expect(row.findByProps({ 'data-mapping-field-label': 'source' }).children).toContain(
      'Selected table',
    );
    expect(row.findByProps({ 'data-mapping-field-label': 'target' }).children).toContain(
      'Write to',
    );
    expect(row.findAllByProps({ 'data-object-side': 'source', role: 'combobox' })).toHaveLength(0);
    const targetCombobox = row.findByProps({ 'data-object-side': 'target', role: 'combobox' });
    expect(targetCombobox).toBeTruthy();
    expect(targetCombobox.props['aria-labelledby']).toBe('mapped-orders-target-label');

    act(() => items[1].findByType('input').props.onChange({ target: { checked: true } }));
    expect(onAddMany).toHaveBeenCalledWith(['orders', 'customers']);
    act(() => items[0].findByType('input').props.onChange({ target: { checked: false } }));
    expect(onRemove).toHaveBeenCalledWith('mapped-orders');
  });

  it('does not offer a second picker when the source catalog is visible', () => {
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[]}
        taskKind="reconcile"
        sourceObjects={metadata([
          { name: 'admin_users', kind: 'table' },
          { name: 'messages', kind: 'table' },
        ])}
        targetObjects={metadata([{ name: 'admin_users', kind: 'table' }])}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(renderer.root.findByProps({ 'data-mapping-catalog': 'true' })).toBeTruthy();
    const empty = renderer.root.findByProps({
      className: 'gn-data-sync-mapping-empty',
    });
    expect(empty.props['data-state']).toBe('catalog');
    expect(empty.findAllByType('button')).toHaveLength(0);
    expect(
      renderer.root.findAllByType('button').filter((button) =>
        buttonHasText(button, '选择源对象') || buttonHasText(button, '添加源对象'),
      ),
    ).toHaveLength(0);
  });

  it('opens the target object list above overflow clipping and shows every table', () => {
    const onChange = vi.fn();
    const mapping = {
      ...createDataSyncTableMapping('mapped-users', 'admin_users', 'admin_users'),
      keyColumns: ['id'],
    };
    const renderer = TestRenderer.create(
      <DataSyncMappingTable
        mappings={[mapping]}
        taskKind="reconcile"
        sourceObjects={metadata([
          { name: 'admin_users', kind: 'table' },
          { name: 'messages', kind: 'table' },
        ])}
        targetObjects={metadata([
          { name: 'admin_users', kind: 'table' },
          { name: 'messages', kind: 'table' },
          { name: 'push_records', kind: 'table' },
        ])}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onAdd={() => undefined}
        onAddMany={() => undefined}
        onChange={onChange}
        onRemove={() => undefined}
      />,
    );

    const combobox = renderer.root.findByProps({
      'data-object-side': 'target',
      role: 'combobox',
    });
    expect(combobox.props['aria-expanded']).toBe(false);
    expect(
      renderer.root.findAllByProps({ 'data-object-combobox-menu': 'true' }),
    ).toHaveLength(0);

    act(() =>
      renderer.root
        .findByProps({ className: 'gn-data-sync-object-combobox__toggle' })
        .props.onClick(),
    );

    const menu = renderer.root.findByProps({ 'data-object-combobox-menu': 'true' });
    expect(menu.props.role).toBe('listbox');
    expect(combobox.props['aria-expanded']).toBe(true);
    const options = menu.findAllByProps({ role: 'option' });
    expect(
      options.map((option) => option.findByType('span').children[0]),
    ).toEqual(['admin_users', 'messages', 'push_records']);

    act(() => options[1].props.onMouseDown({ preventDefault() {} }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetObject: 'messages' }),
    );
    expect(
      renderer.root.findAllByProps({ 'data-object-combobox-menu': 'true' }),
    ).toHaveLength(0);
  });
});
