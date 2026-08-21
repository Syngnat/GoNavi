import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeApi = vi.hoisted(() => ({
  ClipboardSetText: vi.fn(() => Promise.resolve(false)),
}));
const clipboardWriteText = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../../../wailsjs/runtime/runtime', () => runtimeApi);

import { DataSyncPreflightPanel } from './DataSyncPreflightPanel';

vi.stubGlobal('navigator', {
  clipboard: {
    writeText: clipboardWriteText,
  },
});
import {
  createDataSyncWorkbenchTranslate,
  dataSyncValidationIssueText,
} from './text';

const unmigratedIndexSnapshot = () => ({
  taskId: 'task-1',
  taskRevision: 3,
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
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue(undefined);
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
        { code: 'driver_specific_failure', message: 'driver unavailable' },
        t,
      ),
    ).toBe('driver unavailable');
  });

  it('prefers the localized validation text over a backend English message', () => {
    const renderer = TestRenderer.create(
      <DataSyncPreflightPanel
        snapshot={{
          taskId: 'task-1',
          taskRevision: 5,
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

  it('uses the backend notBefore window and never creates a frontend-only approval', () => {
    vi.useFakeTimers();
    const now = Date.parse('2030-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    const onBegin = vi.fn();
    const onApprove = vi.fn();
    const snapshot = {
      taskId: 'task-1',
      taskRevision: 4,
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
            taskId: 'task-1',
            definitionHash: 'hash-1',
            taskRevision: 4,
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
    const confirm = renderer.root
      .findAllByType('button')
      .find((button) =>
        button.children.includes('Confirm production write and grant token'),
      )!;
    expect(confirm.props.disabled).toBe(false);
    act(() => confirm.props.onClick());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
