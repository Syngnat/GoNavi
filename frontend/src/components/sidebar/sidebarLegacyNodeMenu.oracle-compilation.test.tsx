import { describe, expect, it, vi } from 'vitest';

import { buildSidebarLegacyNodeMenuItems } from './sidebarLegacyNodeMenu';

const findMenuItem = (items: any, key: string) => (
  (Array.isArray(items) ? items : []).find((item) => item?.key === key)
);

describe('Oracle object compilation sidebar actions', () => {
  it('exposes compile actions for Oracle routines and triggers only', () => {
    const handleCompileOracleObject = vi.fn();
    const context = {
      getMetadataDialect: () => 'oracle',
      openRoutineDefinition: vi.fn(),
      openEditRoutine: vi.fn(),
      handleDropRoutine: vi.fn(),
      handleCompileOracleObject,
    };
    const routineNode = {
      type: 'routine',
      dataRef: {
        config: { type: 'oracle' },
        routineName: 'APP.P_REBUILD',
        routineType: 'PROCEDURE',
      },
    };
    const triggerNode = {
      type: 'db-trigger',
      dataRef: {
        config: { type: 'oracle' },
        triggerName: 'TRG_AUDIT',
        triggerTableName: 'ORDERS',
      },
    };

    const routineAction = findMenuItem(
      buildSidebarLegacyNodeMenuItems(routineNode, context),
      'compile-oracle-object',
    );
    const triggerAction = findMenuItem(
      buildSidebarLegacyNodeMenuItems(triggerNode, context),
      'compile-oracle-object',
    );

    expect(routineAction).toBeDefined();
    expect(triggerAction).toBeDefined();
    routineAction.onClick();
    triggerAction.onClick();
    expect(handleCompileOracleObject).toHaveBeenNthCalledWith(1, routineNode);
    expect(handleCompileOracleObject).toHaveBeenNthCalledWith(2, triggerNode);

    const mysqlItems = buildSidebarLegacyNodeMenuItems(
      { ...routineNode, dataRef: { ...routineNode.dataRef, config: { type: 'mysql' } } },
      { ...context, getMetadataDialect: () => 'mysql' },
    );
    expect(findMenuItem(mysqlItems, 'compile-oracle-object')).toBeUndefined();
  });
});
