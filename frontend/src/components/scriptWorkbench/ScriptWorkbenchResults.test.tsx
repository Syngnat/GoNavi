/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ScriptWorkbenchResults } from './ScriptWorkbenchResults';
import type { ScriptAuditEntry, ScriptOutputPage } from './scriptWorkbenchTypes';

vi.mock('antd', () => ({
  Spin: () => <span />,
}));

const outputs: ScriptOutputPage[] = [
  {
    outputId: 'run:0',
    name: 'first',
    columns: ['value'],
    rows: [{ value: 1 }],
    page: 1,
    pageSize: 100,
    totalRows: 1,
  },
  {
    outputId: 'run:1',
    name: 'second',
    columns: ['value'],
    rows: [{ value: 2 }],
    page: 1,
    pageSize: 100,
    totalRows: 1,
  },
];

const audit: ScriptAuditEntry = {
  id: 'audit-1',
  at: 1,
  connectionAlias: 'prod',
  database: 'app',
  sql: 'select 1',
  durationMs: 1,
  rowCount: 1,
  write: false,
};

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('ScriptWorkbenchResults', () => {
  it('switches between named outputs and marks a truncated audit trail', async () => {
    const onSelectOutput = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptWorkbenchResults
          status="completed"
          progress={null}
          result={{ success: true, durationMs: 1 }}
          outputs={outputs}
          selectedOutputId="run:0"
          logs={[]}
          audits={[audit]}
          auditsTruncated
          logsTruncated
          outputsTruncated
          pageLoading={false}
          t={(key) => key}
          onSelectOutput={onSelectOutput}
          onPageChange={vi.fn()}
        />,
      );
    });

    act(() => {
      renderer.root.findByType('select').props.onChange({ target: { value: 'run:1' } });
    });
    expect(onSelectOutput).toHaveBeenCalledWith('run:1');
    expect(textOf(renderer)).toContain('script_workbench.audit.truncated');
    expect(textOf(renderer)).toContain('script_workbench.results.outputs_truncated');
    expect(textOf(renderer)).toContain('script_workbench.logs.truncated');
    act(() => renderer.unmount());
  });

  it('renders the dedicated memory-limit result message', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptWorkbenchResults
          status="memory_exceeded"
          progress={null}
          result={{ success: false, memoryExceeded: true, durationMs: 1 }}
          outputs={[]}
          selectedOutputId={null}
          logs={[]}
          audits={[]}
          pageLoading={false}
          t={(key) => key}
          onSelectOutput={vi.fn()}
          onPageChange={vi.fn()}
        />,
      );
    });

    expect(textOf(renderer)).toContain('script_workbench.status.memory_exceeded');
    act(() => renderer.unmount());
  });

  it('renders an unknown outcome distinctly from a failed run', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptWorkbenchResults
          status="outcome_unknown"
          progress={null}
          result={{ success: false, outcomeUnknown: true, durationMs: 1 }}
          outputs={[]}
          selectedOutputId={null}
          logs={[]}
          audits={[]}
          pageLoading={false}
          t={(key) => key}
          onSelectOutput={vi.fn()}
          onPageChange={vi.fn()}
        />,
      );
    });

    expect(textOf(renderer)).toContain('script_workbench.error.outcome_unknown');
    expect(textOf(renderer)).toContain('script_workbench.status.outcome_unknown');
    act(() => renderer.unmount());
  });
});
