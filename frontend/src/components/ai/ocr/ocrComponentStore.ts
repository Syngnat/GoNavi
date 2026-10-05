import React from 'react';

import {
  cancelOcrInstall,
  fetchOcrStatus,
  installOcrComponent,
  isOcrSupported,
  removeOcrComponent,
  subscribeOcrInstallProgress,
  type OcrComponentStatus,
} from './ocrComponentClient';

/**
 * What the composer, the approval prompt and the settings page share about the
 * recognition component: whether it is installed, how an installation is going, and
 * whether the person has been asked yet. A small store of its own (not the app's
 * large one): it has nothing to do with the rest of the workspace.
 */

export type OcrInstallPhase = 'idle' | 'installing' | 'failed';

export interface OcrComponentState {
  /** Null until it has been asked for once. */
  status: OcrComponentStatus | null;
  phase: OcrInstallPhase;
  percent: number;
  currentFile: string;
  /** Why the last installation or removal failed. */
  error: string;
  promptOpen: boolean;
}

const INITIAL: OcrComponentState = { status: null, phase: 'idle', percent: 0, currentFile: '', error: '', promptOpen: false };

let state: OcrComponentState = INITIAL;
const listeners = new Set<() => void>();

const setState = (patch: Partial<OcrComponentState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const getOcrComponentState = (): OcrComponentState => state;

export const subscribeOcrComponentState = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useOcrComponentState = (): OcrComponentState => React.useSyncExternalStore(
  subscribeOcrComponentState, getOcrComponentState, getOcrComponentState,
);

/** Back to the start (tests). */
export const resetOcrComponentStore = () => {
  declined.clear();
  waiters.length = 0;
  state = INITIAL;
  listeners.forEach((listener) => listener());
};

// ---- the person's answer to "install it?" ---------------------------------------

const DECLINED_KEY = 'gonavi.ocr.install_prompt';
const declined = {
  get: (): boolean => {
    try { return globalThis.localStorage?.getItem(DECLINED_KEY) === 'declined'; } catch { return false; }
  },
  set: () => { try { globalThis.localStorage?.setItem(DECLINED_KEY, 'declined'); } catch { /* not persisted */ } },
  clear: () => { try { globalThis.localStorage?.removeItem(DECLINED_KEY); } catch { /* nothing to clear */ } },
};

/** Whether the person said no to the first-use prompt (so it is not shown again on its own). */
export const hasDeclinedOcrInstall = (): boolean => declined.get();

// ---- status and installation ----------------------------------------------------

export const refreshOcrStatus = async (): Promise<OcrComponentStatus | null> => {
  if (!isOcrSupported()) return null;
  const result = await fetchOcrStatus();
  if (result.status) setState({ status: result.status });
  return result.status ?? state.status;
};

let progressStop: (() => void) | null = null;

/** Installs the component. Resolves true once it is installed. */
export const installOcr = async (): Promise<boolean> => {
  if (state.phase === 'installing') return false;
  setState({ phase: 'installing', percent: 0, currentFile: '', error: '' });
  progressStop?.();
  progressStop = subscribeOcrInstallProgress((progress) => setState({ percent: progress.percent, currentFile: progress.file ?? '' }));
  try {
    const result = await installOcrComponent();
    if (result.ok && result.status?.installed) {
      declined.clear();
      setState({ status: result.status, phase: 'idle', percent: 100, error: '' });
      return true;
    }
    // A canceled installation is the person's own doing, not a failure to report.
    setState({ status: result.status ?? state.status, phase: result.status?.canceled ? 'idle' : 'failed', percent: 0, error: result.status?.canceled ? '' : result.message });
    return false;
  } finally {
    progressStop?.();
    progressStop = null;
  }
};

export const cancelOcr = async (): Promise<void> => {
  await cancelOcrInstall();
};

/** Removes the component. Resolves true once it is gone. */
export const removeOcr = async (): Promise<boolean> => {
  const result = await removeOcrComponent();
  if (result.ok) {
    setState({ status: result.status ?? (state.status ? { ...state.status, installed: false } : null), error: '' });
    return true;
  }
  setState({ error: result.message });
  return false;
};

// ---- the approval prompt ----------------------------------------------------------

const waiters: Array<(approved: boolean) => void> = [];

const closePrompt = (approved: boolean) => {
  setState({ promptOpen: false, phase: state.phase === 'failed' ? 'idle' : state.phase, error: '' });
  waiters.splice(0).forEach((resolve) => resolve(approved));
};

/** Opens the approval prompt and resolves true once the person has had the component installed. */
export const requestOcrInstallApproval = (): Promise<boolean> => new Promise<boolean>((resolve) => {
  waiters.push(resolve);
  setState({ promptOpen: true, error: '', phase: state.phase === 'installing' ? 'installing' : 'idle' });
  void refreshOcrStatus();
});

/** "Install and recognize": installs, and closes the prompt only when it worked, so a failure can be retried there. */
export const approveOcrInstall = async (): Promise<void> => {
  if (await installOcr()) closePrompt(true);
};

/** "Not now": remembered, so the prompt does not come back by itself; the person can still ask for it. */
export const declineOcrInstall = (): void => {
  if (state.phase === 'installing') void cancelOcr();
  declined.set();
  closePrompt(false);
};

export type OcrReadiness = 'ready' | 'needs_install';

/**
 * Makes the component available for an image. The first time, the person is asked;
 * after a "not now" it is only asked for again when `interactive` (the person
 * clicked something that needs it).
 */
export const ensureOcrComponent = async (interactive: boolean): Promise<OcrReadiness> => {
  const status = await refreshOcrStatus();
  if (status?.installed) return 'ready';
  if (!interactive && hasDeclinedOcrInstall()) return 'needs_install';
  return (await requestOcrInstallApproval()) ? 'ready' : 'needs_install';
};
