import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setCurrentLanguage,
} from '../i18n';
import {
  DEFAULT_SHORTCUT_OPTIONS,
  canRecordShortcutForAction,
  findReservedConflict,
  findReservedConflicts,
  findReservedConflictsForAction,
  describeConflictContext,
  normalizeShortcutCombo,
  RESERVED_SHORTCUTS,
  comboToMonacoKeyBinding,
  eventToShortcut,
  findEnabledActionConflicts,
  getShortcutPlatform,
  getPrimaryShortcutDisplayLabel,
  getShortcutDisplayLabel,
  getShortcutPrimaryModifierDisplayLabel,
  installGlobalImeCompositionTracking,
  isEditableElement,
  isGlobalImeCompositionActive,
  isGlobalShortcutCaptureActive,
  isImeComposingKeyEvent,
  isShortcutMatch,
  isShortcutPhysicalMatch,
  migrateLegacySidebarSearchShortcutOptions,
  resolveShortcutBinding,
  resolveShortcutDisplay,
  shortcutScopesConflict,
  setGlobalShortcutCaptureActive,
  setGlobalImeCompositionActive,
  sanitizeShortcutOptions,
  SHORTCUT_ACTION_META,
  SHORTCUT_ACTION_ORDER,
  type ShortcutAction,
} from './shortcuts';
import type { ConflictInfo } from './shortcuts';

beforeEach(() => {
  setCurrentLanguage('zh-CN');
  setGlobalImeCompositionActive(false);
  setGlobalShortcutCaptureActive(false);
});

describe('editable targets', () => {
  it('treats Ant Design select dropdown options as interactive targets', () => {
    const OriginalHTMLElement = globalThis.HTMLElement;
    class MockHTMLElement {
      tagName = 'div';
      isContentEditable = false;

      closest(selector: string) {
        return selector.includes('.ant-select-dropdown') ? this : null;
      }
    }
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: MockHTMLElement,
    });

    try {
      expect(isEditableElement(new MockHTMLElement() as unknown as EventTarget)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        value: OriginalHTMLElement,
      });
    }
  });

  it('treats SVG picker icons as interactive targets through their dropdown ancestor', () => {
    const pickerPath = {
      tagName: 'path',
      isContentEditable: false,
      closest: (selector: string) => selector.includes('.ant-picker-dropdown') ? {} : null,
    };

    expect(isEditableElement(pickerPath as unknown as EventTarget)).toBe(true);
  });
});

// ─── findReservedConflict ────────────────────────────────────────────

describe('findReservedConflict', () => {
  it('finds Ctrl+F conflict (Monaco Find)', () => {
    const result = findReservedConflict('Ctrl+F');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('编辑器查找');
    expect(result!.context).toBe('monaco');
    expect(result!.monacoCommandId).toBe('actions.find');
  });

  it('finds Ctrl+S conflict (browser save)', () => {
    const result = findReservedConflict('Ctrl+S');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('浏览器保存');
    expect(result!.context).toBe('global');
  });

  it('returns null for non-reserved combo', () => {
    expect(findReservedConflict('Ctrl+Shift+R')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(findReservedConflict('')).toBeNull();
  });

  it('finds Meta+F (macOS variant)', () => {
    const result = findReservedConflict('Meta+F');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('编辑器查找');
    expect(result!.context).toBe('monaco');
  });

  it('matches after normalization (ctrl+f → Ctrl+F)', () => {
    const result = findReservedConflict(normalizeShortcutCombo('ctrl+f'));
    expect(result).not.toBeNull();
    expect(result!.label).toBe('编辑器查找');
  });

  it('finds F2 conflict', () => {
    const result = findReservedConflict('F2');
    expect(result).not.toBeNull();
    expect(result!.context).toBe('monaco');
  });
});

// ─── findReservedConflicts ───────────────────────────────────────────

describe('findReservedConflicts', () => {
  it('returns multiple conflicts for Ctrl+Enter', () => {
    const results = findReservedConflicts('Ctrl+Enter');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const labels = results.map(r => r.label);
    expect(labels).toContain('编辑器在下方插入行');
  });

  it('returns empty array for non-reserved combo', () => {
    expect(findReservedConflicts('Ctrl+Shift+Q')).toEqual([]);
  });

  it('does not reserve Ctrl+W after the app takes ownership of close-tab', () => {
    expect(findReservedConflicts('Ctrl+W')).toEqual([]);
  });

  it('preserves monacoCommandId in results', () => {
    const results = findReservedConflicts('Ctrl+F');
    expect(results[0].monacoCommandId).toBe('actions.find');
  });

  it('uses Command instead of Control for macOS find shortcut conflicts', () => {
    expect(findReservedConflicts('Ctrl+F', 'mac')).toEqual([]);
    expect(findReservedConflicts('Meta+F', 'mac')[0]).toMatchObject({
      label: '编辑器查找',
      monacoCommandId: 'actions.find',
    });
    expect(findReservedConflicts('Ctrl+F', 'windows')[0]).toMatchObject({
      label: '编辑器查找',
      monacoCommandId: 'actions.find',
    });
  });
});

describe('findReservedConflictsForAction', () => {
  it('allows duplicate current line to reuse Monaco add-selection shortcut on Windows', () => {
    expect(findReservedConflicts('Ctrl+D', 'windows')).toEqual([
      expect.objectContaining({
        monacoCommandId: 'editor.action.addSelectionToNextFindMatch',
      }),
    ]);
    expect(findReservedConflictsForAction('duplicateCurrentLine', 'Ctrl+D', 'windows')).toEqual([]);
  });

  it('allows duplicate current line to reuse Monaco add-selection shortcut on macOS', () => {
    expect(findReservedConflicts('Meta+D', 'mac')).toEqual([
      expect.objectContaining({
        monacoCommandId: 'editor.action.addSelectionToNextFindMatch',
      }),
    ]);
    expect(findReservedConflictsForAction('duplicateCurrentLine', 'Meta+D', 'mac')).toEqual([]);
  });
});

// ─── describeConflictContext ─────────────────────────────────────────

describe('describeConflictContext', () => {
  it('describes global context', () => {
    expect(describeConflictContext('global')).toBe('浏览器');
  });

  it('describes monaco context', () => {
    expect(describeConflictContext('monaco')).toBe('编辑器');
  });

  it('describes datagrid context', () => {
    expect(describeConflictContext('datagrid')).toBe('数据表格');
  });
});

describe('shortcut localization', () => {
  it('localizes action meta and reserved conflict copy for the active language while preserving raw combos', () => {
    setCurrentLanguage('en-US');
    try {
      expect(SHORTCUT_ACTION_META.runQuery.label).toBe('Run SQL');
      expect(SHORTCUT_ACTION_META.saveQuery.description).toBe('Save the current query tab; unnamed queries open the save dialog');
      expect(SHORTCUT_ACTION_META.formatSql.label).toBe('Format SQL');
      expect(SHORTCUT_ACTION_META.triggerSqlAiCompletion.label).toBe('Trigger SQL AI Completion');
      expect(SHORTCUT_ACTION_META.toggleQueryResultsPanel.label).toBe('Toggle Results Panel');
      expect(SHORTCUT_ACTION_META.toggleQueryResultsPanel.description).toBe('Show or hide the results area below the query editor');
      expect(SHORTCUT_ACTION_META.sendAIChatMessage.description).toContain('Shift+Enter');
      expect(describeConflictContext('global')).toBe('Browser');

      const browserSave = findReservedConflict('Ctrl+S');
      expect(browserSave).toMatchObject({
        label: 'Browser Save',
        context: 'global',
      });

      setCurrentLanguage('zh-CN');
      expect(SHORTCUT_ACTION_META.runQuery.label).toBe('执行 SQL');
      expect(SHORTCUT_ACTION_META.formatSql.label).toBe('美化 SQL');
      expect(SHORTCUT_ACTION_META.triggerSqlAiCompletion.label).toBe('触发 SQL AI 自动补全');
      expect(findReservedConflict('Ctrl+S')?.label).toBe('浏览器保存');
    } finally {
      setCurrentLanguage('zh-CN');
    }
  });
});

// ─── RESERVED_SHORTCUTS sanity ───────────────────────────────────────

describe('RESERVED_SHORTCUTS', () => {
  it('all combos are already normalized', () => {
    for (const entry of RESERVED_SHORTCUTS) {
      expect(entry.combo).toBe(normalizeShortcutCombo(entry.combo));
    }
  });

  it('has at least 10 entries', () => {
    expect(RESERVED_SHORTCUTS.length).toBeGreaterThanOrEqual(10);
  });

  it('every entry has a label and context', () => {
    for (const entry of RESERVED_SHORTCUTS) {
      expect(entry.label).toBeTruthy();
      expect(['global', 'monaco', 'datagrid']).toContain(entry.context);
    }
  });
});

describe('IME shortcut guards', () => {
  it('suppresses normal shortcut owners while the recorder is active', () => {
    const event = {
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;

    setGlobalShortcutCaptureActive(true);
    expect(isGlobalShortcutCaptureActive()).toBe(true);
    expect(isShortcutMatch(event, 'Ctrl+W')).toBe(false);
    expect(isShortcutPhysicalMatch(event, 'Ctrl+W')).toBe(true);
  });

  it('keeps a recorder registered after an existing owner safe from listener order', () => {
    const target = new EventTarget();
    const owner = vi.fn();
    const recorder = vi.fn();
    target.addEventListener('keydown', (rawEvent) => {
      if (isShortcutMatch(rawEvent as KeyboardEvent, 'Ctrl+W')) owner();
    });

    setGlobalShortcutCaptureActive(true);
    target.addEventListener('keydown', (rawEvent) => {
      recorder(eventToShortcut(rawEvent as KeyboardEvent));
    });
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, {
      key: { value: 'w' },
      code: { value: 'KeyW' },
      ctrlKey: { value: true },
      metaKey: { value: false },
      altKey: { value: false },
      shiftKey: { value: false },
    });
    target.dispatchEvent(event);

    expect(owner).not.toHaveBeenCalled();
    expect(recorder).toHaveBeenCalledWith('Ctrl+W');
  });

  it('tracks composition state through global listeners', () => {
    const windowListeners = new Map<string, EventListener[]>();
    const documentListeners = new Map<string, EventListener[]>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, [...(windowListeners.get(type) || []), listener]);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== listener));
      }),
    };
    const documentTarget = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        documentListeners.set(type, [...(documentListeners.get(type) || []), listener]);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        documentListeners.set(type, (documentListeners.get(type) || []).filter(item => item !== listener));
      }),
    };

    const dispose = installGlobalImeCompositionTracking(
      target as unknown as Window,
      documentTarget as unknown as Document,
    );

    windowListeners.get('compositionstart')?.forEach(listener => listener(new Event('compositionstart')));
    expect(isGlobalImeCompositionActive()).toBe(true);

    windowListeners.get('compositionend')?.forEach(listener => listener(new Event('compositionend')));
    expect(isGlobalImeCompositionActive()).toBe(false);

    windowListeners.get('compositionstart')?.forEach(listener => listener(new Event('compositionstart')));
    windowListeners.get('blur')?.forEach(listener => listener(new Event('blur')));
    expect(isGlobalImeCompositionActive()).toBe(false);

    windowListeners.get('compositionstart')?.forEach(listener => listener(new Event('compositionstart')));
    documentTarget.visibilityState = 'hidden';
    documentListeners.get('visibilitychange')?.forEach(listener => listener(new Event('visibilitychange')));
    expect(isGlobalImeCompositionActive()).toBe(false);

    dispose();
    expect(target.removeEventListener).toHaveBeenCalledWith('compositionstart', expect.any(Function), true);
    expect(documentTarget.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function), true);
  });

  it('treats composing key events as non-shortcuts', () => {
    const event = {
      key: 'Process',
      keyCode: 229,
      which: 229,
      isComposing: true,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      nativeEvent: {
        isComposing: true,
        keyCode: 229,
        which: 229,
      },
    } as unknown as KeyboardEvent;

    expect(isImeComposingKeyEvent(event)).toBe(true);
    expect(eventToShortcut(event)).toBe('');
    expect(isShortcutMatch(event, 'Ctrl+Enter')).toBe(false);
  });

  it('matches a physical shortcut during IME composition without changing the guarded matcher', () => {
    const event = {
      key: 'w',
      code: 'KeyW',
      keyCode: 229,
      which: 229,
      isComposing: true,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      nativeEvent: {
        isComposing: true,
        keyCode: 229,
        which: 229,
      },
    } as unknown as KeyboardEvent;

    expect(isShortcutPhysicalMatch(event, 'Ctrl+W')).toBe(true);
    expect(isShortcutMatch(event, 'Ctrl+W')).toBe(false);
  });

  it('matches modifier shortcuts from KeyboardEvent.code when WebView reports Process', () => {
    const event = {
      key: 'Process',
      code: 'Backslash',
      keyCode: 220,
      which: 220,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isComposing: false,
      nativeEvent: {
        code: 'Backslash',
        keyCode: 220,
        which: 220,
        isComposing: false,
      },
    } as unknown as KeyboardEvent;

    expect(isImeComposingKeyEvent(event)).toBe(false);
    expect(eventToShortcut(event)).toBe('Alt+\\');
    expect(isShortcutMatch(event, 'Alt+\\')).toBe(true);
  });

  it('matches modifier shortcuts from IntlBackslash layout events when WebView reports Process', () => {
    const event = {
      key: 'Process',
      code: 'IntlBackslash',
      keyCode: 226,
      which: 226,
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isComposing: false,
      nativeEvent: {
        code: 'IntlBackslash',
        keyCode: 226,
        which: 226,
        isComposing: false,
      },
    } as unknown as KeyboardEvent;

    expect(isImeComposingKeyEvent(event)).toBe(false);
    expect(eventToShortcut(event)).toBe('Alt+\\');
    expect(isShortcutMatch(event, 'Alt+\\')).toBe(true);
  });

  it('treats number keys as non-shortcuts while a composition session is active', () => {
    setGlobalImeCompositionActive(true);
    const event = {
      key: '1',
      keyCode: 49,
      which: 49,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      nativeEvent: {
        isComposing: false,
      },
    } as unknown as KeyboardEvent;

    expect(isImeComposingKeyEvent(event)).toBe(true);
    expect(eventToShortcut(event)).toBe('');
    expect(isShortcutMatch(event, '1')).toBe(false);
  });

  it('treats Monaco visible IME textarea events as composing even without native flags', () => {
    const target = {
      className: 'inputarea monaco-mouse-cursor-text ime-input',
      classList: {
        contains: (name: string) => name === 'ime-input',
      },
      closest: vi.fn(),
    } as unknown as EventTarget;
    const event = {
      key: '1',
      keyCode: 49,
      which: 49,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      nativeEvent: {
        isComposing: false,
      },
      target,
    } as unknown as KeyboardEvent;

    expect(isImeComposingKeyEvent(event)).toBe(true);
    expect(eventToShortcut(event)).toBe('');
    expect(isShortcutMatch(event, '1')).toBe(false);
  });
});

// ─── shortcut defaults ───────────────────────────────────────────────

describe('shortcut defaults', () => {
  it('registers close active tab as an editable global shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.closeActiveTab).toEqual({
      mac: { combo: 'Meta+W', enabled: true },
      windows: { combo: 'Ctrl+W', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.closeActiveTab).toMatchObject({
      label: '关闭当前标签页',
      scope: 'global',
      allowInEditable: true,
    });
  });

  it('allows the new query tab shortcut from editable targets', () => {
    expect(SHORTCUT_ACTION_META.newQueryTab).toMatchObject({
      allowInEditable: true,
    });
  });

  it('registers select current statement as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.selectCurrentStatement).toEqual({
      mac: { combo: 'Meta+E', enabled: true },
      windows: { combo: 'Ctrl+E', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.selectCurrentStatement).toMatchObject({
      label: '选择当前行并复制',
      scope: 'queryEditor',
    });
  });

  it('registers duplicate current line as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.duplicateCurrentLine).toEqual({
      mac: { combo: 'Meta+D', enabled: true },
      windows: { combo: 'Ctrl+D', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.duplicateCurrentLine).toMatchObject({
      label: '复制当前行到下一行',
      scope: 'queryEditor',
      allowInEditable: true,
      allowedReservedMonacoCommandIds: ['editor.action.addSelectionToNextFindMatch'],
    });
  });

  it('registers save query as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.saveQuery).toEqual({
      mac: { combo: 'Meta+S', enabled: true },
      windows: { combo: 'Ctrl+S', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.saveQuery).toMatchObject({
      label: '保存查询',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  it('registers save query as a copy as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.saveQueryAs).toEqual({
      mac: { combo: 'Meta+Shift+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.saveQueryAs).toMatchObject({
      label: '查询另存为',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  it('registers format SQL as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.formatSql).toEqual({
      mac: { combo: 'Alt+Shift+F', enabled: true },
      windows: { combo: 'Alt+Shift+F', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.formatSql).toMatchObject({
      label: '美化 SQL',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  it('registers manual SQL AI completion as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.triggerSqlAiCompletion).toEqual({
      mac: { combo: 'Alt+\\', enabled: true },
      windows: { combo: 'Alt+\\', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.triggerSqlAiCompletion).toMatchObject({
      label: '触发 SQL AI 自动补全',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  it('registers query results panel toggle as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleQueryResultsPanel).toEqual({
      mac: { combo: 'Meta+Shift+M', enabled: true },
      windows: { combo: 'Ctrl+Shift+M', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.toggleQueryResultsPanel).toMatchObject({
      label: '切换结果区',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  it('registers AI diagnosis as a query editor shortcut', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.diagnoseExecutionError).toEqual({
      mac: { combo: 'Meta+Shift+A', enabled: true },
      windows: { combo: 'Ctrl+Shift+A', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.diagnoseExecutionError).toMatchObject({
      label: 'AI 诊断',
      scope: 'queryEditor',
      allowInEditable: true,
    });
  });

  // Windows 任务栏恢复后字体异常变大的兜底入口（方案 3）。
  // 自动 fix 路径（9848b8b2）刻意不再 toggle 以避免可见动画，由该快捷键给用户主动触发的修复入口。
  it('registers reset window zoom shortcut with default Ctrl+Shift+0', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.resetWindowZoom).toEqual({
      mac: { combo: '', enabled: false },
      windows: { combo: 'Ctrl+Shift+0', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.resetWindowZoom).toMatchObject({
      label: '重置窗口缩放',
      allowInEditable: true,
    });
  });

  it('keeps configurable shortcut descriptions free of hardcoded shortcut labels', () => {
    Object.values(SHORTCUT_ACTION_META).forEach((meta) => {
      expect(meta.description).not.toMatch(/⌘|⌃|Ctrl|Meta|Cmd|Command|Alt\+/);
    });
  });

  it('keeps enabled default shortcuts unique within overlapping scopes', () => {
    for (const platform of ['mac', 'windows'] as const) {
      const seen = new Map<string, ShortcutAction[]>();
      Object.entries(DEFAULT_SHORTCUT_OPTIONS).forEach(([action, bindings]) => {
        const binding = bindings[platform];
        if (!binding.enabled || !binding.combo) return;
        const typedAction = action as ShortcutAction;
        const existingActions = seen.get(binding.combo) || [];
        const conflicts = existingActions.filter((existing) => (
          shortcutScopesConflict(existing, typedAction)
        ));
        expect(
          conflicts,
          `${platform} ${binding.combo} conflicts with ${conflicts.join(', ')}`,
        ).toEqual([]);
        seen.set(binding.combo, [...existingActions, typedAction]);
      });
    }
  });

  it('allows the same combo in different local scopes but not across global actions', () => {
    expect(shortcutScopesConflict('saveQuery', 'scriptWorkbenchSave')).toBe(false);
    expect(shortcutScopesConflict('saveQueryAs', 'scriptWorkbenchShare')).toBe(false);
    expect(shortcutScopesConflict('runQuery', 'scriptWorkbenchRun')).toBe(true);
    expect(shortcutScopesConflict('closeActiveTab', 'scriptWorkbenchRun')).toBe(true);
  });

  it('uses Navicat-inspired defaults separately for macOS and Windows/Linux', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.runQuery).toEqual({
      mac: { combo: 'Meta+R', enabled: true },
      windows: { combo: 'Ctrl+R', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.newQueryTab).toEqual({
      mac: { combo: 'Meta+N', enabled: true },
      windows: { combo: 'Ctrl+N', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.switchToNextTab).toEqual({
      mac: { combo: 'Ctrl+Tab', enabled: true },
      windows: { combo: 'Ctrl+Tab', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.switchToPreviousTab).toEqual({
      mac: { combo: 'Ctrl+Shift+Tab', enabled: true },
      windows: { combo: 'Ctrl+Shift+Tab', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleLogPanel).toEqual({
      mac: { combo: 'Meta+Shift+H', enabled: true },
      windows: { combo: 'Ctrl+H', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+K', enabled: true },
      windows: { combo: 'Ctrl+K', enabled: true },
    });
    expect(getShortcutPlatform(true)).toBe('mac');
    expect(getShortcutPlatform(false)).toBe('windows');
    expect(getShortcutPlatform()).toBe('windows');
  });

  it('registers connection and AI panel actions as real shortcuts', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.newConnection).toEqual({
      mac: { combo: 'Meta+Shift+N', enabled: true },
      windows: { combo: 'Ctrl+Shift+N', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleAIPanel).toEqual({
      mac: { combo: 'Meta+J', enabled: true },
      windows: { combo: 'Ctrl+J', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.newConnection.label).toBe('新建数据源');
    expect(SHORTCUT_ACTION_META.toggleAIPanel.label).toBe('打开 AI 数据洞察');
  });

  it('registers script workbench actions with scoped defaults', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.scriptWorkbenchRun).toEqual({
      mac: { combo: 'Meta+Enter', enabled: true },
      windows: { combo: 'Ctrl+Enter', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.scriptWorkbenchSave).toEqual({
      mac: { combo: 'Meta+S', enabled: true },
      windows: { combo: 'Ctrl+S', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.scriptWorkbenchLibrary).toEqual({
      mac: { combo: 'Meta+O', enabled: true },
      windows: { combo: 'Ctrl+O', enabled: true },
    });
    expect(DEFAULT_SHORTCUT_OPTIONS.scriptWorkbenchShare).toEqual({
      mac: { combo: 'Meta+Shift+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.scriptWorkbenchRun).toMatchObject({
      scope: 'scriptWorkbench',
      allowInEditable: true,
    });
    expect(SHORTCUT_ACTION_META.scriptWorkbenchSave.scope).toBe('scriptWorkbench');
  });

  it('migrates legacy single-platform shortcut bindings into both platform slots', () => {
    const options = sanitizeShortcutOptions({
      runQuery: { combo: 'Ctrl+Shift+R', enabled: false },
    });

    expect(options.runQuery).toEqual({
      mac: { combo: 'Ctrl+Shift+R', enabled: false },
      windows: { combo: 'Ctrl+Shift+R', enabled: false },
    });
    expect(options.newQueryTab.windows.combo).toBe('Ctrl+N');
    expect(options.closeActiveTab).toEqual({
      mac: { combo: 'Meta+W', enabled: true },
      windows: { combo: 'Ctrl+W', enabled: true },
    });
  });

  it('migrates legacy sidebar search defaults by platform while preserving enabled state', () => {
    const options = migrateLegacySidebarSearchShortcutOptions({
      focusSidebarSearch: {
        mac: { combo: 'Meta+F', enabled: false },
        windows: { combo: 'Ctrl+F', enabled: true },
      },
    });

    expect(options.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+K', enabled: false },
      windows: { combo: 'Ctrl+K', enabled: true },
    });
  });

  it('migrates the pre-platform Ctrl+F binding without changing other custom shortcuts', () => {
    const options = migrateLegacySidebarSearchShortcutOptions({
      focusSidebarSearch: { combo: 'Ctrl+F', enabled: false },
      toggleTheme: {
        mac: { combo: 'Meta+Shift+T', enabled: true },
        windows: { combo: 'Ctrl+Shift+T', enabled: true },
      },
    });

    expect(options.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+K', enabled: false },
      windows: { combo: 'Ctrl+K', enabled: false },
    });
    expect(options.toggleTheme).toEqual({
      mac: { combo: 'Meta+Shift+T', enabled: true },
      windows: { combo: 'Ctrl+Shift+T', enabled: true },
    });
  });

  it('keeps non-default sidebar search shortcuts unchanged during legacy migration', () => {
    const options = migrateLegacySidebarSearchShortcutOptions({
      focusSidebarSearch: {
        mac: { combo: 'Meta+P', enabled: true },
        windows: { combo: 'Ctrl+P', enabled: false },
      },
    });

    expect(options.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+P', enabled: true },
      windows: { combo: 'Ctrl+P', enabled: false },
    });
  });

  it('keeps close active tab enabled for new and empty shortcut settings', () => {
    expect(sanitizeShortcutOptions(undefined).closeActiveTab).toEqual(DEFAULT_SHORTCUT_OPTIONS.closeActiveTab);
    expect(sanitizeShortcutOptions({}).closeActiveTab).toEqual(DEFAULT_SHORTCUT_OPTIONS.closeActiveTab);
  });

  it('fills save query as defaults for existing shortcut settings', () => {
    const options = sanitizeShortcutOptions({
      saveQuery: {
        mac: { combo: 'Meta+S', enabled: true },
        windows: { combo: 'Ctrl+S', enabled: true },
      },
    });

    expect(options.saveQueryAs).toEqual({
      mac: { combo: 'Meta+Shift+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });
  });

  it('disables only the conflicting close-tab platform while preserving current platform bindings', () => {
    const options = sanitizeShortcutOptions({
      saveQuery: {
        mac: { combo: 'Meta+W', enabled: true },
        windows: { combo: 'Ctrl+S', enabled: true },
      },
      toggleTheme: {
        mac: { combo: 'Meta+Shift+D', enabled: true },
        windows: { combo: 'Ctrl+W', enabled: true },
      },
    });

    expect(options.saveQuery.mac).toEqual({ combo: 'Meta+W', enabled: true });
    expect(options.toggleTheme.windows).toEqual({ combo: 'Ctrl+W', enabled: true });
    expect(options.closeActiveTab).toEqual({
      mac: { combo: 'Meta+W', enabled: false },
      windows: { combo: 'Ctrl+W', enabled: false },
    });
  });

  it('migrates legacy single-platform close-tab conflicts independently per platform', () => {
    const options = sanitizeShortcutOptions({
      saveQuery: { combo: 'Meta+W', enabled: true },
    });

    expect(options.saveQuery).toEqual({
      mac: { combo: 'Meta+W', enabled: true },
      windows: { combo: 'Meta+W', enabled: true },
    });
    expect(options.closeActiveTab).toEqual({
      mac: { combo: 'Meta+W', enabled: false },
      windows: { combo: 'Ctrl+W', enabled: true },
    });
  });

  it('respects an existing close active tab binding during sanitization', () => {
    const options = sanitizeShortcutOptions({
      closeActiveTab: {
        mac: { combo: 'Meta+Shift+W', enabled: false },
        windows: { combo: 'Ctrl+Shift+W', enabled: true },
      },
      saveQuery: {
        mac: { combo: 'Meta+W', enabled: true },
        windows: { combo: 'Ctrl+W', enabled: true },
      },
    });

    expect(options.closeActiveTab).toEqual({
      mac: { combo: 'Meta+Shift+W', enabled: false },
      windows: { combo: 'Ctrl+Shift+W', enabled: true },
    });
  });

  it('sanitizes partial platform shortcut bindings without losing defaults', () => {
    const options = sanitizeShortcutOptions({
      newQueryTab: {
        mac: { combo: 'Meta+N', enabled: false },
      },
      sendAIChatMessage: {
        windows: { combo: 'A', enabled: true },
      },
    });

    expect(options.newQueryTab.mac).toEqual({ combo: 'Meta+N', enabled: false });
    expect(options.newQueryTab.windows).toEqual({ combo: 'Ctrl+N', enabled: true });
    expect(options.saveQuery.windows).toEqual({ combo: 'Ctrl+S', enabled: true });
    expect(options.sendAIChatMessage.windows).toEqual({ combo: 'Enter', enabled: true });
  });

  it('registers editor fullscreen toggle as a query editor shortcut without conflicting native fullscreen', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleEditorFullscreen).toEqual({
      mac: { combo: 'Ctrl+F11', enabled: true },
      windows: { combo: 'F11', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.toggleEditorFullscreen).toMatchObject({
      label: '编辑器全屏',
      scope: 'queryEditor',
      allowInEditable: true,
      allowWithoutModifier: true,
    });
    // 验收要求：与既有「切换原生全屏」快捷键不冲突
    for (const platform of ['mac', 'windows'] as const) {
      expect(findEnabledActionConflicts(
        DEFAULT_SHORTCUT_OPTIONS,
        'toggleEditorFullscreen',
        normalizeShortcutCombo(DEFAULT_SHORTCUT_OPTIONS.toggleEditorFullscreen[platform].combo),
        platform,
      )).toEqual([]);
    }
    expect(canRecordShortcutForAction('toggleEditorFullscreen', 'F11')).toBe(true);
    expect(canRecordShortcutForAction('toggleEditorFullscreen', 'Ctrl+F11')).toBe(true);
  });

  it('resolves and displays platform-specific bindings', () => {
    const options = sanitizeShortcutOptions({
      newQueryTab: {
        mac: { combo: 'Meta+N', enabled: true },
        windows: { combo: 'Ctrl+N', enabled: true },
      },
    });

    expect(resolveShortcutBinding(options, 'newQueryTab', 'mac')).toEqual({
      combo: 'Meta+N',
      enabled: true,
    });
    expect(getShortcutDisplayLabel('Meta+N', 'mac')).toBe('⌘N');
    expect(getShortcutDisplayLabel('Meta+Shift+H', 'mac')).toBe('⌘⇧H');
    expect(getShortcutDisplayLabel('Ctrl+Meta+F', 'mac')).toBe('⌃⌘F');
    expect(getShortcutDisplayLabel('Meta+S', 'mac')).toBe('⌘S');
    expect(getShortcutDisplayLabel('Meta+Shift+S', 'mac')).toBe('⌘⇧S');
    expect(getShortcutDisplayLabel('Ctrl+S', 'windows')).toBe('Ctrl+S');
    expect(getShortcutDisplayLabel('Ctrl+Shift+S', 'windows')).toBe('Ctrl+Shift+S');
    expect(getShortcutPrimaryModifierDisplayLabel('mac')).toBe('⌘');
    expect(getShortcutPrimaryModifierDisplayLabel('windows')).toBe('Ctrl');
    expect(getPrimaryShortcutDisplayLabel('C', 'mac')).toBe('⌘C');
    expect(getPrimaryShortcutDisplayLabel('C', 'windows')).toBe('Ctrl+C');
    expect(getPrimaryShortcutDisplayLabel('Enter', 'mac')).toBe('⌘↵');
    expect(getPrimaryShortcutDisplayLabel('Enter', 'windows')).toBe('Ctrl+Enter');
    expect(resolveShortcutDisplay(options, 'newQueryTab', 'windows')).toBe('Ctrl+N');
  });
});

// ─── comboToMonacoKeyBinding ─────────────────────────────────────────

describe('comboToMonacoKeyBinding', () => {
  const mockKeyMod = {
    CtrlCmd: 2048,
    WinCtrl: 256,
    Alt: 512,
    Shift: 1024,
  };

  const mockKeyCode = {
    Enter: 3,
    Tab: 2,
    Escape: 9,
    Space: 10,
    Backspace: 1,
    Delete: 20,
    Home: 14,
    End: 13,
    PageUp: 11,
    PageDown: 12,
    UpArrow: 16,
    DownArrow: 17,
    LeftArrow: 15,
    RightArrow: 18,
    Insert: 19,
    KeyA: 31, KeyB: 32, KeyC: 33, KeyD: 34, KeyE: 35,
    KeyF: 41,
    KeyG: 42, KeyH: 43, KeyK: 47, KeyN: 50, KeyP: 52, KeyR: 54, KeyS: 55,
    Digit0: 21, Digit1: 22, Digit2: 23, Digit3: 24, Digit4: 25,
    Digit5: 26, Digit6: 27, Digit7: 28, Digit8: 29, Digit9: 30,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
    F7: 65, F8: 66, F9: 67, F10: 68, F11: 69, F12: 70,
    // monaco 0.55 真实枚举名与值（Oem 系已被移除，别再用）
    Semicolon: 85, Equal: 86, Comma: 87, Minus: 88, Period: 89,
    Slash: 90, Backquote: 91, BracketLeft: 92, Backslash: 93,
    BracketRight: 94, Quote: 95,
  };

  it('maps Windows Ctrl+Enter to Monaco CtrlCmd', () => {
    expect(comboToMonacoKeyBinding('Ctrl+Enter', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.CtrlCmd,
      keyCode: mockKeyCode.Enter,
    });
  });

  it('maps Windows Ctrl+Shift+R to Monaco CtrlCmd', () => {
    expect(comboToMonacoKeyBinding('Ctrl+Shift+R', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.CtrlCmd | mockKeyMod.Shift,
      keyCode: mockKeyCode.KeyR,
    });
  });

  it('maps Alt+Shift+F correctly', () => {
    expect(comboToMonacoKeyBinding('Alt+Shift+F', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.Alt | mockKeyMod.Shift,
      keyCode: mockKeyCode.KeyF,
    });
  });

  it('maps Meta+Enter (macOS variant)', () => {
    expect(comboToMonacoKeyBinding('Meta+Enter', mockKeyMod, mockKeyCode, 'mac')).toEqual({
      keyMod: mockKeyMod.CtrlCmd,
      keyCode: mockKeyCode.Enter,
    });
  });

  it('maps macOS Ctrl+Enter to Monaco WinCtrl', () => {
    expect(comboToMonacoKeyBinding('Ctrl+Enter', mockKeyMod, mockKeyCode, 'mac')).toEqual({
      keyMod: mockKeyMod.WinCtrl,
      keyCode: mockKeyCode.Enter,
    });
  });

  it('maps Windows Meta+Enter to Monaco WinCtrl', () => {
    expect(comboToMonacoKeyBinding('Meta+Enter', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.WinCtrl,
      keyCode: mockKeyCode.Enter,
    });
  });

  it('maps F2 key', () => {
    expect(comboToMonacoKeyBinding('F2', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: 0,
      keyCode: mockKeyCode.F2,
    });
  });

  it('maps Ctrl+, (comma)', () => {
    expect(comboToMonacoKeyBinding('Ctrl+,', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.CtrlCmd,
      keyCode: mockKeyCode.Comma,
    });
  });

  it('maps Alt+\\ (manual AI completion)', () => {
    expect(comboToMonacoKeyBinding('Alt+\\', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.Alt,
      keyCode: mockKeyCode.Backslash,
    });
  });

  it('returns null for empty combo', () => {
    expect(comboToMonacoKeyBinding('', mockKeyMod, mockKeyCode, 'windows')).toBeNull();
  });

  it('returns null for combo with only modifiers', () => {
    expect(comboToMonacoKeyBinding('Ctrl+Shift', mockKeyMod, mockKeyCode, 'windows')).toBeNull();
  });

  it('maps Ctrl+Digit1', () => {
    expect(comboToMonacoKeyBinding('Ctrl+1', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.CtrlCmd,
      keyCode: mockKeyCode.Digit1,
    });
  });

  it('maps Ctrl+Alt+Delete', () => {
    expect(comboToMonacoKeyBinding('Ctrl+Alt+Delete', mockKeyMod, mockKeyCode, 'windows')).toEqual({
      keyMod: mockKeyMod.CtrlCmd | mockKeyMod.Alt,
      keyCode: mockKeyCode.Delete,
    });
  });
});

// ─── acceptSqlAiCompletion ──────────────────────────────────────────

describe('acceptSqlAiCompletion', () => {
  it('默认绑定为 Tab 且启用(win/mac 一致)', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.acceptSqlAiCompletion.mac).toEqual({ combo: 'Tab', enabled: true });
    expect(DEFAULT_SHORTCUT_OPTIONS.acceptSqlAiCompletion.windows).toEqual({ combo: 'Tab', enabled: true });
  });

  it('允许录制无修饰键的 Tab(裸键场景)', () => {
    expect(canRecordShortcutForAction('acceptSqlAiCompletion', 'Tab')).toBe(true);
  });

  it('允许 Shift+Tab(接受键常为 Tab 相关组合)', () => {
    expect(canRecordShortcutForAction('acceptSqlAiCompletion', 'Shift+Tab')).toBe(true);
  });

  it('允许带修饰键组合(如 Ctrl+Right)', () => {
    expect(canRecordShortcutForAction('acceptSqlAiCompletion', 'Ctrl+Right')).toBe(true);
  });

  it('resolveShortcutBinding 对缺失配置回退默认 Tab', () => {
    const binding = resolveShortcutBinding({}, 'acceptSqlAiCompletion', 'windows');
    expect(binding).toEqual({ combo: 'Tab', enabled: true });
  });
});

// ─── toggleLineComment（#1323 取消/添加注释） ────────────────────────

describe('toggleLineComment shortcut', () => {
  it('registers in the action order and metadata registry', () => {
    expect(SHORTCUT_ACTION_ORDER).toContain('toggleLineComment');
    expect(SHORTCUT_ACTION_META.toggleLineComment).toEqual(expect.objectContaining({
      scope: 'queryEditor',
      allowInEditable: true,
      label: expect.stringContaining('注释'),
    }));
  });

  it('defaults to Ctrl+/ on Windows and Meta+/ on macOS', () => {
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleLineComment.windows).toEqual({ combo: 'Ctrl+/', enabled: true });
    expect(DEFAULT_SHORTCUT_OPTIONS.toggleLineComment.mac).toEqual({ combo: 'Meta+/', enabled: true });
  });

  it('falls back to defaults for users without stored bindings', () => {
    expect(resolveShortcutBinding({} as never, 'toggleLineComment', 'windows')).toEqual({
      combo: 'Ctrl+/',
      enabled: true,
    });
  });

  it('treats Ctrl+/ as non-reserved so the default binding raises no conflict', () => {
    expect(findReservedConflict('Ctrl+/')).toBeNull();
    expect(findReservedConflictsForAction('toggleLineComment', 'Ctrl+/', 'windows')).toEqual([]);
  });

  it('detects rebinding onto the AI diagnose combo as a conflict', () => {
    const windowsBinding = resolveShortcutBinding(
      {
        toggleLineComment: { windows: { combo: 'Ctrl+Shift+A', enabled: true }, mac: { combo: '', enabled: false } },
        diagnoseExecutionError: { windows: { combo: 'Ctrl+Shift+A', enabled: true }, mac: { combo: '', enabled: false } },
      } as never,
      'toggleLineComment',
      'windows',
    );
    expect(windowsBinding.combo).toBe('Ctrl+Shift+A');
    expect(canRecordShortcutForAction('toggleLineComment', 'Ctrl+Shift+A')).toBe(true);
    // 设置中心改键冲突检测：同组合键被「AI 诊断」占用时必须报告冲突
    expect(findEnabledActionConflicts(
      {
        toggleLineComment: { windows: { combo: 'Ctrl+Shift+A', enabled: true }, mac: { combo: '', enabled: false } },
        diagnoseExecutionError: { windows: { combo: 'Ctrl+Shift+A', enabled: true }, mac: { combo: '', enabled: false } },
      } as never,
      'toggleLineComment',
      'Ctrl+Shift+A',
      'windows',
    )).toEqual(['diagnoseExecutionError']);
  });

  it('maps the default combos to Monaco key bindings using the real 0.55 enum names', () => {
    const kc = { Slash: 90 };
    expect(comboToMonacoKeyBinding('Ctrl+/', { CtrlCmd: 2, Shift: 4, Alt: 8 }, kc, 'windows')).toEqual({
      keyMod: 2,
      keyCode: 90,
    });
    expect(comboToMonacoKeyBinding('Meta+/', { CtrlCmd: 2, Shift: 4, Alt: 8 }, kc, 'mac')).toEqual({
      keyMod: 2,
      keyCode: 90,
    });
    // 已废弃的 Oem 枚举名在 monaco 0.55 中为 undefined，映射必须返回 null
    expect(comboToMonacoKeyBinding('Ctrl+Oem2', { CtrlCmd: 2, Shift: 4, Alt: 8 }, kc, 'windows')).toBeNull();
  });
});
