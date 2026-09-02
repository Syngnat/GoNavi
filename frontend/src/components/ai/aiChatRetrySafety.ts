import type { AIChatMessage } from '../../types';

const isSettledAssistantMessage = (message: AIChatMessage): boolean => (
  message.role === 'assistant'
  && message.excludeFromAIContext !== true
  && message.loading !== true
  && message.phase !== 'connecting'
  && message.phase !== 'thinking'
  && message.phase !== 'generating'
  && message.phase !== 'tool_calling'
);

export const collectRetryableAIChatAssistantMessageIds = (
  messages: AIChatMessage[],
): ReadonlySet<string> => {
  const retryableMessageIds = new Set<string>();
  let lastUserMessageIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user') {
      lastUserMessageIndex = index;
      continue;
    }
    if (
      lastUserMessageIndex >= 0
      && isSettledAssistantMessage(message)
    ) {
      retryableMessageIds.add(message.id);
    }
  }

  return retryableMessageIds;
};

export const canRetryAIChatAssistantMessage = (
  messages: AIChatMessage[],
  messageId: string,
): boolean => collectRetryableAIChatAssistantMessageIds(messages).has(messageId);

export interface AIChatRetryPlan {
  targetMessageIndex: number;
  userMessageIndex: number;
  userMessage: AIChatMessage;
  requestHistory: AIChatMessage[];
}

export const resolveAIChatRetryPlan = (
  messages: AIChatMessage[],
  messageId: string,
): AIChatRetryPlan | null => {
  if (!canRetryAIChatAssistantMessage(messages, messageId)) return null;

  const targetMessageIndex = messages.findIndex((message) => message.id === messageId);
  if (targetMessageIndex <= 0) return null;

  let userMessageIndex = -1;
  for (let index = targetMessageIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userMessageIndex = index;
      break;
    }
  }
  if (userMessageIndex < 0) return null;

  return {
    targetMessageIndex,
    userMessageIndex,
    userMessage: messages[userMessageIndex],
    requestHistory: messages.slice(0, userMessageIndex + 1),
  };
};
