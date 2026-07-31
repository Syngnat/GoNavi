import { describe, expect, it, vi } from 'vitest';
import { buildSidebarLegacyNodeMenuItems } from './sidebar/sidebarLegacyNodeMenu';

describe('Sidebar legacy database menu order', () => {

  it('routes copy database name through the shared database action handler', () => {
    const handleV2DatabaseContextMenuAction = vi.fn();
    const node = {
      type: 'database',
      title: 'main_db',
      dataRef: { id: 'mysql-1', dbName: 'main_db', config: { type: 'mysql' } },
    };
    const items = buildSidebarLegacyNodeMenuItems(node, {
      getMetadataDialect: () => 'mysql',
      isPostgresSchemaDialect: () => false,
      shouldHideSchemaPrefix: () => false,
      isStructureOnlyDbType: () => false,
      handleV2DatabaseContextMenuAction,
    }) as Array<{ key?: string; onClick?: () => void }>;

    const copyItem = items.find((item) => item?.key === 'copy-database-name');
    expect(copyItem).toBeTruthy();

    copyItem?.onClick?.();

    expect(handleV2DatabaseContextMenuAction).toHaveBeenCalledWith(node, 'copy-database-name');
  });
});
