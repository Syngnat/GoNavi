import { describe, expect, it, vi } from 'vitest';
import { CUSTOM_THEME_STYLE_ID, type CustomThemeDefinition } from '../../utils/customTheme';
import {
  installCustomThemeRecoveryShortcut,
  isCustomThemeRecoveryShortcut,
  shouldReloadCustomThemesForStorageEvent,
  syncCustomThemeStyle,
} from './CustomThemeStyleHost';

const buildTheme = (id: string, css: string): CustomThemeDefinition => ({
  schemaVersion: 1,
  id,
  name: id,
  sourceFileName: `${id}.css`,
  baseMode: 'dark',
  css,
  createdAt: 1,
  updatedAt: 1,
});

const createFakeDocument = () => {
  const attributes = new Map<string, string>();
  let style: any = null;
  let appendCount = 0;
  const documentRef = {
    body: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
    head: {
      appendChild: (node: any) => {
        style = node;
        node.isConnected = true;
        appendCount += 1;
      },
    },
    getElementById: (id: string) => id === CUSTOM_THEME_STYLE_ID ? style : null,
    createElement: () => {
      const node: any = {
        tagName: 'STYLE',
        isConnected: false,
        attributes: new Map<string, string>(),
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        remove() {
          this.isConnected = false;
          style = null;
        },
      };
      return node;
    },
  };
  return {
    documentRef: documentRef as unknown as Document,
    attributes,
    getStyle: () => style,
    getAppendCount: () => appendCount,
  };
};

describe('CustomThemeStyleHost runtime', () => {
  it('uses one style element, updates textContent, and cleans body state', () => {
    const fake = createFakeDocument();
    syncCustomThemeStyle(buildTheme('theme-one', 'body { color: red; }'), fake.documentRef);
    expect(fake.getStyle().textContent).toContain('body { color: red; }');
    expect(fake.getStyle().textContent).toContain('--gn-monaco-bg: var(--gn-bg-panel)');
    expect(fake.attributes.get('data-custom-theme')).toBe('active');
    expect(fake.attributes.get('data-custom-theme-id')).toBe('theme-one');
    expect(fake.getAppendCount()).toBe(1);

    syncCustomThemeStyle(buildTheme('theme-two', 'body { color: blue; }'), fake.documentRef);
    expect(fake.getStyle().textContent).toContain('body { color: blue; }');
    expect(fake.getStyle().textContent).toContain('--gn-monaco-bg: var(--gn-bg-panel)');
    expect(fake.attributes.get('data-custom-theme-id')).toBe('theme-two');
    expect(fake.getAppendCount()).toBe(1);

    syncCustomThemeStyle(null, fake.documentRef);
    expect(fake.getStyle()).toBeNull();
    expect(fake.attributes.has('data-custom-theme')).toBe(false);
    expect(fake.attributes.has('data-custom-theme-id')).toBe(false);
  });

  it('keeps a fixed recovery shortcut independent of editable targets and custom bindings', () => {
    const event = {
      altKey: false,
      code: 'KeyD',
      ctrlKey: true,
      isComposing: false,
      key: 'd',
      metaKey: false,
      shiftKey: true,
    };
    expect(isCustomThemeRecoveryShortcut(event)).toBe(true);
    expect(isCustomThemeRecoveryShortcut({ ...event, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isCustomThemeRecoveryShortcut({ ...event, shiftKey: false })).toBe(false);
    expect(isCustomThemeRecoveryShortcut({ ...event, altKey: true })).toBe(false);
    expect(isCustomThemeRecoveryShortcut({ ...event, isComposing: true })).toBe(false);
  });

  it('installs the recovery shortcut in capture phase and stops other handlers', () => {
    let listener: EventListener | null = null;
    let capture: boolean | AddEventListenerOptions | undefined;
    const removeEventListener = vi.fn();
    const target = {
      addEventListener: (_type: string, nextListener: EventListener, options?: boolean | AddEventListenerOptions) => {
        listener = nextListener;
        capture = options;
      },
      removeEventListener,
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const deactivate = vi.fn();
    const cleanup = installCustomThemeRecoveryShortcut(deactivate, target);
    const keyboardEvent = {
      altKey: false,
      code: 'KeyD',
      ctrlKey: true,
      isComposing: false,
      key: 'd',
      metaKey: false,
      shiftKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(capture).toBe(true);
    const registeredListener = listener as EventListener | null;
    expect(registeredListener).not.toBeNull();
    if (!registeredListener) throw new Error('Recovery listener was not registered');
    registeredListener(keyboardEvent);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(keyboardEvent.preventDefault).toHaveBeenCalledOnce();
    expect(keyboardEvent.stopImmediatePropagation).toHaveBeenCalledOnce();

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('reloads themes for the custom key and localStorage.clear events', () => {
    expect(shouldReloadCustomThemesForStorageEvent('gonavi-custom-themes-v1')).toBe(true);
    expect(shouldReloadCustomThemesForStorageEvent(null)).toBe(true);
    expect(shouldReloadCustomThemesForStorageEvent('unrelated-key')).toBe(false);
  });
});
