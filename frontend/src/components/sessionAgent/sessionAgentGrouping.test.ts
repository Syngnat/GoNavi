import { describe, expect, it } from 'vitest';
import { buildSessionGroups, dayLabel, projectGroupStamp, sessionGroupKey, sortSessionItems } from './SessionAgentListPage';

// 「按项目分组」必须真的看得出是分组：同一项目的会话相邻，且组内只有
// 首行带项目名。

const item = (overrides: Record<string, unknown>) => ({
  providerId: 'codex',
  sessionId: 's',
  title: 't',
  summary: '',
  firstMessage: '',
  projectDir: '',
  createdAt: 0,
  lastActiveAt: 0,
  sourcePath: '/x.jsonl',
  resumeCommand: 'codex resume s',
  ...overrides,
});

describe('sortSessionItems', () => {
  it('groups sessions of the same project together', () => {
    const items = [
      item({ sessionId: 'a1', projectDir: 'E:/beta', lastActiveAt: 300 }),
      item({ sessionId: 'a2', projectDir: 'E:/alpha', lastActiveAt: 200 }),
      item({ sessionId: 'a3', projectDir: 'E:/beta', lastActiveAt: 100 }),
    ];
    const sorted = sortSessionItems(items, 'project');
    expect(sorted.map((i) => i.sessionId)).toEqual(['a2', 'a1', 'a3']);
  });

  it('sorts by last activity when grouping by time', () => {
    const items = [
      item({ sessionId: 'a1', lastActiveAt: 100 }),
      item({ sessionId: 'a2', lastActiveAt: 300 }),
      item({ sessionId: 'a3', lastActiveAt: 200 }),
    ];
    expect(sortSessionItems(items, 'time').map((i) => i.sessionId)).toEqual(['a2', 'a3', 'a1']);
  });
});

describe('sessionGroupKey', () => {
  it('uses the project name in project mode', () => {
    expect(sessionGroupKey(item({ projectDir: 'E:/work/demo' }), 'project')).toBe('demo');
  });

  it('buckets today and yesterday, then one key per concrete day', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    expect(sessionGroupKey(item({ lastActiveAt: today + 1000 }), 'time')).toBe('today');
    expect(sessionGroupKey(item({ lastActiveAt: today - 86400000 + 1000 }), 'time')).toBe('yesterday');
    // 更早的不再塞进「本周/更早」这类模糊桶：一天一个键。
    const monthAgo = sessionGroupKey(item({ lastActiveAt: today - 30 * 86400000 }), 'time');
    expect(monthAgo).toMatch(/^day-\d+$/);
    expect(monthAgo).not.toBe(sessionGroupKey(item({ lastActiveAt: today - 34 * 86400000 }), 'time'));
  });
});

describe('buildSessionGroups', () => {
  it('gives every project its own group with the project name as the group label', () => {
    const groups = buildSessionGroups([
      item({ sessionId: 'a1', projectDir: 'E:/work/alpha', lastActiveAt: 300 }),
      item({ sessionId: 'b1', projectDir: 'E:/work/beta', lastActiveAt: 200 }),
      item({ sessionId: 'a2', projectDir: 'E:/work/alpha', lastActiveAt: 100 }),
    ], 'project');
    expect(groups.map((group) => group.label)).toEqual(['alpha', 'beta']);
    expect(groups.map((group) => group.key)).toEqual(['alpha', 'beta']);
    // 同一项目的会话必须落在同一组里（卡片排在组头下面）。
    expect(groups[0].items.map((i) => i.sessionId)).toEqual(['a1', 'a2']);
    expect(groups[1].items.map((i) => i.sessionId)).toEqual(['b1']);
  });

  it('labels non-today time groups with the concrete date', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthAgo = today - 30 * 86400000;
    const groups = buildSessionGroups([
      item({ sessionId: 't1', lastActiveAt: today + 1000 }),
      item({ sessionId: 'o1', lastActiveAt: monthAgo }),
    ], 'time');
    expect(groups.map((group) => group.key)).toEqual([
      'today',
      sessionGroupKey(item({ lastActiveAt: monthAgo }), 'time'),
    ]);
    expect(groups.map((group) => group.items.length)).toEqual([1, 1]);
    // 具体日期标签来自 dayLabel，用户能对上日历。
    expect(groups[1].label).toBe(dayLabel(monthAgo));
  });
});

describe('projectGroupStamp', () => {
  it('shows the first session time when the whole project group is from today', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const items = [
      item({ lastActiveAt: today + 10800000, createdAt: today + 5400000 }),
      item({ lastActiveAt: today + 7200000, createdAt: today + 3600000 }),
    ];
    expect(projectGroupStamp(items)).toBe(
      new Date(today + 3600000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('shows the concrete date when the project was last active before today', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthAgo = today - 30 * 86400000;
    expect(projectGroupStamp([item({ lastActiveAt: monthAgo, createdAt: monthAgo })])).toBe(dayLabel(monthAgo));
  });
});
