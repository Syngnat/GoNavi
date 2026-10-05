import React from 'react';
import { Layout } from 'antd';

export const createLazyAIChatPanel = () => React.lazy(() => import('../components/AIChatPanel'));
export const createLazyAISettingsContent = () => React.lazy(async () => {
  const module = await import('../components/AISettingsModal');
  return { default: module.AISettingsContent };
});

export const { Sider, Content } = Layout;

export type ApplicationQuitConfirmedAction = () => Promise<boolean>;
