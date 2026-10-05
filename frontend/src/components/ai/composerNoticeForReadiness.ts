import type { AIComposerNoticeDescriptor } from '../../utils/aiComposerNotice';
import type { AIChatReadinessSnapshot } from './aiChatReadiness';

/** The composer notice a failed readiness check should show on send; null when ready. */
export const composerNoticeDescriptorFor = (
  readiness: Pick<AIChatReadinessSnapshot, 'status' | 'issues'>,
): AIComposerNoticeDescriptor | null => {
  switch (readiness.status) {
    case 'missing_provider': return { kind: 'missing_provider' };
    case 'login_required': return { kind: 'builtin_login_required' };
    case 'provider_incomplete': return { kind: 'provider_incomplete', issues: readiness.issues };
    case 'missing_model':
    case 'loading_models': return { kind: 'missing_model' };
    default: return null;
  }
};
