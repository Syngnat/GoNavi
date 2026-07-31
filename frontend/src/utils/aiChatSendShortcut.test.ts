import { describe, expect, it, vi } from 'vitest';

import {
  canRecordShortcutForAction,
  DEFAULT_SHORTCUT_OPTIONS,
  SHORTCUT_ACTION_META,
  SHORTCUT_ACTION_ORDER,
  type ShortcutPlatformBinding,
} from './shortcuts';
import {
  consumeAIChatSendShortcutOnKeyDown,
  getAIChatSendShortcutLabel,
  shouldSendAIChatOnKeyDown,
} from './aiChatSendShortcut';

const binding = (combo: string, enabled = true): ShortcutPlatformBinding => ({ combo, enabled });

describe('aiChatSendShortcut', () => {
  it('registers AI chat send in the shared shortcut center with Enter default', () => {
    expect(SHORTCUT_ACTION_ORDER).toContain('sendAIChatMessage');
    expect(DEFAULT_SHORTCUT_OPTIONS.sendAIChatMessage).toEqual({
      mac: { combo: 'Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });
    expect(SHORTCUT_ACTION_META.sendAIChatMessage).toMatchObject({
      label: 'Send AI Chat',
      allowInEditable: true,
      allowWithoutModifier: true,
      scope: 'aiComposer',
      requiredKey: 'Enter',
      disallowShift: true,
    });
  });

  it('allows recording only single-modifier Enter-based AI send shortcuts', () => {
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Enter')).toBe(true);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Meta+Enter')).toBe(true);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Ctrl+Enter')).toBe(true);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Alt+Enter')).toBe(true);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'A')).toBe(false);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Shift+Enter')).toBe(false);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Ctrl+Shift+Enter')).toBe(false);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Ctrl+Alt+Enter')).toBe(false);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Ctrl+Meta+Enter')).toBe(false);
    expect(canRecordShortcutForAction('sendAIChatMessage', 'Meta+Alt+Enter')).toBe(false);
  });

  it('keeps modifier requirements for global shortcuts', () => {
    expect(canRecordShortcutForAction('runQuery', 'Enter')).toBe(false);
    expect(canRecordShortcutForAction('runQuery', 'Ctrl+Enter')).toBe(true);
  });

  it('sends on the configured Enter shortcut but never during composition or Shift+Enter', () => {
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter' })).toBe(true);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', isComposing: true })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', keyCode: 229 })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', which: 229 })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter'), { key: 'a' })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Enter', false), { key: 'Enter' })).toBe(false);
  });

  it('matches recorded Cmd or Ctrl Enter shortcuts', () => {
    expect(shouldSendAIChatOnKeyDown(binding('Meta+Enter'), { key: 'Enter' })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Meta+Enter'), { key: 'Enter', metaKey: true })).toBe(true);
    expect(shouldSendAIChatOnKeyDown(binding('Meta+Enter'), { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Ctrl+Enter'), { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(shouldSendAIChatOnKeyDown(binding('Ctrl+Enter'), { key: 'Enter', metaKey: true })).toBe(false);
    expect(shouldSendAIChatOnKeyDown(binding('Ctrl+Enter'), { key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false);
  });

  it('does not allow Shift to become an AI send shortcut even if a stale binding exists', () => {
    expect(shouldSendAIChatOnKeyDown(binding('Shift+Enter'), { key: 'Enter', shiftKey: true })).toBe(false);
    expect(getAIChatSendShortcutLabel(binding('Meta+Enter'))).toBe('Meta+Enter to send');
    expect(getAIChatSendShortcutLabel(binding('Meta+Enter'), 'mac')).toBe('⌘↵ to send');
    expect(getAIChatSendShortcutLabel(binding('Enter', false))).toBe('Shortcut sending disabled');
  });

  it('uses the provided translator for the shortcut hint chrome while keeping the shortcut raw', () => {
    const translate = (key: string, params?: Record<string, string>) => `t:${key}:${params?.shortcut || ''}`;

    expect(getAIChatSendShortcutLabel(binding('Meta+Enter'), 'windows', translate)).toBe(
      't:ai_chat.input.shortcut.send_with_combo:Meta+Enter',
    );
    expect(getAIChatSendShortcutLabel(binding('Enter', false), 'windows', translate)).toBe(
      't:ai_chat.input.shortcut.disabled:',
    );
  });

  it('stops propagation after consuming the configured AI send shortcut', () => {
    const event = {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const onSend = vi.fn();

    expect(consumeAIChatSendShortcutOnKeyDown(binding('Meta+Enter'), event, onSend)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
