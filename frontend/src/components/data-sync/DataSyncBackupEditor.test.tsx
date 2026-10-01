import React from 'react';
import { syncjob } from '../../../wailsjs/go/models';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../../i18n';
import { DataSyncTaskEditor } from './DataSyncEditorRouter';
import { createStaticDataSyncWorkbenchGateway } from './gateway';
import { DATA_SYNC_FAMILY_KIND_CHOICES, createDataSyncTaskDraft, createDataSyncTableMapping, validateDataSyncTask, type DataSyncTaskDefinition, type DataSyncTaskStage } from './model';
import { encodeDataSyncJobDefinition, decodeDataSyncJobDefinition } from './wailsDto';
import { createDataSyncWorkbenchTranslate } from './text';

const configuredBackup = (): DataSyncTaskDefinition => {
  const task = createDataSyncTaskDraft({ id: 'backup-1', kind: 'backup', name: 'Daily backup' });
  return { ...task, source: { ...task.source, connectionId: 'source', type: 'sqlite', database: 'sample.db' },
    backup: { directory: 'D:\\Backups', content: 'both' },
    mappings: [createDataSyncTableMapping('orders', 'orders', ''), createDataSyncTableMapping('items', 'items', '')],
    trigger: { mode: 'cron', expression: '0 2 * * *', timezone: 'Asia/Shanghai', overlap: 'skip' },
  };
};

const renderBackup = async (stage: DataSyncTaskStage) => {
  const patch = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<DataSyncTaskEditor task={configuredBackup()} activeStage={stage}
      gateway={createStaticDataSyncWorkbenchGateway()} capability={{ level: 'full', canExecute: true, supportsAutoCreate: false, supportsCdc: false }}
      preflight={null} preflightStale t={createDataSyncWorkbenchTranslate('zh-CN')} onPatch={patch} onStageChange={vi.fn()} />);
  });
  return { renderer, patch };
};

describe('backup workbench tasks', () => {
  beforeEach(() => setCurrentLanguage('zh-CN'));
  it('offers backup without target or write configuration requirements', () => {
    expect(DATA_SYNC_FAMILY_KIND_CHOICES.sync.some((choice) => choice.kind === 'backup')).toBe(true);
    expect(createDataSyncWorkbenchTranslate('zh-CN')('task_kind.backup')).toBe('数据库备份');
    const task = configuredBackup();
    expect(task.delivery.writeMode).toBe('none');
    expect(validateDataSyncTask(task)).toEqual([]);
    expect(validateDataSyncTask({ ...task, backup: { directory: '', content: 'both' } })).toEqual([
      expect.objectContaining({ code: 'backup_directory_required', stage: 'delivery' }),
    ]);
  });

  it('round trips backup content, empty target and Cron through the backend DTO', () => {
    const task = configuredBackup();
    const wire = new syncjob.JobDefinition(encodeDataSyncJobDefinition(task));
    const loaded = decodeDataSyncJobDefinition({ ...wire, id: 'backup-persisted', revision: 1, createdAt: 1, updatedAt: 1 });
    expect(loaded.kind).toBe('backup');
    expect(loaded.backup).toEqual(task.backup);
    expect(loaded.target.connectionId).toBe('');
    expect(loaded.mappings.map((mapping) => mapping.sourceObject)).toEqual(['orders', 'items']);
    expect(loaded.trigger).toEqual(task.trigger);
    expect(loaded.delivery.writeMode).toBe('none');
  });

  it('shows a source-only endpoint selector', async () => {
    const { renderer } = await renderBackup('endpoints');
    expect(renderer.root.findAllByProps({ 'data-endpoint-role': 'source' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-endpoint-role': 'target' })).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it('edits the backup directory independently of target writes', async () => {
    const { renderer, patch } = await renderBackup('delivery');
    const directory = renderer.root.findAllByType('input').find((input) => input.props.value === 'D:\\Backups')!;
    await act(async () => directory.props.onChange({ target: { value: 'E:\\Daily' } }));
    expect(patch).toHaveBeenCalledWith({ backup: { directory: 'E:\\Daily', content: 'both' } });
    expect(JSON.stringify(renderer.toJSON())).toContain('表级逻辑备份');
    await act(async () => renderer.unmount());
  });

  it('keeps snapshot mode fixed and explains background requirements', async () => {
    const { renderer } = await renderBackup('trigger');
    const incremental = renderer.root.findAllByType('select').find((select) => select.props.value === 'snapshot');
    expect(incremental?.props.disabled).toBe(true);
    expect(incremental?.findAllByType('option').map((option) => option.props.value)).toEqual(['snapshot']);
    expect(JSON.stringify(renderer.toJSON())).toContain('每次运行都会完整导出');
    expect(JSON.stringify(renderer.toJSON())).toContain('无需保持 GoNavi 运行');
    await act(async () => renderer.unmount());
  });
});
