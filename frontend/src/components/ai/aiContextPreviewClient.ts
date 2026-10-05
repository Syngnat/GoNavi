import { getAIRunHarnessService, type AgentInputRequest, type AIRunHarnessService } from './aiRunHarnessClient';

/**
 * What submitting an input would send to the model, measured by Go with the same
 * builder, session, workspace and window a run uses (see
 * runharness.ContextPreview). Sizes are in the unit the builder budgets in.
 */
export interface AgentContextPreview {
  /** 0 when the provider's model has no window the agent enforces. */
  windowTokens: number;
  reservedOutputTokens: number;
  /** GoNavi's role prompt and the person's own prompts, sent first with every turn. */
  instructionsBytes: number;
  /** The workspace as sent (after any trimming), without what was bound. */
  workspaceBytes: number;
  boundBytes: number;
  userBytes: number;
  assistantBytes: number;
  toolBytes: number;
  retainedMessages: number;
  /** Earlier messages left out because they no longer fit. */
  omittedMessages: number;
  workspaceTrimmed?: string;
  /** Even the newest message alone does not fit: a run would be refused. */
  overflow: boolean;
}

export const canPreviewAgentContext = (
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): boolean => typeof service?.AIPreviewAgentContext === 'function';

const count = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

export const previewAgentContext = async (
  request: AgentInputRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<AgentContextPreview> => {
  const call = service?.AIPreviewAgentContext;
  if (typeof call !== 'function') {
    throw new Error('AIPreviewAgentContext is unavailable');
  }
  const result = ((await call.call(service, request)) ?? {}) as Record<string, unknown>;
  return {
    windowTokens: count(result.windowTokens),
    reservedOutputTokens: count(result.reservedOutputTokens),
    instructionsBytes: count(result.instructionsBytes),
    workspaceBytes: count(result.workspaceBytes),
    boundBytes: count(result.boundBytes),
    userBytes: count(result.userBytes),
    assistantBytes: count(result.assistantBytes),
    toolBytes: count(result.toolBytes),
    retainedMessages: count(result.retainedMessages),
    omittedMessages: count(result.omittedMessages),
    workspaceTrimmed: result.workspaceTrimmed ? String(result.workspaceTrimmed) : undefined,
    overflow: result.overflow === true,
  };
};
