import { describe, expect, it, vi } from 'vitest';

import { executeSnapshotInspectionToolCall } from './aiSnapshotInspectionToolExecutor';

const translate = (key: string, params?: Record<string, unknown>) => {
  const messages: Record<string, string> = {
    'ai_chat.inspection.diagnostics.error.read_app_logs_failed': `APP_FAILED :: ${params?.detail}`,
    'ai_chat.inspection.diagnostics.error.read_ai_upstream_logs_failed': `UPSTREAM_FAILED :: ${params?.detail}`,
    'ai_chat.inspection.diagnostics.error.read_recent_connection_failures_failed': `RECENT_FAILED :: ${params?.detail}`,
    'ai_chat.inspection.snapshot.error.inspect_saved_connections': `SAVED_FAILED :: ${params?.detail}`,
  };
  return messages[key] || key;
};

const execute = (toolName: string) =>
  executeSnapshotInspectionToolCall({
    toolName,
    args: {},
    connections: [],
    mcpTools: [],
    translate,
    runtime: {
      readAppLogTail: vi.fn().mockRejectedValue(new Error('raw log read failure')),
    },
  });

describe('aiSnapshotInspectionToolExecutor diagnostics i18n fallback', () => {
  it('localizes diagnostics log-read exception wrappers while preserving raw detail', async () => {
    await expect(execute('inspect_app_logs')).resolves.toMatchObject({
      success: false,
      content: 'APP_FAILED :: raw log read failure',
    });
    await expect(execute('inspect_ai_upstream_logs')).resolves.toMatchObject({
      success: false,
      content: 'UPSTREAM_FAILED :: raw log read failure',
    });
    await expect(execute('inspect_recent_connection_failures')).resolves.toMatchObject({
      success: false,
      content: 'RECENT_FAILED :: raw log read failure',
    });
  });

  it('localizes generic local inspection exception wrappers while preserving raw detail', async () => {
    const result = await executeSnapshotInspectionToolCall({
      toolName: 'inspect_saved_connections',
      args: {},
      connections: null as any,
      mcpTools: [],
      translate,
    });

    expect(result).toMatchObject({
      success: false,
      content: expect.stringContaining('SAVED_FAILED ::'),
    });
    expect(result?.content).toContain('Cannot read');
  });
});
