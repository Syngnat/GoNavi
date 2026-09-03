export const SIDEBAR_SQL_EDITOR_DRAG_MIME = 'application/x-gonavi-sql-object';

export interface SidebarSqlEditorDragPayload {
  text: string;
  nodeType?: string;
  connectionId?: string;
  dbName?: string;
}

export const encodeSidebarSqlEditorDragPayload = (payload: SidebarSqlEditorDragPayload): string =>
  JSON.stringify({
    text: String(payload.text || '').trim(),
    nodeType: payload.nodeType ? String(payload.nodeType) : undefined,
    connectionId: payload.connectionId ? String(payload.connectionId) : undefined,
    // An explicitly empty database identifies connection-scoped sources such
    // as SQLite. Preserve that distinction from an omitted field.
    dbName: payload.dbName !== undefined ? String(payload.dbName) : undefined,
  });

export const hasSidebarSqlEditorDragPayload = (dataTransfer: Pick<DataTransfer, 'types'> | null | undefined): boolean => {
  const rawTypes = dataTransfer?.types;
  if (!rawTypes) return false;
  const types = Array.from(rawTypes as any).map((type) => String(type || '').toLowerCase());
  return types.includes(SIDEBAR_SQL_EDITOR_DRAG_MIME);
};

export const decodeSidebarSqlEditorDragPayload = (value: string): SidebarSqlEditorDragPayload | null => {
  try {
    const parsed = JSON.parse(String(value || '')) as SidebarSqlEditorDragPayload;
    const text = String(parsed?.text || '').trim();
    if (!text) return null;
    return {
      text,
      nodeType: parsed?.nodeType ? String(parsed.nodeType) : undefined,
      connectionId: parsed?.connectionId ? String(parsed.connectionId) : undefined,
      dbName: parsed?.dbName !== undefined ? String(parsed.dbName) : undefined,
    };
  } catch {
    return null;
  }
};
