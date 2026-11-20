/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useScriptLibrary } from './useScriptLibrary';
import { ScriptWorkbenchRequestError } from './scriptWorkbenchErrors';
import type {
  ScriptLibrarySnapshot,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';

const snapshot: ScriptLibrarySnapshot = {
  owner: 'local',
  scripts: [],
  folders: [],
  canWrite: true,
  canShare: true,
  sharedOnly: false,
};

describe('useScriptLibrary', () => {
  it('exposes a retry after an initial permission failure', async () => {
    const adapter = {
      listLibrary: vi.fn()
        .mockRejectedValueOnce(new ScriptWorkbenchRequestError('forbidden', 'forbidden'))
        .mockResolvedValueOnce(snapshot),
    } as unknown as ScriptWorkbenchAdapter;
    let api!: ReturnType<typeof useScriptLibrary>;
    const Probe: React.FC = () => {
      api = useScriptLibrary(adapter, (error) => (
        error instanceof Error ? error.message : String(error)
      ));
      return null;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.error).toBe('forbidden');
    expect(api.errorCode).toBe('forbidden');
    await act(async () => {
      await api.refresh();
    });
    expect(api.error).toBe('');
    expect(api.snapshot).toEqual(snapshot);
    act(() => renderer.unmount());
  });
});
