let draftInstanceSequence = 0;

export const createScriptDraftInstanceId = (): string => {
  const cryptoApi = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `draft:${cryptoApi.randomUUID()}`;
  }
  draftInstanceSequence += 1;
  return `draft:${Date.now().toString(36)}:${draftInstanceSequence}:${Math.random().toString(36).slice(2)}`;
};
