import React from 'react';

/**
 * The usage rules shown before the first sign-in to the built-in AI, and whether the person
 * has accepted them. The acceptance is kept on this device with the version of the text that
 * was shown: when the rules change in a way that matters, raise the version and everyone is
 * asked once more at their next sign-in.
 *
 * A small store of its own (not the app's large one): it has nothing to do with the
 * workspace, and the prompt can be asked for from the settings page and from the chat panel.
 */
export const BUILTIN_AI_TERMS_VERSION = 1;
export const BUILTIN_AI_TERMS_STORAGE_KEY = 'gonavi-builtin-ai-terms';

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked outright; the rules are then shown at every sign-in.
    return null;
  }
};

/** The version of the rules last accepted on this device; 0 when none. */
export const readAcceptedBuiltinAITermsVersion = (storage: Storage | null = defaultStorage()): number => {
  try {
    const parsed = JSON.parse(storage?.getItem(BUILTIN_AI_TERMS_STORAGE_KEY) ?? 'null') as { version?: unknown } | null;
    const version = Number(parsed?.version);
    return Number.isInteger(version) && version > 0 ? version : 0;
  } catch {
    return 0;
  }
};

export const hasAcceptedBuiltinAITerms = (storage: Storage | null = defaultStorage()): boolean => (
  readAcceptedBuiltinAITermsVersion(storage) >= BUILTIN_AI_TERMS_VERSION
);

interface PromptState {
  promptOpen: boolean;
}

let state: PromptState = { promptOpen: false };
let waiters: Array<(accepted: boolean) => void> = [];
const listeners = new Set<() => void>();

const setPromptOpen = (promptOpen: boolean) => {
  state = { promptOpen };
  listeners.forEach((listener) => listener());
};

const settle = (accepted: boolean) => {
  const pending = waiters;
  waiters = [];
  setPromptOpen(false);
  pending.forEach((resolve) => resolve(accepted));
};

/**
 * Resolves true once the rules are accepted: at once if this device already accepted this
 * version, otherwise after the person answers the prompt. Callers asking while the prompt is
 * open share its answer.
 */
export const requestBuiltinAITerms = (storage: Storage | null = defaultStorage()): Promise<boolean> => {
  if (hasAcceptedBuiltinAITerms(storage)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve);
    if (!state.promptOpen) setPromptOpen(true);
  });
};

export const acceptBuiltinAITerms = (storage: Storage | null = defaultStorage()): void => {
  try {
    storage?.setItem(BUILTIN_AI_TERMS_STORAGE_KEY, JSON.stringify({
      version: BUILTIN_AI_TERMS_VERSION,
      acceptedAt: new Date().toISOString(),
    }));
  } catch {
    // Not remembered (storage full or blocked): the person is asked again next time.
  }
  settle(true);
};

export const declineBuiltinAITerms = (): void => settle(false);

export const subscribeBuiltinAITermsPrompt = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getBuiltinAITermsPromptOpen = (): boolean => state.promptOpen;

export const useBuiltinAITermsPromptOpen = (): boolean => React.useSyncExternalStore(
  subscribeBuiltinAITermsPrompt, getBuiltinAITermsPromptOpen, getBuiltinAITermsPromptOpen,
);

/** Back to the start (tests). */
export const resetBuiltinAITermsStore = (): void => {
  waiters = [];
  state = { promptOpen: false };
  listeners.forEach((listener) => listener());
};
