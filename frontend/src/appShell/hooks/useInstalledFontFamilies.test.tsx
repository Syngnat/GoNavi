import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListInstalledFontFamilies } from '../../../wailsjs/go/app/App';
import { useInstalledFontFamilies } from './useInstalledFontFamilies';
vi.mock('../../../wailsjs/go/app/App', () => ({ ListInstalledFontFamilies: vi.fn() }));
const list = vi.mocked(ListInstalledFontFamilies) as any;
type Props = Parameters<typeof useInstalledFontFamilies>[0];
const Probe = (props: Props) => { useInstalledFontFamilies(props); return null; };
const input = (): Props => ({
  activePane: 'fonts-settings', runtimePlatform: 'darwin', isThemeModalOpen: false, themeModalSection: 'theme',
  hasLoadedInstalledFontsRef: { current: false }, setIsFontFamiliesLoading: vi.fn(),
  setFontFamiliesLoadError: vi.fn(), setInstalledFontFamilies: vi.fn(), t: key => key,
});
const result = { success: true, data: [{ family: 'JetBrainsMono Nerd Font Mono' }], message: '' };
beforeEach(() => { list.mockReset(); list.mockResolvedValue(result); });
describe('installed font loading lifecycle', () => {
  it.each(['darwin', 'windows'])('loads the new font settings page on %s regardless of legacy section', async runtimePlatform => {
    const props = { ...input(), runtimePlatform };
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe {...props} />); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(props.setInstalledFontFamilies).toHaveBeenCalledWith([{ family: 'JetBrainsMono Nerd Font Mono', path: undefined }]);
    expect(props.hasLoadedInstalledFontsRef.current).toBe(true);
    act(() => view.unmount());
  });
  it('does not scan on unrelated macOS settings pages', async () => {
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe {...input()} activePane="common-settings" />); });
    expect(list).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('retains Linux startup and legacy appearance loading', async () => {
    for (const props of [{ ...input(), runtimePlatform: 'linux', activePane: undefined }, { ...input(), activePane: 'theme' as const, themeModalSection: 'appearance' }]) {
      let view!: ReturnType<typeof create>;
      await act(async () => { view = create(<Probe {...props} />); });
      expect(props.hasLoadedInstalledFontsRef.current).toBe(true);
      act(() => view.unmount());
    }
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('resubscribes when leaving and reentering while a scan is pending', async () => {
    let resolve!: (value: any) => void;
    list.mockReturnValue(new Promise(done => { resolve = done; }));
    const props = input();
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe {...props} />); });
    act(() => view.update(<Probe {...props} activePane="common-settings" />));
    act(() => view.update(<Probe {...props} />));
    await act(async () => { resolve(result); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(props.hasLoadedInstalledFontsRef.current).toBe(true);
    expect(props.setIsFontFamiliesLoading).toHaveBeenLastCalledWith(false);
    act(() => view.unmount());
  });
  it('can retry a failed scan on reentry without a render retry loop', async () => {
    list.mockRejectedValueOnce(new Error('scan failed'));
    const props = input();
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe {...props} />); });
    expect(props.setFontFamiliesLoadError).toHaveBeenLastCalledWith('scan failed');
    expect(props.hasLoadedInstalledFontsRef.current).toBe(false);
    act(() => view.update(<Probe {...props} activePane="common-settings" />));
    await act(async () => view.update(<Probe {...props} />));
    expect(props.hasLoadedInstalledFontsRef.current).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    act(() => view.unmount());
  });
});
