import React from 'react';
import { message } from 'antd';
import { t } from '../../i18n';
import { sessionAgentErrorText, type SessionAgentApi, type SessionAgentItem, type SessionBlockContent, type SessionContentRef } from './sessionAgentApi';
import { confirmSessionAgentDelete } from './SessionAgentDetailPanel';

const copyText = async (text: string, successKey: string) => {
  await navigator.clipboard.writeText(text);
  message.success(t(successKey));
};

// 详情操作保持使用原有 API 契约，不让展示层直接访问 Wails。
export const useSessionAgentDetailActions = (
  api: SessionAgentApi,
  selected: SessionAgentItem | null,
  clear: () => void,
  reloadList: () => Promise<void>,
) => {
  const exportMarkdown = React.useCallback(async () => {
    if (!selected) return;
    try {
      const markdown = await api.exportMarkdown(selected.providerId, selected.sourcePath);
      if (!markdown) {
        message.warning(t('session_agent.error.export_failed'));
        return;
      }
      await copyText(markdown, 'session_agent.action.export_done');
    } catch (err) {
      message.error(sessionAgentErrorText(err, 'session_agent.error.export_failed'));
    }
  }, [api, selected]);

  const copyResume = React.useCallback(async () => {
    if (!selected) return;
    try {
      const command = await api.copyResume(selected.providerId, selected.sessionId);
      if (!command) {
        message.warning(t('session_agent.error.resume_unavailable'));
        return;
      }
      await copyText(command, 'session_agent.action.copy_resume_done');
    } catch (err) {
      message.error(sessionAgentErrorText(err, 'session_agent.error.resume_unavailable'));
    }
  }, [api, selected]);

  const remove = React.useCallback(() => {
    if (!selected) return;
    confirmSessionAgentDelete(selected, async () => {
      const ok = await api.delete(selected.providerId, selected.sourcePath, selected.sessionId);
      if (!ok) {
        message.error(t('session_agent.error.delete_failed'));
        return;
      }
      message.success(t('session_agent.delete.done'));
      clear();
      await reloadList();
    });
  }, [api, selected, clear, reloadList]);

  const copyId = React.useCallback(() => {
    if (selected) void copyText(selected.sessionId, 'session_agent.action.copy_id_done')
      .catch(() => message.error(t('session_agent.error.copy_failed')));
  }, [selected]);
  const copyPath = React.useCallback(() => {
    if (selected) void copyText(selected.sourcePath, 'session_agent.action.copy_path_done')
      .catch(() => message.error(t('session_agent.error.copy_failed')));
  }, [selected]);
  const openFull = React.useCallback(async (ref: SessionContentRef): Promise<SessionBlockContent | null> => {
    if (!selected) return null;
    return api.blockContent(selected.providerId, selected.sourcePath, ref, 0, 0);
  }, [api, selected]);

  return { exportMarkdown, copyResume, remove, copyId, copyPath, openFull };
};
