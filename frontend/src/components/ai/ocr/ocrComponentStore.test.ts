import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  fetchOcrStatus: vi.fn(),
  installOcrComponent: vi.fn(),
  cancelOcrInstall: vi.fn(),
  removeOcrComponent: vi.fn(),
  subscribeOcrInstallProgress: vi.fn(),
  isOcrSupported: vi.fn(() => true),
}));

vi.mock('./ocrComponentClient', () => client);

import {
  approveOcrInstall,
  declineOcrInstall,
  ensureOcrComponent,
  getOcrComponentState,
  hasDeclinedOcrInstall,
  installOcr,
  refreshOcrStatus,
  removeOcr,
  requestOcrInstallApproval,
  resetOcrComponentStore,
} from './ocrComponentStore';

const status = (installed: boolean, extra: Record<string, unknown> = {}) => ({
  installed, installing: false, version: 'v1', languages: ['eng'], sizeBytes: 12_000_000, path: '/data/ocr/current', ...extra,
});
const ok = (installed: boolean, extra: Record<string, unknown> = {}) => ({ ok: true, message: '', status: status(installed, extra) });

let progressListener: ((progress: { percent: number; file?: string }) => void) | null = null;

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  Object.values(client).forEach((fn) => 'mockReset' in fn && fn.mockReset());
  client.isOcrSupported.mockReturnValue(true);
  client.cancelOcrInstall.mockResolvedValue({ ok: true, message: '' });
  client.subscribeOcrInstallProgress.mockImplementation((listener) => { progressListener = listener; return () => { progressListener = null; }; });
  resetOcrComponentStore();
});

describe('status', () => {
  it('is fetched into the store, and left alone where the component cannot be used', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(false));
    expect((await refreshOcrStatus())?.installed).toBe(false);
    expect(getOcrComponentState().status?.sizeBytes).toBe(12_000_000);

    resetOcrComponentStore();
    client.isOcrSupported.mockReturnValue(false);
    expect(await refreshOcrStatus()).toBeNull();
    expect(client.fetchOcrStatus).toHaveBeenCalledTimes(1);
  });
});

describe('installing', () => {
  it('shows progress while it runs and remembers nothing against the person once it is done', async () => {
    let finish: (value: unknown) => void = () => undefined;
    client.installOcrComponent.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const done = installOcr();
    expect(getOcrComponentState().phase).toBe('installing');
    progressListener?.({ percent: 42, file: 'core/tesseract-core-simd-lstm.wasm.js' });
    expect(getOcrComponentState()).toMatchObject({ percent: 42, currentFile: 'core/tesseract-core-simd-lstm.wasm.js' });
    finish(ok(true));
    expect(await done).toBe(true);
    expect(getOcrComponentState()).toMatchObject({ phase: 'idle', percent: 100, error: '' });
    expect(getOcrComponentState().status?.installed).toBe(true);
    expect(progressListener).toBeNull(); // no longer listening
  });

  it('reports a failure so it can be retried', async () => {
    client.installOcrComponent.mockResolvedValue({ ok: false, message: 'checksum mismatch', status: status(false) });
    expect(await installOcr()).toBe(false);
    expect(getOcrComponentState()).toMatchObject({ phase: 'failed', error: 'checksum mismatch' });
  });

  it('does not call a cancel by the person a failure', async () => {
    client.installOcrComponent.mockResolvedValue({ ok: false, message: 'Installation canceled.', status: status(false, { canceled: true }) });
    expect(await installOcr()).toBe(false);
    expect(getOcrComponentState()).toMatchObject({ phase: 'idle', error: '' });
  });

  it('ignores a second request while one runs', async () => {
    client.installOcrComponent.mockReturnValue(new Promise(() => undefined));
    void installOcr();
    expect(await installOcr()).toBe(false);
    expect(client.installOcrComponent).toHaveBeenCalledTimes(1);
  });

  it('can be removed again', async () => {
    client.removeOcrComponent.mockResolvedValue(ok(false));
    expect(await removeOcr()).toBe(true);
    expect(getOcrComponentState().status?.installed).toBe(false);
    client.removeOcrComponent.mockResolvedValue({ ok: false, message: 'busy' });
    expect(await removeOcr()).toBe(false);
    expect(getOcrComponentState().error).toBe('busy');
  });
});

describe('the approval prompt', () => {
  it('opens, and closes only when the install worked, so a failure can be retried in it', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(false));
    const answer = requestOcrInstallApproval();
    expect(getOcrComponentState().promptOpen).toBe(true);

    client.installOcrComponent.mockResolvedValueOnce({ ok: false, message: 'network down', status: status(false) });
    await approveOcrInstall();
    expect(getOcrComponentState()).toMatchObject({ promptOpen: true, phase: 'failed', error: 'network down' });

    client.installOcrComponent.mockResolvedValueOnce(ok(true));
    await approveOcrInstall();
    expect(getOcrComponentState().promptOpen).toBe(false);
    expect(await answer).toBe(true);
  });

  it('answers everyone who asked while it was open', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(false));
    const first = requestOcrInstallApproval();
    const second = requestOcrInstallApproval();
    declineOcrInstall();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(getOcrComponentState().promptOpen).toBe(false);
  });

  it('stops a download that is running when the person says not now', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(false));
    client.installOcrComponent.mockReturnValue(new Promise(() => undefined));
    const answer = requestOcrInstallApproval();
    void approveOcrInstall();
    declineOcrInstall();
    expect(client.cancelOcrInstall).toHaveBeenCalled();
    expect(await answer).toBe(false);
  });
});

describe('ensureOcrComponent', () => {
  it('is ready without asking when the component is installed', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(true));
    expect(await ensureOcrComponent(false)).toBe('ready');
    expect(getOcrComponentState().promptOpen).toBe(false);
  });

  it('asks the first time, and does not ask again by itself after a "not now"', async () => {
    client.fetchOcrStatus.mockResolvedValue(ok(false));
    const first = ensureOcrComponent(false);
    await vi.waitFor(() => expect(getOcrComponentState().promptOpen).toBe(true));
    declineOcrInstall();
    expect(await first).toBe('needs_install');
    expect(hasDeclinedOcrInstall()).toBe(true);

    // Later images are not nagged about...
    expect(await ensureOcrComponent(false)).toBe('needs_install');
    expect(getOcrComponentState().promptOpen).toBe(false);
    // ...but a click that asks for it brings the prompt back.
    const asked = ensureOcrComponent(true);
    await vi.waitFor(() => expect(getOcrComponentState().promptOpen).toBe(true));
    client.installOcrComponent.mockResolvedValue(ok(true));
    await approveOcrInstall();
    expect(await asked).toBe('ready');
    expect(hasDeclinedOcrInstall()).toBe(false); // installing clears the "no"
  });
});
