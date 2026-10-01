/** How long an approval decision holds: this call only, this session, or every session. */
export type AIApprovalScope = 'once' | 'session' | 'global';

export interface AIAutoApprovalSettings {
  global: boolean;
  sessionIds: string[];
}

interface AutoApprovalService {
  AIGetAutoApprovalSettings?: () => Promise<unknown>;
  AISetGlobalAutoApproval?: (enabled: boolean) => Promise<unknown>;
  AISetSessionAutoApproval?: (sessionId: string, enabled: boolean) => Promise<unknown>;
  AIClearSessionAutoApprovals?: () => Promise<unknown>;
}

const autoApprovalService = (): AutoApprovalService | undefined => (
  typeof window === 'undefined' ? undefined : (window as any)?.go?.aiservice?.Service
);

export const parseAutoApprovalSettings = (value: unknown): AIAutoApprovalSettings => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    global: raw.global === true,
    sessionIds: Array.isArray(raw.sessionIds)
      ? raw.sessionIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
  };
};

const requireMethod = <K extends keyof AutoApprovalService>(name: K): NonNullable<AutoApprovalService[K]> => {
  const method = autoApprovalService()?.[name];
  if (typeof method !== 'function') throw new Error(`${name} is unavailable`);
  return method.bind(autoApprovalService()) as NonNullable<AutoApprovalService[K]>;
};

/** Null when the Go service is not reachable (for example a plain browser preview). */
export const readAutoApprovalSettings = async (): Promise<AIAutoApprovalSettings | null> => {
  const read = autoApprovalService()?.AIGetAutoApprovalSettings;
  if (typeof read !== 'function') return null;
  return parseAutoApprovalSettings(await read.call(autoApprovalService()));
};

export const setGlobalAutoApproval = async (enabled: boolean): Promise<AIAutoApprovalSettings> =>
  parseAutoApprovalSettings(await requireMethod('AISetGlobalAutoApproval')(enabled));

export const setSessionAutoApproval = async (
  sessionId: string,
  enabled: boolean,
): Promise<AIAutoApprovalSettings> =>
  parseAutoApprovalSettings(await requireMethod('AISetSessionAutoApproval')(sessionId, enabled));

export const clearSessionAutoApprovals = async (): Promise<AIAutoApprovalSettings> =>
  parseAutoApprovalSettings(await requireMethod('AIClearSessionAutoApprovals')());

/** Persists the "always" part of an approval choice; approving once stores nothing. */
export const rememberApprovalScope = async (scope: AIApprovalScope, sessionId: string): Promise<void> => {
  if (scope === 'session') await setSessionAutoApproval(sessionId, true);
  else if (scope === 'global') await setGlobalAutoApproval(true);
};
