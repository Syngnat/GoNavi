import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncTaskEditor } from './DataSyncTaskEditor';
import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncRouteCapability,
  type DataSyncTaskDefinition,
} from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const supportedCapability: DataSyncRouteCapability = {
  level: 'full',
  canExecute: true,
  supportsAutoCreate: true,
  supportsAutoAddColumns: true,
  requiresExistingTarget: false,
  supportsMutations: true,
  supportsCdc: true,
};

const endpoint = (role: 'source' | 'target', schema = 'public') => ({
  connectionId: role,
  connectionName: role,
  type: 'mysql',
  database: role === 'source' ? 'source_db' : 'target_db',
  schema,
});

const renderDelivery = async (
  task: DataSyncTaskDefinition,
  onPatch = vi.fn(),
  capability = supportedCapability,
) => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <DataSyncTaskEditor
        task={task}
        gateway={createStaticDataSyncWorkbenchGateway()}
        capability={capability}
        activeStage="delivery"
        preflight={null}
        preflightStale
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onStageChange={() => undefined}
        onPatch={onPatch}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { renderer, onPatch };
};

describe('DataSyncTaskEditor delivery stage', () => {
  it('makes quarantine one explicit choice that stores complete rows locally for retry', async () => {
    const mapping = {
      ...createDataSyncTableMapping('cdc:mapping:1', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const task = reviseDataSyncTask(createDataSyncTaskDraft({ id: 'cdc', kind: 'cdc' }), {
      source: endpoint('source'),
      target: endpoint('target'),
      mappings: [mapping],
    });
    const { renderer, onPatch } = await renderDelivery(task);

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('完整失败行会保存在本机任务数据库中');
    expect(rendered).toContain('可在错误行列表中重试');
    expect(rendered).not.toContain('保存隔离行数据');

    const quarantine = renderer.root.findByProps({
      'data-error-policy-option': 'quarantine',
    });
    act(() => quarantine.findByType('input').props.onChange());

    expect(onPatch).toHaveBeenLastCalledWith({
      delivery: expect.objectContaining({
        errorPolicy: 'quarantine',
        captureErrorPayload: true,
      }),
    });
  });

  it('shows delete propagation only for keyed snapshot reconcile and resets an invalid saved value', async () => {
    const mapping = {
      ...createDataSyncTableMapping('reconcile:mapping:1', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const validTask = reviseDataSyncTask(
      createDataSyncTaskDraft({ id: 'reconcile', kind: 'reconcile' }),
      {
        source: endpoint('source'),
        target: endpoint('target'),
        mappings: [mapping],
      },
    );
    const valid = await renderDelivery(validTask);
    expect(
      valid.renderer.root.findAllByProps({ 'data-delete-propagation': 'true' }),
    ).toHaveLength(1);

    const invalidTask = reviseDataSyncTask(validTask, {
      mappings: [{ ...mapping, keyColumns: [] }],
      delivery: { ...validTask.delivery, propagateDeletes: true },
    });
    const invalid = await renderDelivery(invalidTask);
    expect(
      invalid.renderer.root.findAllByProps({ 'data-delete-propagation': 'true' }),
    ).toHaveLength(0);
    expect(invalid.onPatch).toHaveBeenCalledWith({
      delivery: expect.objectContaining({ propagateDeletes: false }),
    });

    const cdcWithoutKey = reviseDataSyncTask(
      createDataSyncTaskDraft({ id: 'cdc-without-key', kind: 'cdc' }),
      {
        source: endpoint('source'),
        target: endpoint('target'),
        mappings: [createDataSyncTableMapping('cdc-without-key:mapping', 'orders', 'orders')],
        delivery: {
          ...createDataSyncTaskDraft({ id: 'cdc-options', kind: 'cdc' }).delivery,
          propagateDeletes: true,
        },
      },
    );
    const invalidCdc = await renderDelivery(cdcWithoutKey);
    expect(
      invalidCdc.renderer.root.findAllByProps({
        'data-delete-propagation': 'true',
      }),
    ).toHaveLength(0);
    expect(invalidCdc.onPatch).toHaveBeenCalledWith({
      delivery: expect.objectContaining({ propagateDeletes: false }),
    });
  });

  it('constrains append-only targets to inserts and removes delete propagation', async () => {
    const mapping = {
      ...createDataSyncTableMapping('timeseries:mapping:1', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const base = createDataSyncTaskDraft({ id: 'timeseries', kind: 'reconcile' });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source'),
      target: endpoint('target'),
      mappings: [mapping],
      delivery: {
        ...base.delivery,
        writeMode: 'upsert',
        retryLimit: 3,
        propagateDeletes: true,
      },
    });
    const { renderer, onPatch } = await renderDelivery(task, vi.fn(), {
      ...supportedCapability,
      supportsMutations: false,
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('当前时序目标仅支持追加写入');
    expect(renderer.root.findAllByProps({ 'data-delete-propagation': 'true' })).toHaveLength(0);
    const upsert = renderer.root
      .findAllByType('option')
      .find((option) => option.props.value === 'upsert')!;
    expect(upsert.props.disabled).toBe(true);
    expect(onPatch).toHaveBeenCalledWith({
      delivery: expect.objectContaining({
        writeMode: 'append',
        retryLimit: 0,
        propagateDeletes: false,
      }),
    });
  });

  it('keeps migration schema controls when same-name mappings have detected key columns', async () => {
    const implicitMapping = {
      ...createDataSyncTableMapping('migration:mapping:1', 'public.orders', 'public.orders'),
      targetMode: 'create_or_reuse' as const,
    };
    const implicitTask = reviseDataSyncTask(
      createDataSyncTaskDraft({ id: 'migration', kind: 'migration' }),
      {
        source: endpoint('source'),
        target: endpoint('target'),
        mappings: [implicitMapping],
      },
    );
    const implicit = await renderDelivery(implicitTask);
    expect(
      implicit.renderer.root.findAllByProps({
        'data-structure-option': 'auto-add-columns',
      }),
    ).toHaveLength(1);
    expect(
      implicit.renderer.root.findAllByProps({
        'data-structure-option': 'create-indexes',
      }),
    ).toHaveLength(1);

    const detectedKeyTask = reviseDataSyncTask(implicitTask, {
      mappings: [{ ...implicitMapping, keyColumns: ['id'] }],
      delivery: {
        ...implicitTask.delivery,
        autoAddColumns: true,
        createIndexes: true,
      },
    });
    const detectedKey = await renderDelivery(detectedKeyTask);
    expect(
      detectedKey.renderer.root.findAllByProps({
        'data-structure-option': 'auto-add-columns',
      }),
    ).toHaveLength(1);
    expect(detectedKey.onPatch).not.toHaveBeenCalledWith({
      delivery: expect.objectContaining({ autoAddColumns: false }),
    });
  });

  it('keeps migration schema controls for same-name tables in different schemas', async () => {
    const mapping = {
      ...createDataSyncTableMapping('migration:cross-schema', 'source.orders', 'target.orders'),
      targetMode: 'existing_only' as const,
    };
    const base = createDataSyncTaskDraft({ id: 'migration-cross-schema', kind: 'migration' });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source', 'source'),
      target: endpoint('target', 'target'),
      mappings: [mapping],
    });

    const { renderer } = await renderDelivery(task);
    expect(
      renderer.root.findAllByProps({
        'data-structure-option': 'auto-add-columns',
      }),
    ).toHaveLength(1);
  });

  it('keeps schema-only migration writable and exposes automatic missing-column DDL', async () => {
    const base = createDataSyncTaskDraft({
      id: 'schema-sync',
      kind: 'migration',
      content: 'schema',
    });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source'),
      target: endpoint('target'),
      mappings: [
        createDataSyncTableMapping('schema-sync:mapping:1', 'orders', 'orders'),
      ],
      delivery: {
        ...base.delivery,
        autoAddColumns: true,
      },
    });
    const { renderer } = await renderDelivery(task);
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain('此任务仅执行结构变更');
    expect(
      renderer.root.findAllByProps({
        'data-structure-option': 'auto-add-columns',
      }),
    ).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType('select')
        .some((select) => select.props.value === 'schema'),
    ).toBe(true);
  });

  it('keeps schema-only migration defaults before table mappings are selected', async () => {
    const base = createDataSyncTaskDraft({
      id: 'migration-schema-only-empty',
      kind: 'migration',
      content: 'schema',
    });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source', 'source'),
      target: endpoint('target', 'target'),
    });
    const { onPatch } = await renderDelivery(task);

    expect(onPatch).not.toHaveBeenCalled();
  });

  it('explains compare tasks without exposing irrelevant write controls', async () => {
    const task = createDataSyncTaskDraft({ id: 'compare', kind: 'compare' });
    const { renderer } = await renderDelivery(task);
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain('这是只读比较任务');
    expect(rendered).toContain('不会写入或删除目标端数据');
    expect(
      renderer.root.findAllByProps({ 'data-delivery-policy': 'error' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-delivery-advanced': 'true' }),
    ).toHaveLength(0);
  });

  it('does not offer non-atomic overwrite for new persistent tasks', async () => {
    const mapping = {
      ...createDataSyncTableMapping('reconcile:mapping:overwrite', 'orders', 'orders'),
      keyColumns: ['id'],
    };
    const task = reviseDataSyncTask(
      createDataSyncTaskDraft({ id: 'reconcile-overwrite', kind: 'reconcile' }),
      {
        source: endpoint('source'),
        target: endpoint('target'),
        mappings: [mapping],
      },
    );
    const { renderer } = await renderDelivery(task);
    const overwrite = renderer.root
      .findAllByType('option')
      .find((option) => option.props.value === 'overwrite')!;

    expect(overwrite.props.disabled).toBe(true);
    expect(overwrite.children).toContain('覆盖（当前任务系统暂不支持）');
  });

  it('disables run recovery for append delivery and exposes the effective policy', async () => {
    const base = createDataSyncTaskDraft({ id: 'append-recovery', kind: 'reconcile' });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source'),
      target: endpoint('target'),
      delivery: { ...base.delivery, writeMode: 'append', retryLimit: 0 },
      resumePolicy: 'manual',
    });
    const { renderer, onPatch } = await renderDelivery(task);

    expect(
      renderer.root.findByProps({ 'data-delivery-recovery': 'append' }),
    ).toBeTruthy();
    expect(onPatch).toHaveBeenCalledWith({ resumePolicy: 'never' });
  });

  it('hides write recovery and delete controls when the resolved route cannot run CDC', async () => {
    const mapping = {
      ...createDataSyncTableMapping('cdc:mapping:unsupported', 'orders', 'orders'),
      keyColumns: ['id'],
      fields: [
        {
          id: 'cdc:id',
          sourceField: 'id',
          targetField: 'id',
          sourceType: 'bigint',
          targetType: 'bigint',
          transform: '',
          nullable: false,
        },
      ],
    };
    const base = createDataSyncTaskDraft({ id: 'cdc-unsupported', kind: 'cdc' });
    const task = reviseDataSyncTask(base, {
      source: endpoint('source'),
      target: endpoint('target'),
      mappings: [mapping],
      delivery: {
        ...base.delivery,
        errorPolicy: 'quarantine',
        captureErrorPayload: true,
        propagateDeletes: true,
      },
    });
    const unsupportedCdc: DataSyncRouteCapability = {
      ...supportedCapability,
      supportsCdc: false,
    };
    const { renderer, onPatch } = await renderDelivery(
      task,
      vi.fn(),
      unsupportedCdc,
    );

    expect(
      renderer.root.findAllByProps({ 'data-error-policy-option': 'quarantine' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-delete-propagation': 'true' }),
    ).toHaveLength(0);
    expect(onPatch).toHaveBeenCalledWith({
      delivery: expect.objectContaining({
        errorPolicy: 'stop',
        captureErrorPayload: false,
        propagateDeletes: false,
      }),
    });
  });
});
