import { useCallback } from 'react';

import { rememberApprovalScope, type AIApprovalScope } from './aiAutoApproval';
import type { AIRunApprovalState } from './aiRunEventProjection';

type RunControl = (
  runId: string,
  action: 'approve' | 'deny',
  extra: { approvalId?: string; callId?: string; argsHash?: string; busyKey: string },
) => Promise<void>;

/**
 * Turns a click on the approval card into a run control. An "always approve"
 * choice is stored first so that the calls that follow are not asked again.
 */
export const useAIChatApprovalDecision = (handleRunControl: RunControl) => useCallback(async (
  approval: AIRunApprovalState,
  decision: 'approved' | 'denied',
  scope: AIApprovalScope = 'once',
) => {
  const action = decision === 'approved' ? 'approve' : 'deny';
  // A failed "always" choice must not block this call: approve it once and let
  // the next call ask again.
  if (decision === 'approved') {
    await rememberApprovalScope(scope, approval.sessionId).catch((error) => {
      console.warn('Failed to remember AI approval scope', scope, error);
    });
  }
  void handleRunControl(approval.runId, action, {
    approvalId: approval.approvalId,
    callId: approval.callId,
    argsHash: approval.argsHash,
    busyKey: `${approval.runId}:${action}:${approval.approvalId}`,
  });
}, [handleRunControl]);
