import { describe, expect, it } from 'vitest';
import {
  buildLockWaitTree,
  dropImpliedLockWaits,
  isIdleLockHolder,
  normalizeLockWaitPayload,
  type DatabaseLockWait,
  type LockWaitTreeRow,
} from './lockWaitModel';

const edge = (
  waiting: string,
  blocking: string,
  extra: Partial<DatabaseLockWait> = {},
): DatabaseLockWait => ({
  key: `${waiting}<-${blocking}:${extra.lockType ?? ''}`,
  waitingSessionId: waiting,
  blockingSessionId: blocking,
  ...extra,
});

const shape = (rows: LockWaitTreeRow[] | undefined): unknown[] => (rows ?? []).map((row) => (
  row.children
    ? { [row.session.sessionId ?? '']: shape(row.children) }
    : row.session.sessionId
));

describe('normalizeLockWaitPayload', () => {
  it('keeps edges that can be acted on and parses numeric strings', () => {
    const payload = normalizeLockWaitPayload({
      engine: 'mysql',
      capability: { supported: true },
      waits: [
        { key: 'a', waitingSessionId: '12', blockingSessionId: '9', waitDurationMs: '7000', objectName: 'shop.orders' },
        { key: 'b', waitingSessionId: '', blockingSessionId: '9' },
      ],
      scopedDatabase: 'shop',
    });
    expect(payload.capability).toEqual({ supported: true, reasonCode: undefined });
    expect(payload.waits).toHaveLength(1);
    expect(payload.waits[0]).toMatchObject({ waitingSessionId: '12', waitDurationMs: 7000, objectName: 'shop.orders' });
    expect(payload.scopedDatabase).toBe('shop');
  });

  it('degrades a missing payload to an unsupported, empty state', () => {
    expect(normalizeLockWaitPayload(undefined)).toEqual({
      engine: '',
      capability: { supported: false, reasonCode: undefined },
      waits: [],
      scopedDatabase: '',
    });
  });
});

describe('buildLockWaitTree', () => {
  it('puts the session that blocks without waiting at the root of its chain', () => {
    // 10 holds the row; 11 waits for it; ALTER (12) waits for both.
    const tree = buildLockWaitTree([
      edge('11', '10', { waitDurationMs: 9000, blockingState: 'Sleep', blockingDurationMs: 60000 }),
      edge('12', '10', { waitDurationMs: 4000, blockingState: 'Sleep', blockingDurationMs: 60000 }),
      edge('12', '11', { waitDurationMs: 4000 }),
    ]);
    // 12 ← 10 is implied by 12 ← 11 ← 10, so 12 sits only at the end of the chain.
    expect(shape(tree.rows)).toEqual([{ 10: [{ 11: ['12'] }] }]);
    const [root] = tree.rows;
    expect(root.role).toBe('root');
    expect(root.blockedCount).toBe(2);
    expect(root.durationMs).toBe(60000);
    expect(root.idleHolder).toBe(true);
    expect(root.children?.[0].blockedCount).toBe(1);
    expect(tree.summary).toEqual({ waitingSessions: 2, rootBlockers: 1, longestWaitMs: 9000, hasCycle: false });
    expect(tree.expandableKeys).toEqual(expect.arrayContaining([root.key, root.children?.[0].key]));
  });

  it('orders independent chains by how many sessions they hold up', () => {
    const tree = buildLockWaitTree([
      edge('2', '1'),
      edge('5', '4'),
      edge('6', '4'),
    ]);
    expect(tree.rows.map((row) => row.session.sessionId)).toEqual(['4', '1']);
    expect(tree.summary.rootBlockers).toBe(2);
  });

  it('keeps one edge per waiter under a blocker, preferring the longest wait', () => {
    const tree = buildLockWaitTree([
      edge('2', '1', { lockType: 'RECORD', waitDurationMs: 100 }),
      edge('2', '1', { lockType: 'METADATA', waitDurationMs: 900 }),
    ]);
    expect(tree.rows[0].children).toHaveLength(1);
    expect(tree.rows[0].children?.[0].wait?.lockType).toBe('METADATA');
  });

  it('surfaces circular waits instead of dropping them', () => {
    const tree = buildLockWaitTree([edge('1', '2'), edge('2', '1')]);
    expect(tree.summary.hasCycle).toBe(true);
    expect(tree.rows).toHaveLength(1);
    const [root] = tree.rows;
    expect(root.cycle).toBe(true);
    const back = root.children?.[0].children?.[0];
    expect(back?.session.sessionId).toBe(root.session.sessionId);
    expect(back?.cycle).toBe(true);
    expect(back?.children).toBeUndefined();
  });

  it('keeps RAC sessions with the same SID on different instances apart', () => {
    const tree = buildLockWaitTree([
      edge('120', '120', { waitingInstanceId: '1', blockingInstanceId: '2', blockingSerialNumber: '44' }),
    ]);
    expect(tree.rows).toHaveLength(1);
    expect(tree.rows[0].session).toMatchObject({ sessionId: '120', instanceId: '2', serialNumber: '44' });
    expect(tree.rows[0].children?.[0].session).toMatchObject({ sessionId: '120', instanceId: '1' });
  });
});

describe('dropImpliedLockWaits', () => {
  it('turns a metadata-lock queue into one chain', () => {
    // Captured from MySQL 8.4: idle holder 9, UPDATE 10 on its row, ALTER 11
    // and SELECT 12 queued on the table's metadata lock behind every holder.
    const tree = buildLockWaitTree([
      edge('10', '9', { lockType: 'RECORD' }),
      edge('11', '9', { lockType: 'METADATA' }),
      edge('11', '10', { lockType: 'METADATA' }),
      edge('12', '9', { lockType: 'METADATA' }),
      edge('12', '10', { lockType: 'METADATA' }),
      edge('12', '11', { lockType: 'METADATA' }),
    ]);
    expect(shape(tree.rows)).toEqual([{ 9: [{ 10: [{ 11: ['12'] }] }] }]);
    expect(tree.rows[0].blockedCount).toBe(3);
    expect(tree.summary.waitingSessions).toBe(3);
  });

  it('keeps independent holders of a shared lock side by side', () => {
    const waits = [edge('3', '1'), edge('3', '2')];
    expect(dropImpliedLockWaits(waits)).toEqual(waits);
  });

  it('never leaves a waiter without an edge when its blockers wait on each other', () => {
    const waits = [
      edge('1', '2'),
      edge('2', '1'),
      edge('3', '1', { waitDurationMs: 100 }),
      edge('3', '2', { waitDurationMs: 900 }),
    ];
    const kept = dropImpliedLockWaits(waits);
    expect(kept.filter((wait) => wait.waitingSessionId === '3')).toHaveLength(1);
    expect(kept.find((wait) => wait.waitingSessionId === '3')?.blockingSessionId).toBe('2');
  });
});

describe('isIdleLockHolder', () => {
  it('recognizes idle transactions across engines', () => {
    expect(isIdleLockHolder('Sleep')).toBe(true);
    expect(isIdleLockHolder('idle in transaction')).toBe(true);
    expect(isIdleLockHolder('INACTIVE')).toBe(true);
    expect(isIdleLockHolder('sleeping')).toBe(true);
    expect(isIdleLockHolder('Query')).toBe(false);
    expect(isIdleLockHolder('active')).toBe(false);
  });
});
