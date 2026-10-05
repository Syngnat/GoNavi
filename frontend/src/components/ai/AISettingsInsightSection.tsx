import React from 'react';

import type { AIProviderConfig } from '../../types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AISettingsAnalysisSection from './AISettingsAnalysisSection';
import AISettingsOcrSection from './AISettingsOcrSection';
import AISettingsRequestEventsSection from './AISettingsRequestEventsSection';
import type { AISettingsSectionKey } from './AISettingsSidebar';

interface AISettingsInsightSectionProps {
  section: Extract<AISettingsSectionKey, 'analysis' | 'request_events' | 'image_recognition'>;
  active: boolean;
  providers: AIProviderConfig[];
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
}

/** The settings sections that only read from the app (and take the same card styling): one place to render them. */
export const AISettingsInsightSection: React.FC<AISettingsInsightSectionProps> = ({ section, providers, ...shared }) => {
  switch (section) {
    case 'analysis':
      return <AISettingsAnalysisSection providers={providers} {...shared} />;
    case 'request_events':
      return <AISettingsRequestEventsSection providers={providers} {...shared} />;
    default:
      return <AISettingsOcrSection {...shared} />;
  }
};

export default AISettingsInsightSection;
