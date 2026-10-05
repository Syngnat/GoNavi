import { t, getCurrentLanguage } from '../i18n';

export type ShortcutAction =
  | 'runQuery'
  | 'selectCurrentStatement'
  | 'duplicateCurrentLine'
  | 'toggleLineComment'
  | 'saveQuery'
  | 'saveQueryAs'
  | 'formatSql'
  | 'triggerSqlAiCompletion'
  | 'acceptSqlAiCompletion'
  | 'toggleQueryResultsPanel'
  | 'toggleEditorFullscreen'
  | 'sendAIChatMessage'
  | 'focusSidebarSearch'
  | 'newQueryTab'
  | 'closeActiveTab'
  | 'switchToNextTab'
  | 'switchToPreviousTab'
  | 'newConnection'
  | 'toggleAIPanel'
  | 'toggleLogPanel'
  | 'toggleTheme'
  | 'openShortcutManager'
  | 'toggleMacFullscreen'
  | 'resetWindowZoom'
  | 'diagnoseQuery'
  | 'diagnoseExecutionError'
  | 'optimizeQueryWithAI'
  | 'showSlowQueries';

export type ShortcutPlatform = 'mac' | 'windows';

export interface ShortcutPlatformBinding {
  combo: string;
  enabled: boolean;
}

export type ShortcutBinding = Record<ShortcutPlatform, ShortcutPlatformBinding>;

export type ShortcutOptions = Record<ShortcutAction, ShortcutBinding>;

export interface ShortcutActionMeta {
  label: string;
  description: string;
  allowInEditable?: boolean;
  allowWithoutModifier?: boolean;
  scope?: 'global' | 'aiComposer' | 'queryEditor';
  requiredKey?: string;
  disallowShift?: boolean;
  platformOnly?: 'mac';
  allowedReservedMonacoCommandIds?: string[];
}

interface ShortcutActionMetaDefinition extends Omit<ShortcutActionMeta, 'label' | 'description'> {
  label?: string;
  description?: string;
  labelKey?: string;
  descriptionKey?: string;
}

export const MODIFIER_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;
export const MODIFIER_SET = new Set(MODIFIER_ORDER);

export const KEY_ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  command: 'Meta',
  cmd: 'Meta',
  meta: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  escape: 'Esc',
  esc: 'Esc',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '`': '`',
};

export const SHORTCUT_ACTION_ORDER: ShortcutAction[] = [
  'runQuery',
  'selectCurrentStatement',
  'duplicateCurrentLine',
  'toggleLineComment',
  'saveQuery',
  'saveQueryAs',
  'formatSql',
  'triggerSqlAiCompletion',
  'acceptSqlAiCompletion',
  'toggleQueryResultsPanel',
  'toggleEditorFullscreen',
  'sendAIChatMessage',
  'focusSidebarSearch',
  'newQueryTab',
  'closeActiveTab',
  'switchToNextTab',
  'switchToPreviousTab',
  'newConnection',
  'toggleAIPanel',
  'toggleLogPanel',
  'toggleTheme',
  'diagnoseQuery',
  'diagnoseExecutionError',
  'optimizeQueryWithAI',
  'showSlowQueries',
  'openShortcutManager',
  'toggleMacFullscreen',
  'resetWindowZoom',
];

export const localizeShortcut = (key: string): string => t(key, undefined, getCurrentLanguage());

const createShortcutActionMeta = (
  definition: ShortcutActionMetaDefinition,
): ShortcutActionMeta => ({
  get label() {
    return definition.label ?? localizeShortcut(definition.labelKey || '');
  },
  get description() {
    return definition.description ?? localizeShortcut(definition.descriptionKey || '');
  },
  allowInEditable: definition.allowInEditable,
  allowWithoutModifier: definition.allowWithoutModifier,
  scope: definition.scope,
  requiredKey: definition.requiredKey,
  disallowShift: definition.disallowShift,
  platformOnly: definition.platformOnly,
  allowedReservedMonacoCommandIds: definition.allowedReservedMonacoCommandIds,
});

const SHORTCUT_ACTION_META_DEFINITIONS: Record<ShortcutAction, ShortcutActionMetaDefinition> = {
  runQuery: {
    labelKey: 'app.shortcuts.action.runQuery.label',
    descriptionKey: 'app.shortcuts.action.runQuery.description',
  },
  selectCurrentStatement: {
    labelKey: 'app.shortcuts.action.selectCurrentStatement.label',
    descriptionKey: 'app.shortcuts.action.selectCurrentStatement.description',
    scope: 'queryEditor',
  },
  duplicateCurrentLine: {
    labelKey: 'app.shortcuts.action.duplicateCurrentLine.label',
    descriptionKey: 'app.shortcuts.action.duplicateCurrentLine.description',
    scope: 'queryEditor',
    allowInEditable: true,
    allowedReservedMonacoCommandIds: ['editor.action.addSelectionToNextFindMatch'],
  },
  toggleLineComment: {
    labelKey: 'app.shortcuts.action.toggleLineComment.label',
    descriptionKey: 'app.shortcuts.action.toggleLineComment.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  saveQuery: {
    labelKey: 'app.shortcuts.action.saveQuery.label',
    descriptionKey: 'app.shortcuts.action.saveQuery.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  saveQueryAs: {
    labelKey: 'app.shortcuts.action.saveQueryAs.label',
    descriptionKey: 'app.shortcuts.action.saveQueryAs.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  formatSql: {
    labelKey: 'app.shortcuts.action.formatSql.label',
    descriptionKey: 'app.shortcuts.action.formatSql.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  triggerSqlAiCompletion: {
    labelKey: 'app.shortcuts.action.triggerSqlAiCompletion.label',
    descriptionKey: 'app.shortcuts.action.triggerSqlAiCompletion.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  acceptSqlAiCompletion: {
    labelKey: 'app.shortcuts.action.acceptSqlAiCompletion.label',
    descriptionKey: 'app.shortcuts.action.acceptSqlAiCompletion.description',
    scope: 'queryEditor',
    allowInEditable: true,
    allowWithoutModifier: true,
  },
  toggleQueryResultsPanel: {
    labelKey: 'app.shortcuts.action.toggleQueryResultsPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleQueryResultsPanel.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  toggleEditorFullscreen: {
    labelKey: 'app.shortcuts.action.toggleEditorFullscreen.label',
    descriptionKey: 'app.shortcuts.action.toggleEditorFullscreen.description',
    scope: 'queryEditor',
    allowInEditable: true,
    allowWithoutModifier: true,
  },
  sendAIChatMessage: {
    labelKey: 'app.shortcuts.action.sendAIChatMessage.label',
    descriptionKey: 'app.shortcuts.action.sendAIChatMessage.description',
    allowInEditable: true,
    allowWithoutModifier: true,
    scope: 'aiComposer',
    requiredKey: 'Enter',
    disallowShift: true,
  },
  focusSidebarSearch: {
    labelKey: 'app.shortcuts.action.focusSidebarSearch.label',
    descriptionKey: 'app.shortcuts.action.focusSidebarSearch.description',
    allowInEditable: true,
  },
  newQueryTab: {
    labelKey: 'app.shortcuts.action.newQueryTab.label',
    descriptionKey: 'app.shortcuts.action.newQueryTab.description',
    allowInEditable: true,
  },
  closeActiveTab: {
    labelKey: 'app.shortcuts.action.closeActiveTab.label',
    descriptionKey: 'app.shortcuts.action.closeActiveTab.description',
    scope: 'global',
    allowInEditable: true,
  },
  switchToNextTab: {
    labelKey: 'app.shortcuts.action.switchToNextTab.label',
    descriptionKey: 'app.shortcuts.action.switchToNextTab.description',
    allowInEditable: true,
  },
  switchToPreviousTab: {
    labelKey: 'app.shortcuts.action.switchToPreviousTab.label',
    descriptionKey: 'app.shortcuts.action.switchToPreviousTab.description',
    allowInEditable: true,
  },
  newConnection: {
    labelKey: 'app.shortcuts.action.newConnection.label',
    descriptionKey: 'app.shortcuts.action.newConnection.description',
  },
  toggleAIPanel: {
    labelKey: 'app.shortcuts.action.toggleAIPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleAIPanel.description',
    allowInEditable: true,
  },
  toggleLogPanel: {
    labelKey: 'app.shortcuts.action.toggleLogPanel.label',
    descriptionKey: 'app.shortcuts.action.toggleLogPanel.description',
  },
  toggleTheme: {
    labelKey: 'app.shortcuts.action.toggleTheme.label',
    descriptionKey: 'app.shortcuts.action.toggleTheme.description',
  },
  diagnoseQuery: {
    labelKey: 'app.shortcuts.action.diagnoseQuery.label',
    descriptionKey: 'app.shortcuts.action.diagnoseQuery.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  diagnoseExecutionError: {
    labelKey: 'app.shortcuts.action.diagnoseExecutionError.label',
    descriptionKey: 'app.shortcuts.action.diagnoseExecutionError.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  optimizeQueryWithAI: {
    labelKey: 'app.shortcuts.action.optimizeQueryWithAI.label',
    descriptionKey: 'app.shortcuts.action.optimizeQueryWithAI.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  showSlowQueries: {
    labelKey: 'app.shortcuts.action.showSlowQueries.label',
    descriptionKey: 'app.shortcuts.action.showSlowQueries.description',
    scope: 'queryEditor',
    allowInEditable: true,
  },
  openShortcutManager: {
    labelKey: 'app.shortcuts.action.openShortcutManager.label',
    descriptionKey: 'app.shortcuts.action.openShortcutManager.description',
    allowInEditable: true,
  },
  toggleMacFullscreen: {
    labelKey: 'app.shortcuts.action.toggleMacFullscreen.label',
    descriptionKey: 'app.shortcuts.action.toggleMacFullscreen.description',
    platformOnly: 'mac',
  },
  resetWindowZoom: {
    labelKey: 'app.shortcuts.action.resetWindowZoom.label',
    descriptionKey: 'app.shortcuts.action.resetWindowZoom.description',
    allowInEditable: true,
  },
};

export const SHORTCUT_ACTION_META: Record<ShortcutAction, ShortcutActionMeta> = Object.fromEntries(
  SHORTCUT_ACTION_ORDER.map((action) => [
    action,
    createShortcutActionMeta(SHORTCUT_ACTION_META_DEFINITIONS[action]),
  ]),
) as Record<ShortcutAction, ShortcutActionMeta>;

export const DEFAULT_SHORTCUT_OPTIONS: ShortcutOptions = {
  runQuery: {
    mac: { combo: 'Meta+R', enabled: true },
    windows: { combo: 'Ctrl+R', enabled: true },
  },
  selectCurrentStatement: {
    mac: { combo: 'Meta+E', enabled: true },
    windows: { combo: 'Ctrl+E', enabled: true },
  },
  duplicateCurrentLine: {
    mac: { combo: 'Meta+D', enabled: true },
    windows: { combo: 'Ctrl+D', enabled: true },
  },
  // 行注释切换：沿用 Monaco 内置 Ctrl+/ 语义（sql 的 lineComment 为 --），
  // 与「AI 诊断」的 Ctrl+Shift+A 不冲突；改键冲突由设置中心统一检测。
  toggleLineComment: {
    mac: { combo: 'Meta+/', enabled: true },
    windows: { combo: 'Ctrl+/', enabled: true },
  },
  saveQuery: {
    mac: { combo: 'Meta+S', enabled: true },
    windows: { combo: 'Ctrl+S', enabled: true },
  },
  saveQueryAs: {
    mac: { combo: 'Meta+Shift+S', enabled: true },
    windows: { combo: 'Ctrl+Shift+S', enabled: true },
  },
  formatSql: {
    mac: { combo: 'Alt+Shift+F', enabled: true },
    windows: { combo: 'Alt+Shift+F', enabled: true },
  },
  triggerSqlAiCompletion: {
    mac: { combo: 'Alt+\\', enabled: true },
    windows: { combo: 'Alt+\\', enabled: true },
  },
  acceptSqlAiCompletion: {
    mac: { combo: 'Tab', enabled: true },
    windows: { combo: 'Tab', enabled: true },
  },
  toggleQueryResultsPanel: {
    mac: { combo: 'Meta+Shift+M', enabled: true },
    windows: { combo: 'Ctrl+Shift+M', enabled: true },
  },
  // 编辑器面板全屏：Windows 用浏览器习惯的 F11；macOS 下裸 F11 被系统
  // 「显示桌面」占用，改用 Ctrl+F11。与 toggleMacFullscreen（窗口级全屏）不冲突。
  toggleEditorFullscreen: {
    mac: { combo: 'Ctrl+F11', enabled: true },
    windows: { combo: 'F11', enabled: true },
  },
  sendAIChatMessage: {
    mac: { combo: 'Enter', enabled: true },
    windows: { combo: 'Enter', enabled: true },
  },
  focusSidebarSearch: {
    mac: { combo: 'Meta+K', enabled: true },
    windows: { combo: 'Ctrl+K', enabled: true },
  },
  newQueryTab: {
    mac: { combo: 'Meta+N', enabled: true },
    windows: { combo: 'Ctrl+N', enabled: true },
  },
  closeActiveTab: {
    mac: { combo: 'Meta+W', enabled: true },
    windows: { combo: 'Ctrl+W', enabled: true },
  },
  switchToNextTab: {
    mac: { combo: 'Ctrl+Tab', enabled: true },
    windows: { combo: 'Ctrl+Tab', enabled: true },
  },
  switchToPreviousTab: {
    mac: { combo: 'Ctrl+Shift+Tab', enabled: true },
    windows: { combo: 'Ctrl+Shift+Tab', enabled: true },
  },
  newConnection: {
    mac: { combo: 'Meta+Shift+N', enabled: true },
    windows: { combo: 'Ctrl+Shift+N', enabled: true },
  },
  toggleAIPanel: {
    mac: { combo: 'Meta+J', enabled: true },
    windows: { combo: 'Ctrl+J', enabled: true },
  },
  toggleLogPanel: {
    mac: { combo: 'Meta+Shift+H', enabled: true },
    windows: { combo: 'Ctrl+H', enabled: true },
  },
  toggleTheme: {
    mac: { combo: 'Meta+Shift+D', enabled: true },
    windows: { combo: 'Ctrl+Shift+D', enabled: true },
  },
  // SQL 诊断：避开 toggleTheme 的 Ctrl+Shift+D，用 Ctrl+Shift+P（P = Plan）
  diagnoseQuery: {
    mac: { combo: 'Meta+Shift+P', enabled: true },
    windows: { combo: 'Ctrl+Shift+P', enabled: true },
  },
  // AI 诊断：与 SQL 诊断同族，用 Ctrl+Shift+A（A = AI），注入当前 SQL 与执行错误到 AI 面板
  diagnoseExecutionError: {
    mac: { combo: 'Meta+Shift+A', enabled: true },
    windows: { combo: 'Ctrl+Shift+A', enabled: true },
  },
  optimizeQueryWithAI: {
    mac: { combo: 'Meta+Alt+O', enabled: true },
    windows: { combo: 'Ctrl+Alt+O', enabled: true },
  },
  // 慢查询历史：避开 toggleLogPanel 的 Ctrl+H / Meta+Shift+H，用 Ctrl+Shift+L（L = Log）
  showSlowQueries: {
    mac: { combo: 'Meta+Shift+L', enabled: true },
    windows: { combo: 'Ctrl+Shift+L', enabled: true },
  },
  openShortcutManager: {
    mac: { combo: 'Meta+,', enabled: true },
    windows: { combo: 'Ctrl+,', enabled: true },
  },
  toggleMacFullscreen: {
    mac: { combo: 'Ctrl+Meta+F', enabled: true },
    windows: { combo: '', enabled: false },
  },
  resetWindowZoom: {
    mac: { combo: '', enabled: false },
    windows: { combo: 'Ctrl+Shift+0', enabled: true },
  },
};
