import {
  type ShortcutPlatform,
  localizeShortcut,
  type ShortcutAction,
  SHORTCUT_ACTION_META,
} from './shortcutDefinitions';

export type ConflictContext = 'global' | 'monaco' | 'datagrid';

export interface ReservedShortcut {
  combo: string;
  label: string;
  context: ConflictContext;
  monacoCommandId?: string;
  platforms?: ShortcutPlatform[];
}

interface ReservedShortcutDefinition extends Omit<ReservedShortcut, 'label'> {
  labelKey: string;
}

export interface ConflictInfo {
  label: string;
  context: ConflictContext;
  monacoCommandId?: string;
}

const RESERVED_SHORTCUT_DEFINITIONS: ReservedShortcutDefinition[] = [
  // Browser / WebView built-in shortcuts
  { combo: 'Ctrl+S',           labelKey: 'app.shortcuts.reserved.browser_save',                 context: 'global' },
  { combo: 'Ctrl+P',           labelKey: 'app.shortcuts.reserved.browser_print',                context: 'global' },
  { combo: 'Ctrl+T',           labelKey: 'app.shortcuts.reserved.browser_new_tab',              context: 'global' },
  { combo: 'Ctrl+N',           labelKey: 'app.shortcuts.reserved.browser_new_window',           context: 'global' },
  { combo: 'Ctrl+Shift+N',     labelKey: 'app.shortcuts.reserved.browser_new_incognito_window', context: 'global' },

  // Monaco editor built-in shortcuts
  { combo: 'Ctrl+F',           labelKey: 'app.shortcuts.reserved.editor_find',               context: 'monaco', monacoCommandId: 'actions.find', platforms: ['windows'] },
  { combo: 'Meta+F',           labelKey: 'app.shortcuts.reserved.editor_find',               context: 'monaco', monacoCommandId: 'actions.find', platforms: ['mac'] },
  { combo: 'Ctrl+H',           labelKey: 'app.shortcuts.reserved.editor_replace',            context: 'monaco', monacoCommandId: 'editor.action.startFindReplaceAction', platforms: ['windows'] },
  { combo: 'Meta+H',           labelKey: 'app.shortcuts.reserved.editor_replace',            context: 'monaco', monacoCommandId: 'editor.action.startFindReplaceAction', platforms: ['mac'] },
  { combo: 'Ctrl+G',           labelKey: 'app.shortcuts.reserved.editor_goto_line',          context: 'monaco', monacoCommandId: 'editor.action.gotoLine', platforms: ['windows'] },
  { combo: 'Meta+G',           labelKey: 'app.shortcuts.reserved.editor_goto_line',          context: 'monaco', monacoCommandId: 'editor.action.gotoLine', platforms: ['mac'] },
  { combo: 'Ctrl+P',           labelKey: 'app.shortcuts.reserved.editor_quick_open',         context: 'monaco', monacoCommandId: 'actions.quickOpen', platforms: ['windows'] },
  { combo: 'Meta+P',           labelKey: 'app.shortcuts.reserved.editor_quick_open',         context: 'monaco', monacoCommandId: 'actions.quickOpen', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+F',     labelKey: 'app.shortcuts.reserved.editor_find_global',        context: 'monaco', monacoCommandId: 'actions.quickOpenNavigate', platforms: ['windows'] },
  { combo: 'Meta+Shift+F',     labelKey: 'app.shortcuts.reserved.editor_find_global',        context: 'monaco', monacoCommandId: 'actions.quickOpenNavigate', platforms: ['mac'] },
  { combo: 'Ctrl+D',           labelKey: 'app.shortcuts.reserved.editor_add_selection',      context: 'monaco', monacoCommandId: 'editor.action.addSelectionToNextFindMatch', platforms: ['windows'] },
  { combo: 'Meta+D',           labelKey: 'app.shortcuts.reserved.editor_add_selection',      context: 'monaco', monacoCommandId: 'editor.action.addSelectionToNextFindMatch', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+K',     labelKey: 'app.shortcuts.reserved.editor_delete_line',        context: 'monaco', monacoCommandId: 'editor.action.deleteLines', platforms: ['windows'] },
  { combo: 'Meta+Shift+K',     labelKey: 'app.shortcuts.reserved.editor_delete_line',        context: 'monaco', monacoCommandId: 'editor.action.deleteLines', platforms: ['mac'] },
  { combo: 'Ctrl+Enter',       labelKey: 'app.shortcuts.reserved.editor_insert_line_after',  context: 'monaco', monacoCommandId: 'editor.action.insertLineAfter', platforms: ['windows'] },
  { combo: 'Meta+Enter',       labelKey: 'app.shortcuts.reserved.editor_insert_line_after',  context: 'monaco', monacoCommandId: 'editor.action.insertLineAfter', platforms: ['mac'] },
  { combo: 'Ctrl+Shift+Enter', labelKey: 'app.shortcuts.reserved.editor_insert_line_before', context: 'monaco', monacoCommandId: 'editor.action.insertLineBefore', platforms: ['windows'] },
  { combo: 'Meta+Shift+Enter', labelKey: 'app.shortcuts.reserved.editor_insert_line_before', context: 'monaco', monacoCommandId: 'editor.action.insertLineBefore', platforms: ['mac'] },
  { combo: 'F2',               labelKey: 'app.shortcuts.reserved.editor_rename_symbol',      context: 'monaco', monacoCommandId: 'editor.action.rename' },

  // DataGrid shortcuts
  { combo: 'Ctrl+C',           labelKey: 'app.shortcuts.reserved.datagrid_copy', context: 'datagrid', platforms: ['windows'] },
  { combo: 'Meta+C',           labelKey: 'app.shortcuts.reserved.datagrid_copy', context: 'datagrid', platforms: ['mac'] },
];

export const RESERVED_SHORTCUTS: ReservedShortcut[] = RESERVED_SHORTCUT_DEFINITIONS.map((definition) => ({
  ...definition,
  get label() {
    return localizeShortcut(definition.labelKey);
  },
}));

const CONTEXT_DESCRIPTION_KEYS: Record<ConflictContext, string> = {
  global: 'app.shortcuts.context.global',
  monaco: 'app.shortcuts.context.monaco',
  datagrid: 'app.shortcuts.context.datagrid',
};

export const describeConflictContext = (context: ConflictContext): string => {
  const key = CONTEXT_DESCRIPTION_KEYS[context];
  return key ? localizeShortcut(key) : context;
};

export const splitConflictsByContext = (conflicts: ConflictInfo[]) => {
  const monaco = conflicts.filter(c => c.context === 'monaco');
  const other = conflicts.filter(c => c.context !== 'monaco');
  const dedupe = (items: ConflictInfo[], fn: (c: ConflictInfo) => string) =>
    [...new Set(items.map(fn))].join('、');
  return {
    monacoLabels: dedupe(monaco, c => c.label),
    otherLabels: dedupe(other, c => c.label),
    otherContexts: dedupe(other, c => describeConflictContext(c.context)),
    hasMonaco: monaco.length > 0,
    hasOther: other.length > 0,
  };
};

export const findReservedConflict = (normalizedCombo: string): ConflictInfo | null => {
  const conflict = findReservedConflicts(normalizedCombo)[0];
  if (!conflict) return null;
  return conflict;
};

export const findReservedConflicts = (normalizedCombo: string, platform?: ShortcutPlatform): ConflictInfo[] => {
  return RESERVED_SHORTCUTS
    .filter((r) => r.combo === normalizedCombo && (!platform || !r.platforms || r.platforms.includes(platform)))
    .map((r) => ({ label: r.label, context: r.context, monacoCommandId: r.monacoCommandId }));
};

export const findReservedConflictsForAction = (
  action: ShortcutAction,
  normalizedCombo: string,
  platform?: ShortcutPlatform,
): ConflictInfo[] => {
  const conflicts = findReservedConflicts(normalizedCombo, platform);
  const allowedMonacoCommandIds = new Set(
    SHORTCUT_ACTION_META[action].allowedReservedMonacoCommandIds || [],
  );
  if (allowedMonacoCommandIds.size === 0) {
    return conflicts;
  }
  return conflicts.filter((conflict) => (
    conflict.context !== 'monaco'
    || !conflict.monacoCommandId
    || !allowedMonacoCommandIds.has(conflict.monacoCommandId)
  ));
};
