import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncMappingTable } from './DataSyncMappingTable';
import { DataSyncObjectPicker } from './DataSyncObjectPicker';
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
      renderer.root.findByType(DataSyncObjectPicker).props.mappedSourceNames,
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
      .find((button) => button.children.includes('Edit exception'))!;
    expect(editExceptions.props['aria-expanded']).toBe(false);

    act(() => editExceptions.props.onClick());
    expect(
      renderer.root.findAllByProps({ 'data-mapping-details': 'true' }),
    ).toHaveLength(1);
  });

  it('pins a newly appended mapping into the bounded visible batch', () => {
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

    expect(mappingRows(renderer)).toHaveLength(100);
    expect(
      renderer.root.findByProps({ 'data-mapping-id': 'recent-mapping' }),
    ).toBeTruthy();
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
        .find((button) => button.children.includes('Edit exception'))!
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
        className: 'gn-data-sync-target-state',
        'data-state': 'pending',
      }).children,
    ).toContain('Target pending');
    expect(row.findAllByProps({ children: 'Confirming' })).toHaveLength(1);
    expect(row.findAllByProps({ children: 'Needs attention' })).toHaveLength(0);
    expect(row.findAllByProps({ children: 'Will create' })).toHaveLength(0);
  });
});
