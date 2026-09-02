import { describe, expect, it } from 'vitest';
import type { ConnectionTag, SavedConnection } from '../types';
import {
  buildConnectionHealthGroups,
  getConnectionHealthGroupConnectionIds,
  normalizeConnectionHealthRun,
  normalizeConnectionHealthReports,
  serializeConnectionHealthReportExport,
} from './connectionHealth';

const connections: SavedConnection[] = [
  { id: 'one', name: 'One', config: { type: 'mysql', host: '', port: 0, user: '' } },
  { id: 'two', name: 'Two', config: { type: 'postgres', host: '', port: 0, user: '' } },
  { id: 'three', name: 'Three', config: { type: 'redis', host: '', port: 0, user: '' } },
];

const tags: ConnectionTag[] = [
  { id: 'parent', name: 'Production', connectionIds: ['one', 'unknown'] },
  { id: 'child', name: 'Analytics', parentTagId: 'parent', connectionIds: ['two', 'one'] },
  { id: 'other', name: 'Cache', connectionIds: ['three'] },
];

describe('connection health helpers', () => {
  it('collects nested group members without passing stale IDs to the backend', () => {
    expect(getConnectionHealthGroupConnectionIds(tags, 'parent', connections)).toEqual(['one', 'two']);
    expect(buildConnectionHealthGroups(tags, connections)).toEqual([
      { id: 'parent', name: 'Production', connectionIds: ['one', 'two'] },
      { id: 'child', name: 'Analytics', connectionIds: ['two', 'one'] },
      { id: 'other', name: 'Cache', connectionIds: ['three'] },
    ]);
  });

  it('keeps only the export-safe health fields', () => {
    const reports = normalizeConnectionHealthReports([{
      connectionId: 'one',
      connectionName: 'Production',
      connectionType: 'mysql',
      overallStatus: 'passed',
      durationMs: 18.2,
      password: 'must-not-leak',
      host: 'db.internal',
      checks: [{
        key: 'version',
        status: 'passed',
        durationMs: 3,
        detail: '8.4.1',
        rawResult: { database: 'orders_private' },
      }, {
        key: 'permissions',
        status: 'failed',
        recommendation: 'grant_metadata_read',
        detail: 'password=must-not-leak',
      }, {
        key: 'response',
        status: 'failed',
        recommendation: 'password=must-not-leak',
      }],
    }]);
    const exported = serializeConnectionHealthReportExport(reports, '2026-08-18T00:00:00.000Z');
    const parsed = JSON.parse(exported) as Record<string, unknown>;

    expect(parsed).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00.000Z',
      reports: [{
        connectionType: 'mysql',
        overallStatus: 'passed',
        durationMs: 18,
        checks: [{ key: 'version', status: 'passed', durationMs: 3, detail: '8.4.1' }, {
          key: 'permissions', status: 'failed', durationMs: 0, recommendation: 'grant_metadata_read',
        }, {
          key: 'response', status: 'failed', durationMs: 0,
        }],
      }],
    });
    expect(exported).not.toContain('must-not-leak');
    expect(exported).not.toContain('db.internal');
    expect(exported).not.toContain('orders_private');
    expect(exported).not.toContain('Production');
    expect(exported).not.toContain('"connectionId"');
  });

  it('normalizes incremental run progress and rejects malformed terminal state', () => {
    expect(normalizeConnectionHealthRun({
      runId: 'health-run-1',
      status: 'cancelled',
      total: 3,
      completed: 1,
      cancelRequested: true,
      currentConnectionId: 'must-not-survive',
      remainingConnectionIds: ['two', 'two', ' three '],
      reports: [{
        connectionId: 'one',
        overallStatus: 'passed',
        durationMs: 4,
        checks: [],
      }],
    })).toEqual({
      runId: 'health-run-1',
      status: 'cancelled',
      total: 3,
      completed: 1,
      cancelRequested: true,
      currentConnectionId: 'must-not-survive',
      remainingConnectionIds: ['two', 'three'],
      reports: [{
        connectionId: 'one',
        overallStatus: 'passed',
        durationMs: 4,
        checks: [],
      }],
    });
    expect(normalizeConnectionHealthRun({
      runId: 'invalid',
      status: 'completed',
      total: 1,
      completed: 2,
    })).toBeNull();
  });
});
