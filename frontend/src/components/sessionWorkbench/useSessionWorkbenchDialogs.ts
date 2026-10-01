import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionWorkbenchState } from './useSessionWorkbench';
import {
  actionLabelKey,
  availableSessionActions,
  buildSessionActionRequest,
  sessionActionDisplayId,
  type DatabaseSession,
  type SessionAction,
  type SessionCapability,
} from './sessionWorkbenchModel';

type Translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string;

interface MessageApi {
  warning: (content: string) => void;
  error: (content: string) => void;
  success: (content: string) => void;
}

export interface SessionWorkbenchDialogs {
  chooserRow: DatabaseSession | null;
  confirmRow: DatabaseSession | null;
  confirmAction: SessionAction | null;
  confirmLoading: boolean;
  handleRowAction: (session: DatabaseSession, action: SessionAction) => void;
  selectAction: (action: SessionAction) => void;
  closeChooser: () => void;
  closeConfirmation: () => void;
  handleConfirm: () => Promise<void>;
}

export const useSessionWorkbenchDialogs = ({
  capability,
  workbench,
  contextKey,
  t,
  messageApi,
}: {
  capability: SessionCapability;
  workbench: Pick<SessionWorkbenchState, 'executeAction'>;
  contextKey?: string;
  t: Translate;
  messageApi: MessageApi;
}): SessionWorkbenchDialogs => {
  const [chooserRow, setChooserRow] = useState<DatabaseSession | null>(null);
  const [confirmRow, setConfirmRow] = useState<DatabaseSession | null>(null);
  const [confirmAction, setConfirmAction] = useState<SessionAction | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const confirmInFlightRef = useRef(false);
  const contextKeyRef = useRef(contextKey);
  // Keep the guard synchronous with a render. The completion of an already
  // resolved promise can run before the context-change effect below.
  if (contextKeyRef.current !== contextKey) contextKeyRef.current = contextKey;

  useEffect(() => {
    // A row confirmation is only valid for the exact connection and applied
    // database scope that produced the row. Close stale blockers instead of
    // allowing an old ID to be submitted against a newly selected connection.
    setChooserRow(null);
    setConfirmRow(null);
    setConfirmAction(null);
  }, [contextKey]);

  const openConfirmation = useCallback((session: DatabaseSession, action: SessionAction) => {
    setChooserRow(null);
    setConfirmRow(session);
    setConfirmAction(action);
  }, []);

  const handleRowAction = useCallback((session: DatabaseSession, action: SessionAction) => {
    const actions = availableSessionActions(capability, session);
    if (!actions.includes(action)) {
      messageApi.warning(t('session_workbench.error.no_target'));
      return;
    }
    if (actions.length > 1) {
      setChooserRow(session);
      return;
    }
    openConfirmation(session, action);
  }, [capability, messageApi, openConfirmation, t]);

  const selectAction = useCallback((action: SessionAction) => {
    if (!chooserRow) return;
    const actions = availableSessionActions(capability, chooserRow);
    if (!actions.includes(action)) {
      setChooserRow(null);
      messageApi.warning(t('session_workbench.error.no_target'));
      return;
    }
    openConfirmation(chooserRow, action);
  }, [capability, chooserRow, messageApi, openConfirmation, t]);

  const closeChooser = useCallback(() => setChooserRow(null), []);
  const closeConfirmation = useCallback(() => {
    if (confirmLoading) return;
    setConfirmRow(null);
    setConfirmAction(null);
  }, [confirmLoading]);

  const handleConfirm = useCallback(async () => {
    if (!confirmRow || !confirmAction || confirmInFlightRef.current) return;
    const request = buildSessionActionRequest(capability, confirmAction, confirmRow);
    const target = sessionActionDisplayId(capability, confirmAction, confirmRow);
    if (!request || !target) {
      messageApi.error(t('session_workbench.error.no_target'));
      return;
    }
    confirmInFlightRef.current = true;
    setConfirmLoading(true);
    const requestContextKey = contextKeyRef.current;
    try {
      const result = await workbench.executeAction(request);
      // A connection/database switch (or a manual refresh) invalidates the
      // blocker. Never toast or close a newer confirmation with an old result.
      if (result.stale || contextKeyRef.current !== requestContextKey) return;
      if (result.success !== true) {
        messageApi.error(result.message || t('session_workbench.error.action_failed', {
          action: t(actionLabelKey(confirmAction)),
          detail: '',
        }));
        return;
      }
      messageApi.success(t('session_workbench.message.action_succeeded', {
        action: t(actionLabelKey(confirmAction)),
        target,
      }));
      setConfirmRow(null);
      setConfirmAction(null);
    } finally {
      confirmInFlightRef.current = false;
      setConfirmLoading(false);
    }
  }, [capability, confirmAction, confirmRow, messageApi, t, workbench]);

  return {
    chooserRow,
    confirmRow,
    confirmAction,
    confirmLoading,
    handleRowAction,
    selectAction,
    closeChooser,
    closeConfirmation,
    handleConfirm,
  };
};
