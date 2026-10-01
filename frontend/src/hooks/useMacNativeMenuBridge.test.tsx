import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const emitted: Array<[string, unknown[]]> = [];

vi.mock('../../wailsjs/runtime', () => ({
  EventsOn: (name: string, callback: (...args: unknown[]) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(callback);
    listeners.set(name, set);
    return () => set.delete(callback);
  },
  EventsEmit: (name: string, ...args: unknown[]) => {
    emitted.push([name, args]);
  },
}));

import { MAC_NATIVE_MENU_EVENTS, useMacNativeMenuBridge, type MacNativeMenuBridgeOptions } from './useMacNativeMenuBridge';

const fire = (name: string) => listeners.get(name)?.forEach((callback) => callback());
const listenerCount = () => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0);

function Harness(props: MacNativeMenuBridgeOptions) {
  useMacNativeMenuBridge(props);
  return null;
}

afterEach(() => {
  listeners.clear();
  emitted.length = 0;
});

describe('useMacNativeMenuBridge', () => {
  it('routes native menu clicks to the latest handlers and syncs the language', () => {
    const first = { onOpenPreferences: vi.fn(), onToggleTheme: vi.fn(), onOpenThemeSettings: vi.fn(), onOpenDrivers: vi.fn(), onCheckUpdate: vi.fn(), onOpenAbout: vi.fn() };
    const second = { onOpenPreferences: vi.fn(), onToggleTheme: vi.fn(), onOpenThemeSettings: vi.fn(), onOpenDrivers: vi.fn(), onCheckUpdate: vi.fn(), onOpenAbout: vi.fn() };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Harness enabled language="zh-CN" themeMode="light" {...first} />);
    });
    // 首次挂载：语言与主题模式都同步给原生菜单。
    expect(emitted).toEqual([
      [MAC_NATIVE_MENU_EVENTS.language, ['zh-CN']],
      [MAC_NATIVE_MENU_EVENTS.theme, ['light']],
    ]);
    expect(listenerCount()).toBe(6);

    // 父组件重渲染换了新回调：不重新订阅，但点击走最新回调。
    act(() => {
      renderer.update(<Harness enabled language="en-US" themeMode="dark" {...second} />);
    });
    expect(listenerCount()).toBe(6);
    expect(emitted.slice(-2)).toEqual([
      [MAC_NATIVE_MENU_EVENTS.language, ['en-US']],
      [MAC_NATIVE_MENU_EVENTS.theme, ['dark']],
    ]);

    fire(MAC_NATIVE_MENU_EVENTS.openPreferences);
    fire(MAC_NATIVE_MENU_EVENTS.toggleTheme);
    fire(MAC_NATIVE_MENU_EVENTS.openThemeSettings);
    fire(MAC_NATIVE_MENU_EVENTS.openDrivers);
    fire(MAC_NATIVE_MENU_EVENTS.checkUpdate);
    fire(MAC_NATIVE_MENU_EVENTS.openAbout);
    expect(first.onOpenPreferences).not.toHaveBeenCalled();
    expect(first.onOpenDrivers).not.toHaveBeenCalled();
    expect(second.onOpenPreferences).toHaveBeenCalledTimes(1);
    expect(second.onToggleTheme).toHaveBeenCalledTimes(1);
    expect(first.onOpenThemeSettings).not.toHaveBeenCalled();
    expect(second.onOpenThemeSettings).toHaveBeenCalledTimes(1);
    expect(second.onOpenDrivers).toHaveBeenCalledTimes(1);
    expect(first.onCheckUpdate).not.toHaveBeenCalled();
    expect(second.onCheckUpdate).toHaveBeenCalledTimes(1);
    expect(second.onOpenAbout).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    expect(listenerCount()).toBe(0);
  });

  it('re-syncs the theme mode to the native menu only when it actually changes', () => {
    const handlers = { onOpenPreferences: vi.fn(), onToggleTheme: vi.fn(), onOpenThemeSettings: vi.fn(), onOpenDrivers: vi.fn(), onCheckUpdate: vi.fn(), onOpenAbout: vi.fn() };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Harness enabled language="zh-CN" themeMode="light" {...handlers} />);
    });
    const themeEmits = () => emitted.filter(([name]) => name === MAC_NATIVE_MENU_EVENTS.theme);
    expect(themeEmits()).toEqual([[MAC_NATIVE_MENU_EVENTS.theme, ['light']]]);

    // 重渲染但模式没变：不重复发事件。
    act(() => {
      renderer.update(<Harness enabled language="zh-CN" themeMode="light" {...handlers} />);
    });
    expect(themeEmits()).toHaveLength(1);

    // 用户切到暗色（无论从菜单、标题栏还是快捷键）：菜单标签随之校正。
    act(() => {
      renderer.update(<Harness enabled language="zh-CN" themeMode="dark" {...handlers} />);
    });
    expect(themeEmits()).toEqual([
      [MAC_NATIVE_MENU_EVENTS.theme, ['light']],
      [MAC_NATIVE_MENU_EVENTS.theme, ['dark']],
    ]);
  });

  it('does nothing outside the macOS desktop runtime', () => {
    act(() => {
      create(<Harness enabled={false} language="zh-CN" themeMode="light" onOpenThemeSettings={vi.fn()} onOpenPreferences={vi.fn()} onToggleTheme={vi.fn()} onOpenDrivers={vi.fn()} onCheckUpdate={vi.fn()} onOpenAbout={vi.fn()} />);
    });
    expect(listenerCount()).toBe(0);
    expect(emitted).toEqual([]);
  });
});
