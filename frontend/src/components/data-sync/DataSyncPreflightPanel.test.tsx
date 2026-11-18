import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeApi = vi.hoisted(() => ({
  ClipboardSetText: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../../wailsjs/runtime/runtime', () => runtimeApi);

import { DataSyncPreflightPanel } from './DataSyncPreflightPanel';

vi.stubGlobal('navigator', {
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
  },
});
import {
  createDataSyncWorkbenchTranslate,
  dataSyncValidationIssueText,
} from './text';

const unmigratedIndexSnapshot = () => ({
  taskId: 'task-1',
  taskRevision: 3,
  taskEditEpoch: 0,
  status: 'warning' as const,
  issues: [
    {
      id: 'unmigrated_index:map-1:0',
      code: 'unmigrated_index' as const,
      severity: 'warning' as const,
      stage: 'mappings' as const,
      mappingId: 'map-1',
      message: 'review remediation',
      detail: {
        unmigratedIndex: {
          name: 'idx_name_prefix',
          columns: [{ name: 'name', prefixLength: 12 }],
          unique: false,
          indexType: 'BTREE',
          reason: 'review remediation',
          remediationStatements: [
            'CREATE INDEX idx_name_prefix ON public.users (left(name, 12))',
          ],
        },
      },
    },
  ],
  definitionHash: 'hash-1',
  approvalRequired: false,
  approvalSatisfied: false,
  checkedAt: '2030-08-08T00:00:00.000Z',
});

afterEach(() => {
  vi.useRealTimers();
  runtimeApi.ClipboardSetText.mockReset();
  runtimeApi.ClipboardSetText.mockResolvedValue(false);
  (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockReset();
  (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('DataSyncPreflightPanel production approval', () => {
  it('localizes known backend issue codes and preserves unknown diagnostics', () => {
    const t = createDataSyncWorkbenchTranslate('zh-CN');

    expect(
      dataSyncValidationIssueText(
        {
          code: 'route_unsupported',
          message: 'migration route mysql -> qdrant is unsupported',
        },
        t,
      ),
    ).toBe('当前源端与目标端组合不支持执行此同步任务。');
    expect(
      dataSyncValidationIssueText(
        { code: 'query_key_unmapped', message: 'query sink stable key external_id is not mapped to a target column' },
        t,
      ),
    ).toBe('SQL 结果的稳定键必须映射到目标字段。');
    expect(
      dataSyncValidationIssueText(
        { code: 'query_key_target_missing', message: 'query sink stable key external_id maps to missing target column external_code' },
        t,
      ),
    ).toBe('SQL 结果的稳定键映射到了不存在的目标字段。');
    expect(
      dataSyncValidationIssueText(
        { code: 'mapping_key_unmapped', message: 'stable key external_id is not mapped to a target column' },
        t,
      ),
    ).toBe('稳定键必须映射到目标字段。');
    expect(
      dataSyncValidationIssueText(
        { code: 'structure_migration_primary_key_required', message: 'source physical primary key required' },
        t,
      ),
    ).toBe('同步表结构时只能按源表主键识别同一行。点「定位」后在「编辑例外」里把「用于识别同一行」改成只保留主键列（去掉唯一索引列或业务字段）。');
    expect(
      dataSyncValidationIssueText(
        {
          code: 'cdc_adapter_not_ready',
          message: 'MongoDB 必须运行在副本集或分片集群模式。',
        },
        t,
      ),
    ).toBe('当前选择的增量同步方式还不能用。 MongoDB 必须运行在副本集或分片集群模式。');
    // issue #1298：definition_invalid 包装了后端所有 ValidateDefinition 失败，
    // 丢掉 message 后用户无从定位（例如 Cron 段数不对）。
    expect(
      dataSyncValidationIssueText(
        {
          code: 'definition_invalid',
          message:
            'cronExpression must contain five fields: minute hour day month weekday',
        },
        t,
      ),
    ).toBe(
      '任务定义无效，请检查必填项、对象映射和执行策略。 cronExpression must contain five fields: minute hour day month weekday',
    );
    expect(
      dataSyncValidationIssueText(
        { code: 'driver_specific_failure', message: 'driver unavailable' },
        t,
      ),
    ).toBe('driver unavailable');
  });

  it('keeps the localized validation text and appends the backend diagnostic', () => {
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={{
          taskId: 'task-1',
          taskRevision: 5,
          taskEditEpoch: 0,
          status: 'blocked',
          issues: [
            {
              id: 'definition_invalid:map-1',
              code: 'definition_invalid',
              severity: 'blocker',
              stage: 'mappings',
              mappingId: 'map-1',
              message:
                'table mapping 1 requires a targetTable and a sourceTable unless this is a query sink',
            },
          ],
          definitionHash: '',
          approvalRequired: false,
          approvalSatisfied: false,
          checkedAt: '2030-08-08T00:00:00.000Z',
        }}
        currentRevision={5}
        stale={false}
        running={false}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        onLocateIssue={() => undefined}
      />,
    );

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain(
      '任务定义无效，请检查必填项、对象映射和执行策略。',
    );
    // issue #1298：本地化文案保留分类，后端原文提供可定位的具体原因。
    expect(rendered).toContain('requires a targetTable');
    expect(renderer.root.findByType('p').props.title).toContain(
      'requires a targetTable',
    );
  });

  it('renders unmigrated indexes and copies remediation DDL', async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={unmigratedIndexSnapshot()}
        currentRevision={3}
        stale={false}
        running={false}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onLocateIssue={() => undefined}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain('Unmigrated indexes (1)');
    expect(JSON.stringify(renderer.toJSON())).toContain('Columns: name(12)');

    const copyButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Copy remediation DDL'))!;
    await act(async () => {
      await copyButton.props.onClick();
    });
    expect(runtimeApi.ClipboardSetText).toHaveBeenCalledWith(
      '-- idx_name_prefix: review remediation\n\nCREATE INDEX idx_name_prefix ON public.users (left(name, 12));',
    );
    expect(writeText).toHaveBeenCalledWith(
      '-- idx_name_prefix: review remediation\n\nCREATE INDEX idx_name_prefix ON public.users (left(name, 12));',
    );
  });

  it('shows a visible error when both clipboard paths fail', async () => {
    runtimeApi.ClipboardSetText.mockRejectedValueOnce(new Error('runtime unavailable'));
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('clipboard denied'),
    );
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={unmigratedIndexSnapshot()}
        currentRevision={3}
        stale={false}
        running={false}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onLocateIssue={() => undefined}
      />,
    );

    const copyButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Copy remediation DDL'))!;
    await act(async () => {
      await copyButton.props.onClick();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Copy failed. Copy the DDL manually from the list below.',
    );
  });

  it('shows a stored production approval as already satisfied', () => {
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={{
          taskId: 'task-1',
          taskRevision: 4,
          taskEditEpoch: 0,
          status: 'passed',
          issues: [],
          definitionHash: 'hash-1',
          approvalRequired: true,
          approvalSatisfied: true,
          checkedAt: '2030-08-08T00:00:00.000Z',
        }}
        currentRevision={4}
        stale={false}
        running={false}
        t={createDataSyncWorkbenchTranslate('en-US')}
        onLocateIssue={() => undefined}
        onBeginApproval={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain(
      'One-time production authorization granted',
    );
    expect(
      renderer.root.findAllByType('button').some((button) =>
        button.children.join('').includes('Begin server 10-second confirmation'),
      ),
    ).toBe(false);
  });

  it('auto-approves only after the backend notBefore window', () => {
    vi.useFakeTimers();
    const now = Date.parse('2030-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    const onBegin = vi.fn();
    const onApprove = vi.fn();
    const snapshot = {
      taskId: 'task-1',
      taskRevision: 4,
      taskEditEpoch: 0,
      status: 'passed' as const,
      issues: [],
      definitionHash: 'hash-1',
      approvalRequired: true,
      approvalSatisfied: false,
      checkedAt: new Date(now).toISOString(),
    };
    const t = createDataSyncWorkbenchTranslate('en-US');
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={snapshot}
        currentRevision={4}
        stale={false}
        running={false}
        t={t}
        onLocateIssue={() => undefined}
        onBeginApproval={onBegin}
        onApprove={onApprove}
      />,
    );

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) =>
          button.children.includes('Begin server 10-second confirmation'),
        )!
        .props.onClick();
    });
    expect(onBegin).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();

    act(() => {
      renderer.update(
        <DataSyncPreflightPanel
          snapshot={snapshot}
          currentRevision={4}
          stale={false}
          running={false}
          t={t}
          onLocateIssue={() => undefined}
          approvalChallenge={{
            definitionHash: 'hash-1',
            notBefore: new Date(now + 10_000).toISOString(),
            expiresAt: new Date(now + 120_000).toISOString(),
          }}
          onBeginApproval={onBegin}
          onApprove={onApprove}
        />,
      );
    });
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Wait 10 seconds'))!.props.disabled,
    ).toBe(true);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    const confirm = renderer.root
      .findAllByType('button')
      .find((button) =>
        button.children.includes('Confirm production write and grant token'),
      )!;
    expect(confirm.props.disabled).toBe(false);
    act(() => {
      renderer.update(
        <DataSyncPreflightPanel
          snapshot={snapshot}
          currentRevision={4}
          stale={false}
          running={false}
          t={t}
          onLocateIssue={() => undefined}
          approvalChallenge={{
            definitionHash: 'hash-1',
            notBefore: new Date(now + 10_000).toISOString(),
            expiresAt: new Date(now + 120_000).toISOString(),
          }}
          approving
          onBeginApproval={onBegin}
          onApprove={onApprove}
        />,
      );
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Requesting authorization'))!
        .props.disabled,
    ).toBe(true);
  });
});
