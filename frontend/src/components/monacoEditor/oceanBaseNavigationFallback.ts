import { useStore } from '../../store';

const stripSqlIdentifierQuotes = (value: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('`') && text.endsWith('`'))
    || (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('[') && text.endsWith(']'))) {
    return text.slice(1, -1).trim();
  }
  return text;
};

const splitSqlIdentifierPath = (raw: string): string[] => (
  String(raw || '')
    .split('.')
    .map(stripSqlIdentifierQuotes)
    .map((part) => part.trim())
    .filter(Boolean)
);

const resolveIdentifierWindowAtColumn = (
  lineContent: string,
  column: number,
): { start: number; end: number; text: string } | null => {
  const text = String(lineContent || '');
  if (!text) return null;
  const isIdentChar = (ch: string) => /[A-Za-z0-9_$`"\[\].]/.test(ch || '');
  let offset = Math.max(0, Math.min(text.length - 1, Number(column || 1) - 2));
  if (!isIdentChar(text[offset] || '')) {
    if (offset > 0 && isIdentChar(text[offset - 1] || '')) {
      offset -= 1;
    } else if (offset + 1 < text.length && isIdentChar(text[offset + 1] || '')) {
      offset += 1;
    } else {
      return null;
    }
  }
  let start = offset;
  while (start > 0 && isIdentChar(text[start - 1] || '')) start -= 1;
  let end = offset + 1;
  while (end < text.length && isIdentChar(text[end] || '')) end += 1;
  return start < end ? { start, end, text: text.slice(start, end).trim() } : null;
};

const isLikelyTableReferenceIdentifier = (
  lineContent: string,
  identifierStart: number,
): boolean => {
  const beforeIdentifier = String(lineContent || '').slice(0, Math.max(0, identifierStart));
  return /\b(?:from|join|update|into|delete\s+from|alter\s+table|drop\s+table|truncate\s+table)\s*$/i.test(beforeIdentifier);
};

const isOceanBaseOracleConnection = (connection: any): boolean => {
  const config = connection?.config || {};
  return String(config.type || '').trim().toLowerCase() === 'oceanbase'
    && String(config.oceanBaseProtocol || '').trim().toLowerCase() === 'oracle';
};

export const installOceanBaseOracleNavigationFallback = (editor: any) => {
  const editorDomNode = editor?.getDomNode?.();
  if (!editorDomNode || editor.__gonaviObOracleNavigationFallbackInstalled) {
    return;
  }
  Object.defineProperty(editor, '__gonaviObOracleNavigationFallbackInstalled', {
    value: true,
    configurable: true,
  });

  const handleMouseDownCapture = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }

    const store = useStore.getState();
    const activeTab = (store.tabs || []).find((tab: any) => tab.id === store.activeTabId);
    if (!activeTab || activeTab.type !== 'query') {
      return;
    }
    const connectionId = String(activeTab.connectionId || store.activeContext?.connectionId || '').trim();
    if (!connectionId) {
      return;
    }
    const connection = (store.connections || []).find((item: any) => item.id === connectionId);
    if (!isOceanBaseOracleConnection(connection)) {
      return;
    }

    const target = editor.getTargetAtClientPoint?.(event.clientX, event.clientY);
    const position = target?.position;
    if (!position) {
      return;
    }
    const model = editor.getModel?.();
    const lineContent = String(model?.getLineContent?.(position.lineNumber) || '');
    const identifier = resolveIdentifierWindowAtColumn(lineContent, position.column);
    if (!identifier || !identifier.text.includes('.')) {
      return;
    }
    if (!isLikelyTableReferenceIdentifier(lineContent, identifier.start)) {
      return;
    }

    const parts = splitSqlIdentifierPath(identifier.text);
    if (parts.length < 2) {
      return;
    }
    const schemaName = parts[parts.length - 2];
    const tableName = parts[parts.length - 1];
    if (!schemaName || !tableName) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    store.setActiveContext?.({ connectionId, dbName: schemaName });
    store.addTab?.({
      id: `${connectionId}-${schemaName}-table-${tableName}`,
      title: tableName,
      type: 'table',
      connectionId,
      dbName: schemaName,
      tableName,
      initialViewMode: 'fields',
      initialViewModeRequestId: String(Date.now()),
      objectType: 'table',
      returnToTabId: activeTab.id || undefined,
    });
  };

  editorDomNode.addEventListener('mousedown', handleMouseDownCapture, true);
  editor.onDidDispose?.(() => {
    editorDomNode.removeEventListener('mousedown', handleMouseDownCapture, true);
  });
};
