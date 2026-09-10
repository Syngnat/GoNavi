export const AI_AGENT_DATA_CLEARED_EVENT = 'gonavi:ai:data-cleared';

export const notifyAIAgentDataCleared = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AI_AGENT_DATA_CLEARED_EVENT));
};
