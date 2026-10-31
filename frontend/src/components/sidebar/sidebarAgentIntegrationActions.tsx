import React from 'react';
import { Button, Input, Space, Typography } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import { useStore } from '../../store';
import {
  SessionAgentDetect,
  SessionAgentRemove,
  SessionAgentUpdate,
} from '../../../wailsjs/go/app/App';
import type { AgentIntegrationSummaryView } from '../../utils/agentConnectionTypes';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';

/**
 * 智能体（已添加）的编辑与移除动作。侧栏右键菜单与新建连接弹窗共用：
 * 编辑只改配置（展示名 + 扫描数据目录），不触碰工具自身的会话数据。
 */

const resolveIntegration = (node: any): AgentIntegrationSummaryView | null => {
  const raw = node?.dataRef ?? node;
  const kind = String(raw?.kind || '').trim();
  if (!kind) return null;
  return {
    integrationId: String(raw?.integrationId || kind),
    kind,
    displayName: String(raw?.displayName || kind),
    enabled: raw?.enabled !== false,
    assetCount: Number(raw?.assetCount || 0),
    dataDir: String(raw?.dataDir || ''),
  };
};

const describeDetectStatus = (status: string): string => {
  switch (status) {
    case 'ready': return t('session_agent.setup.status.ready');
    case 'not_installed': return t('session_agent.setup.status.not_installed');
    case 'not_initialized': return t('session_agent.setup.status.not_initialized');
    case 'data_unreadable': return t('session_agent.setup.status.data_unreadable');
    case 'unsupported_kind': return t('session_agent.setup.status.unsupported');
    default: return t('session_agent.setup.status.unknown');
  }
};

/**
 * 打开智能体编辑弹窗：改展示名与扫描数据目录，数据目录可重新检测。
 */
export const openAgentIntegrationEditor = (node: any): void => {
  const integration = resolveIntegration(node);
  if (!integration) return;
  const draft = {
    displayName: integration.displayName,
    dataDir: integration.dataDir,
  };
  let detectText = '';

  Modal.confirm({
    title: t('sidebar.menu.edit_agent'),
    icon: null,
    width: 520,
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <div>
          <div style={{ marginBottom: 4 }}>{t('session_agent.setup.display_name')}</div>
          <Input
            {...noAutoCapInputProps}
            defaultValue={draft.displayName}
            placeholder={integration.kind}
            onChange={(event) => { draft.displayName = event.target.value; }}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('session_agent.setup.data_dir')}</div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              {...noAutoCapInputProps}
              defaultValue={draft.dataDir}
              placeholder={t('session_agent.setup.manual_locate_hint')}
              onChange={(event) => { draft.dataDir = event.target.value; }}
            />
            <Button
              onClick={async () => {
                const result = await SessionAgentDetect(integration.kind, draft.dataDir);
                detectText = result?.success
                  ? describeDetectStatus(String((result.data as any)?.status || ''))
                  : (result?.message || t('session_agent.setup.error.generic'));
              }}
            >
              {t('session_agent.setup.recheck')}
            </Button>
          </Space.Compact>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detectText || t('session_agent.edit.scope_hint')}
        </Typography.Text>
      </div>
    ),
    okText: t('common.save'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      const result = await SessionAgentUpdate(
        integration.kind,
        draft.dataDir,
        draft.displayName,
      );
      if (!result?.success) {
        throw new Error(result?.message || t('session_agent.setup.error.generic'));
      }
      await useStore.getState().refreshAgentIntegrations();
    },
  });
};

/**
 * 移除智能体（只删配置）。需二次确认。
 */
export const confirmRemoveAgentIntegration = (node: any): void => {
  const integration = resolveIntegration(node);
  if (!integration) return;
  Modal.confirm({
    title: t('sidebar.menu.remove_agent'),
    icon: null,
    content: (
      <div data-agent-integration-remove-confirm="true" style={{ marginTop: 8 }}>
        <Typography.Paragraph>
          {t('session_agent.remove.body', { name: integration.displayName })}
        </Typography.Paragraph>
        <Typography.Text type="secondary">{t('session_agent.remove.scope_hint')}</Typography.Text>
      </div>
    ),
    okText: t('common.confirm'),
    okButtonProps: { danger: true },
    cancelText: t('common.cancel'),
    onOk: async () => {
      const result = await SessionAgentRemove(integration.kind);
      if (!result?.success) {
        throw new Error(result?.message || t('session_agent.setup.error.generic'));
      }
      await useStore.getState().refreshAgentIntegrations();
    },
  });
};
