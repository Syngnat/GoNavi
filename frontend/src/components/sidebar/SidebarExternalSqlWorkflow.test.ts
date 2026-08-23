import { describe, expect, it, vi } from 'vitest';

import { launchDatabaseSQLImportWorkbench } from './SidebarExternalSqlWorkflow';

describe('SidebarExternalSqlWorkflow database SQL import entry', () => {
  it('opens the unified database import workbench without selecting a file', () => {
    const openDataImportWorkbench = vi.fn();

    const launched = launchDatabaseSQLImportWorkbench({
      type: 'database',
      title: 'app',
      dataRef: { id: 'mysql-1', dbName: 'app' },
    }, openDataImportWorkbench);

    expect(launched).toBe(true);
    expect(openDataImportWorkbench).toHaveBeenCalledOnce();
    expect(openDataImportWorkbench).toHaveBeenCalledWith({
      connectionId: 'mysql-1',
      dbName: 'app',
      mode: 'database',
    });
  });
});
