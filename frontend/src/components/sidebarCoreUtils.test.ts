import { describe, expect, it } from 'vitest';

import {
  isV2SidebarObjectNode,
  isPostgresSchemaDialect,
  normalizeDriverType,
  normalizeMySQLViewDDLForEditing,
  resolveSidebarContextMenuPosition,
  resolveSidebarObjectDragText,
} from './sidebarCoreUtils';

describe('sidebarCoreUtils', () => {
  it('keeps context menus inside the viewport', () => {
    expect(resolveSidebarContextMenuPosition(790, 590, {
      viewportWidth: 800,
      viewportHeight: 600,
      width: 240,
      height: 300,
      safeGap: 10,
    })).toEqual({
      x: 550,
      y: 290,
      maxHeight: 300,
    });
  });

  it('normalizes MySQL view definitions for editor updates', () => {
    expect(normalizeMySQLViewDDLForEditing('v_users', 'select * from users')).toBe(
      'CREATE OR REPLACE VIEW v_users AS\nselect * from users;',
    );
    expect(normalizeMySQLViewDDLForEditing(
      'v_users',
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_users` AS select 1;',
    )).toBe('CREATE OR REPLACE VIEW `v_users` AS select 1;');
    expect(normalizeMySQLViewDDLForEditing('v_users', '')).toBe('');
  });

  it('normalizes driver aliases used by sidebar metadata loaders', () => {
    expect(normalizeDriverType('postgresql')).toBe('postgres');
    expect(normalizeDriverType('open-gauss')).toBe('opengauss');
    expect(normalizeDriverType('gauss-db')).toBe('gaussdb');
    expect(normalizeDriverType('InterSystemsIRIS')).toBe('iris');
    expect(isPostgresSchemaDialect('kingbase')).toBe(true);
    expect(isPostgresSchemaDialect('gauss-db')).toBe(true);
  });

  it('resolves draggable object labels by object kind', () => {
    expect(resolveSidebarObjectDragText({
      type: 'table',
      title: 'fallback_table',
      dataRef: { tableName: 'users' },
    })).toBe('users');
    expect(resolveSidebarObjectDragText({
      type: 'view',
      title: 'fallback_view',
      dataRef: { viewName: 'v_users' },
    })).toBe('v_users');
    expect(resolveSidebarObjectDragText({
      type: 'db-trigger',
      title: 'trg_users_audit',
      dataRef: {},
    })).toBe('trg_users_audit');
    expect(resolveSidebarObjectDragText({
      type: 'sequence',
      title: 'SEQ_PERSON_ID',
      dataRef: { sequenceName: 'MYCIMLED.SEQ_PERSON_ID' },
    })).toBe('MYCIMLED.SEQ_PERSON_ID');
    expect(resolveSidebarObjectDragText({
      type: 'package',
      title: 'PKG_PERSON',
      dataRef: { packageName: 'MYCIMLED.PKG_PERSON' },
    })).toBe('MYCIMLED.PKG_PERSON');
    expect(resolveSidebarObjectDragText({
      type: 'message-object',
      title: 'display topic',
      dataRef: { messageObjectName: 'devices/+/telemetry' },
    })).toBe('devices/+/telemetry');
    expect(isV2SidebarObjectNode({ type: 'message-object' })).toBe(true);
  });
});
