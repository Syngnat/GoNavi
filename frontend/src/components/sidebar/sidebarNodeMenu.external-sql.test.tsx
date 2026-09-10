import { describe, expect, it, vi } from 'vitest';

import { buildSidebarNodeMenuItems } from './sidebarNodeMenu';

describe('external SQL file context menu', () => {
  it('opens the persisted database binding workflow from the shared node menu', () => {
    const openExternalSQLFile = vi.fn();
    const openExternalSQLBindingModal = vi.fn();
    const items = buildSidebarNodeMenuItems({
      type: 'external-sql-file',
      title: 'report.sql',
      dataRef: {
        path: 'D:/sql/report.sql',
        directoryId: 'dir-1',
      },
    }, {
      openExternalSQLFile,
      openExternalSQLBindingModal,
      openRenameExternalSQLFileModal: vi.fn(),
      openCreateExternalSQLFileModal: vi.fn(),
      openCreateExternalSQLDirectoryModal: vi.fn(),
      handleDeleteExternalSQLFile: vi.fn(),
    }) as any[];

    expect(items.map((item) => item?.key)).toContain('bind-external-sql-file-database');
    items.find((item) => item?.key === 'bind-external-sql-file-database')?.onClick?.();
    expect(openExternalSQLBindingModal).toHaveBeenCalledWith(expect.objectContaining({
      type: 'external-sql-file',
    }));
    expect(openExternalSQLFile).not.toHaveBeenCalled();
  });
});
