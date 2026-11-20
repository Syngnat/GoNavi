import { describe, expect, it } from 'vitest';
import {
  initialScriptRunSessionState,
  scriptRunSessionReducer,
} from './scriptRunSessionState';
import type { ScriptOutputPage } from './scriptWorkbenchTypes';

const output = (outputId: string, name: string, page = 1): ScriptOutputPage => ({
  outputId,
  name,
  columns: ['value'],
  rows: [{ value: page }],
  page,
  pageSize: 100,
  totalRows: 2,
});

describe('script run session reducer', () => {
  it('keeps multiple output streams and lets the user select one', () => {
    let state = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'output',
      output: output('run-1:0', 'first'),
    });
    state = scriptRunSessionReducer(state, {
      type: 'output',
      output: output('run-1:1', 'second'),
    });
    state = scriptRunSessionReducer(state, { type: 'select-output', outputId: 'run-1:1' });
    state = scriptRunSessionReducer(state, {
      type: 'output',
      output: output('run-1:1', 'second', 2),
    });

    expect(state.outputs).toHaveLength(2);
    expect(state.selectedOutputId).toBe('run-1:1');
    expect(state.outputs[1].page).toBe(2);
  });

  it('does not let late progress overwrite the cancelling state', () => {
    const cancelling = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'cancelling',
    });
    const next = scriptRunSessionReducer(cancelling, {
      type: 'event',
      event: {
        type: 'progress',
        progress: { current: 1, total: 2, startedAt: 1, elapsedMs: 1 },
      },
    });

    expect(next.status).toBe('cancelling');
  });

  it('maps timeout, memory limits, and truncated audits to terminal state', () => {
    const timedOut = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'event',
      event: {
        type: 'result',
        result: { success: false, timedOut: true, durationMs: 100 },
      },
    });
    const memoryExceeded = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'event',
      event: {
        type: 'result',
        result: { success: false, memoryExceeded: true, durationMs: 100 },
      },
    });
    const withTruncatedAudit = scriptRunSessionReducer(memoryExceeded, {
      type: 'event',
      event: {
        type: 'result',
        result: {
          success: false,
          memoryExceeded: true,
          auditsTruncated: true,
          durationMs: 100,
        },
      },
    });

    expect(timedOut.status).toBe('timed_out');
    expect(memoryExceeded.status).toBe('memory_exceeded');
    expect(withTruncatedAudit.auditsTruncated).toBe(true);
  });

  it('keeps historical columns and caps output/log retention explicitly', () => {
    let state = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'output',
      output: output('run-1:0', 'first'),
    });
    state = scriptRunSessionReducer(state, {
      type: 'output',
      output: {
        ...output('run-1:0', 'first', 2),
        columns: ['value', 'created_at'],
        rows: [{ value: 2, created_at: '2026-01-01' }],
      },
    });
    expect(state.outputs[0].columns).toEqual(['value', 'created_at']);

    for (let index = 0; index < 33; index += 1) {
      state = scriptRunSessionReducer(state, {
        type: 'output',
        output: output(`run-2:${index}`, `output-${index}`),
      });
    }
    expect(state.outputs).toHaveLength(32);
    expect(state.outputsTruncated).toBe(true);

    for (let index = 0; index < 501; index += 1) {
      state = scriptRunSessionReducer(state, {
        type: 'event',
        event: {
          type: 'log',
          log: {
            id: `log-${index}`,
            at: index,
            level: 'info',
            message: `line-${index}`,
          },
        },
      });
    }
    expect(state.logs).toHaveLength(500);
    expect(state.logsTruncated).toBe(true);
  });

  it('maps an unknown outcome separately from a failed run', () => {
    const state = scriptRunSessionReducer(initialScriptRunSessionState, {
      type: 'event',
      event: {
        type: 'result',
        result: {
          success: false,
          outcomeUnknown: true,
          durationMs: 100,
        },
      },
    });
    expect(state.status).toBe('outcome_unknown');
  });
});
