import { useCallback, useEffect, useRef } from 'react';

import type { AIChatAttachment, AIChatMessage, AIContextItem, AIProviderConfig } from '../../types';
import type { AIComposerNoticeDescriptor } from '../../utils/aiComposerNotice';
import { buildAIChatReadinessSnapshot } from './aiChatReadiness';
import { rememberLocalAIChatSession } from './rememberLocalAIChatSession';

const AI_PROMPT_INJECT_EVENT = 'gonavi:ai:inject-prompt';

interface AIInjectedPromptDetail {
  prompt?: string;
  autoSend?: boolean;
  promptId?: string;
}

const recentInjectedPromptIds = new Set<string>();

const rememberInjectedPrompt = (promptId: string): boolean => {
  if (!promptId) return true;
  if (recentInjectedPromptIds.has(promptId)) return false;
  recentInjectedPromptIds.add(promptId);
  if (recentInjectedPromptIds.size > 32) {
    const oldest = recentInjectedPromptIds.values().next().value;
    if (oldest) recentInjectedPromptIds.delete(oldest);
  }
  return true;
};

interface UseAIInjectedPromptOptions {
  interactionDisabled: boolean;
  activeProvider?: AIProviderConfig | null;
  dynamicModels?: string[];
  loadingModels?: boolean;
  activeContext?: { connectionId?: string | null; dbName?: string | null } | null;
  aiContexts: Record<string, AIContextItem[] | undefined>;
  setInput: (value: string) => void;
  focusInput: () => void;
  setComposerNoticeState: (notice: AIComposerNoticeDescriptor | null) => void;
  setSending: (sending: boolean) => void;
  setActivePanelMode: (mode: 'chat') => void;
  addAIChatMessage: (sessionId: string, message: AIChatMessage) => void;
  activeSessionId: string;
  t: (key: string, params?: Record<string, string>) => string;
  submitHarnessRun: (
    content: string,
    attachments: AIChatAttachment[],
    sessionId?: string,
    mode?: 'queue' | 'steer',
  ) => Promise<{ sessionId?: string } | void>;
}

const diagnoseTitle = (prompt: string): string => prompt.split('\n')[0]?.trim().slice(0, 80) || '';

/**
 * 普通注入仍填入输入框。一键诊断带 autoSend，每次都新开一轮对话并发送，
 * 避免三个报错标签互相覆盖同一个输入框。
 */
export function useAIInjectedPrompt(options: UseAIInjectedPromptOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const submitFreshSession = useCallback(async (prompt: string) => {
    const current = optionsRef.current;
    if (current.interactionDisabled) {
      return;
    }
    const connectionKey = current.activeContext?.connectionId
      ? `${current.activeContext.connectionId}:${current.activeContext.dbName || ''}`
      : 'default';
    const readiness = buildAIChatReadinessSnapshot({
      activeProvider: current.activeProvider,
      dynamicModels: current.dynamicModels,
      loadingModels: current.loadingModels,
      activeContext: current.activeContext,
      activeContextItems: current.aiContexts[connectionKey] || [],
    });
    if (readiness.status === 'missing_provider') {
      current.setComposerNoticeState({ kind: 'missing_provider' });
      return;
    }
    if (readiness.status === 'provider_incomplete') {
      current.setComposerNoticeState({ kind: 'provider_incomplete', issues: readiness.issues });
      return;
    }
    if (readiness.status === 'missing_model' || readiness.status === 'loading_models') {
      current.setComposerNoticeState({ kind: 'missing_model' });
      return;
    }
    current.setComposerNoticeState(null);
    current.setActivePanelMode('chat');
    current.setSending(true);
    try {
      const receipt = await current.submitHarnessRun(prompt, [], undefined, 'queue');
      rememberLocalAIChatSession(String(receipt?.sessionId || ''), diagnoseTitle(prompt));
    } catch (error) {
      current.setSending(false);
      const detail = error instanceof Error ? error.message : String(error);
      current.addAIChatMessage(current.activeSessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: current.t('ai_chat.panel.message.send_failed', { detail }),
        rawError: detail,
        timestamp: Date.now(),
        loading: false,
        phase: 'idle',
        excludeFromAIContext: true,
      });
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AIInjectedPromptDetail>).detail;
      const prompt = String(detail?.prompt || '');
      if (!prompt) {
        return;
      }
      if (!rememberInjectedPrompt(String(detail?.promptId || ''))) {
        return;
      }
      if (detail?.autoSend) {
        void submitFreshSession(prompt);
        return;
      }
      optionsRef.current.setInput(prompt);
      window.setTimeout(() => optionsRef.current.focusInput(), 50);
    };
    window.addEventListener(AI_PROMPT_INJECT_EVENT, handler);
    return () => window.removeEventListener(AI_PROMPT_INJECT_EVENT, handler);
  }, [submitFreshSession]);
}
