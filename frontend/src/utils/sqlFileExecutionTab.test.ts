import { describe, expect, it } from 'vitest';

import {
  buildSQLFileExecutionWorkbenchTab,
  resolveSQLFileExecutionWorkbenchTabId,
} from './sqlFileExecutionTab';

describe('sqlFileExecutionTab', () => {
  it('builds stable workbench ids by connection, database, and normalized file path', () => {
    expect(resolveSQLFileExecutionWorkbenchTabId('conn-1', 'demo', 'D:\\sql\\seed.sql')).toBe(
      'sql-file-execution-conn-1-demo-D:/sql/seed.sql',
    );
  });

  it('builds sql file execution workbench tabs with execution metadata', () => {
    const tab = buildSQLFileExecutionWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'demo',
      filePath: 'D:\\sql\\seed.sql',
      fileName: 'seed.sql',
      fileSizeMB: '512.5',
      requestKey: 'job-1',
    });

    expect(tab).toEqual(expect.objectContaining({
      id: 'sql-file-execution-conn-1-demo-D:/sql/seed.sql',
      title: 'seed.sql',
      type: 'sql-file-execution',
      connectionId: 'conn-1',
      dbName: 'demo',
      filePath: 'D:/sql/seed.sql',
      sqlFileExecutionFileName: 'seed.sql',
      sqlFileExecutionFileSizeMB: '512.5',
      sqlFileExecutionRequestKey: 'job-1',
    }));
  });

  it('opens completed backup artifacts without automatically executing them', () => {
    const tab = buildSQLFileExecutionWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'demo',
      filePath: '/tmp/demo_backup.sql',
      fileName: 'demo_backup.sql',
      autoStart: false,
    });

    expect(tab.sqlFileExecutionRequestKey).toBeUndefined();
    expect(tab.filePath).toBe('/tmp/demo_backup.sql');
  });
});
