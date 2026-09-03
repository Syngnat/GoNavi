import { describe, expect, it } from 'vitest';

import {
  decodeSidebarSqlEditorDragPayload,
  encodeSidebarSqlEditorDragPayload,
} from './sidebarSqlDrag';

describe('sidebarSqlDrag', () => {
  it('preserves an explicitly empty database for connection-scoped sources', () => {
    const decoded = decodeSidebarSqlEditorDragPayload(encodeSidebarSqlEditorDragPayload({
      text: 'users',
      nodeType: 'table',
      connectionId: 'conn-1',
      dbName: '',
    }));

    expect(decoded).toEqual({
      text: 'users',
      nodeType: 'table',
      connectionId: 'conn-1',
      dbName: '',
    });
  });
});
