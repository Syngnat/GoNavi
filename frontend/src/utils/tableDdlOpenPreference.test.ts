// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readTableDdlOpenOnClick,
  resetTableDdlOpenPreferenceForTests,
  subscribeTableDdlOpenOnClick,
  writeTableDdlOpenOnClick,
} from './tableDdlOpenPreference';

describe('table DDL open preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTableDdlOpenPreferenceForTests();
  });

  it('defaults to off', () => {
    expect(readTableDdlOpenOnClick()).toBe(false);
  });

  it('persists the toggle and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTableDdlOpenOnClick(listener);

    writeTableDdlOpenOnClick(true);

    expect(readTableDdlOpenOnClick()).toBe(true);
    expect(window.localStorage.getItem('gonavi.sidebar.openTableDdlOnClick')).toBe('1');
    expect(listener).toHaveBeenCalledWith(true);

    writeTableDdlOpenOnClick(false);
    expect(readTableDdlOpenOnClick()).toBe(false);
    expect(window.localStorage.getItem('gonavi.sidebar.openTableDdlOnClick')).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(false);
    unsubscribe();
  });
});
