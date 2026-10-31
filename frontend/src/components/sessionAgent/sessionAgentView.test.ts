import { describe, expect, it } from 'vitest';
import type { SessionMessageView, SessionTurnView } from './sessionAgentApi';
import { buildSessionChanges, sessionChangeMatches, sessionTurnMatches, turnFileCount } from './sessionAgentView';

const messages: SessionMessageView[] = [
  { role: 'user', content: '完成 CLI 修复', ts: 1 },
  {
    role: 'assistant',
    content: '已修复 **退出码**。',
    ts: 2,
    blocks: [
      {
        type: 'tool_call',
        toolCall: {
          id: 'call-1', rawName: 'apply_patch', kind: 'patch', title: '修改 main.go',
          inputPreview: '*** Begin Patch\n+os.Exit(1)',
          inputFull: { kind: 'jsonl', pointer: '/patch/1' },
          diff: { files: [{ path: 'cmd/main.go', op: 'update', added: 3, removed: 1 }], added: 3, removed: 1 },
        },
      },
      { type: 'tool_result', toolResult: { callId: 'call-1', status: 'success', preview: 'ok' } },
      {
        type: 'tool_call',
        toolCall: {
          id: 'call-2', rawName: 'apply_patch', kind: 'patch', title: '继续修改',
          inputPreview: '*** Begin Patch\n+println(version)',
          diff: {
            files: [
              { path: 'cmd/main.go', op: 'update', added: 2, removed: 0 },
              { path: 'cmd/version.go', op: 'add', added: 8, removed: 0 },
            ],
            added: 10,
            removed: 0,
          },
        },
      },
    ],
  },
];

const turn: SessionTurnView = {
  turnId: 'turn-1', firstMessageIndex: 0, lastMessageIndex: 1, questionPreview: '完成 CLI 修复',
  ts: 1, stepCount: 2, errorCount: 0, hasFinalReply: true, aborted: false,
};

describe('sessionAgentView', () => {
  it('aggregates repeated patches by file and retains original patch references', () => {
    const changes = buildSessionChanges(messages);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ path: 'cmd/main.go', added: 5, removed: 1 });
    expect(changes[0].patches).toHaveLength(2);
    expect(changes[0].patches[0].inputFull).toEqual({ kind: 'jsonl', pointer: '/patch/1' });
    expect(changes[1]).toMatchObject({ path: 'cmd/version.go', op: 'add', added: 8 });
    expect(turnFileCount(messages)).toBe(2);
  });

  it('matches turns by tool input without changing the rendered message content', () => {
    expect(sessionTurnMatches(turn, messages, 'os.exit')).toBe(true);
    expect(sessionTurnMatches(turn, messages, 'version')).toBe(true);
    expect(sessionTurnMatches(turn, messages, '不存在的内容')).toBe(false);
    expect(messages[1].content).toBe('已修复 **退出码**。');
  });

  it('filters aggregated changes by path and patch content', () => {
    const changes = buildSessionChanges(messages);
    expect(sessionChangeMatches(changes[0], 'main.go')).toBe(true);
    expect(sessionChangeMatches(changes[0], 'println')).toBe(true);
    expect(sessionChangeMatches(changes[1], 'println')).toBe(true);
    expect(sessionChangeMatches(changes[1], 'os.exit')).toBe(false);
  });
});
