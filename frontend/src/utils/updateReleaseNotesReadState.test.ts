import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReleaseNotesReadKey,
  clearReleaseNotesReadState,
  isReleaseNotesRead,
  loadReadReleaseNotesKeys,
  markReleaseNotesRead,
} from './updateReleaseNotesReadState';

describe('updateReleaseNotesReadState', () => {
  let memory: Record<string, string>;

  beforeEach(() => {
    memory = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key in memory ? memory[key] : null),
      setItem: (key: string, value: string) => {
        memory[key] = String(value);
      },
      removeItem: (key: string) => {
        delete memory[key];
      },
    });
    clearReleaseNotesReadState();
  });

  afterEach(() => {
    clearReleaseNotesReadState();
    vi.unstubAllGlobals();
  });

  it('builds stable channel:version keys', () => {
    expect(buildReleaseNotesReadKey({ channel: 'Latest', latestVersion: '0.9.0' })).toBe('latest:0.9.0');
    expect(buildReleaseNotesReadKey({ channel: 'dev', latestVersion: 'dev-abc1234' })).toBe('dev:dev-abc1234');
    expect(buildReleaseNotesReadKey({ latestVersion: '' })).toBe('');
  });

  it('marks and loads read keys from localStorage', () => {
    expect(isReleaseNotesRead('latest:0.9.0')).toBe(false);
    expect(markReleaseNotesRead('latest:0.9.0')).toBe(true);
    expect(markReleaseNotesRead('latest:0.9.0')).toBe(false);
    expect(isReleaseNotesRead('latest:0.9.0')).toBe(true);
    expect(loadReadReleaseNotesKeys().has('latest:0.9.0')).toBe(true);
  });
});
