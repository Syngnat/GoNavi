import { Button, Spin } from 'antd';
import React from 'react';
import { Content } from '../appLayoutParts';
import SecurityUpdateBanner from '../../components/SecurityUpdateBanner';
import { hasSecurityUpdateRecentResult } from '../../utils/securityUpdateRepairFlow';
import TabManager from '../../components/TabManager';
import FloatingWorkbenchWindows from '../../components/FloatingWorkbenchWindows';
import FloatingQueryResultWindows from '../../components/FloatingQueryResultWindows';
import NativeDetachedWindowController from '../../components/NativeDetachedWindowController';
import AIPanelErrorBoundary from '../../components/ai/AIPanelErrorBoundary';
import { hasNativeDetachedWindowManager } from '../../utils/nativeDetachedWindowHost';
import FloatingAIChatWindow from '../../components/FloatingAIChatWindow';
import type { AppShellStateApi } from '../hooks/useAppShellState';
import type { AppCoreStateApi } from '../hooks/useAppCoreState';
import type { AppSecurityUpdateApi } from '../hooks/useAppSecurityUpdate';
import type { AppWorkbenchActionsApi } from '../hooks/useAppWorkbenchActions';
import type { AppSettingsNavigationApi } from '../hooks/useAppSettingsNavigation';
import type { AppProxySettingsApi } from '../hooks/useAppProxySettings';

export interface AppContentProps {
  isSecurityUpdateBannerVisible: AppShellStateApi['isSecurityUpdateBannerVisible'];
  securityUpdateStatus: AppShellStateApi['securityUpdateStatus'];
  darkMode: AppCoreStateApi['darkMode'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  effectiveOpacity: AppShellStateApi['effectiveOpacity'];
  handleStartSecurityUpdate: AppSecurityUpdateApi['handleStartSecurityUpdate'];
  handleRetrySecurityUpdate: AppSecurityUpdateApi['handleRetrySecurityUpdate'];
  handleRestartSecurityUpdate: AppSecurityUpdateApi['handleRestartSecurityUpdate'];
  handleOpenSecurityUpdateSettings: AppSecurityUpdateApi['handleOpenSecurityUpdateSettings'];
  setIsSecurityUpdateBannerDismissed: AppShellStateApi['setIsSecurityUpdateBannerDismissed'];
  isLogPanelOpen: AppWorkbenchActionsApi['isLogPanelOpen'];
  handleFocusSidebarSearch: AppSettingsNavigationApi['handleFocusSidebarSearch'];
  handleOpenAISettings: AppWorkbenchActionsApi['handleOpenAISettings'];
  handleToggleOrFocusAIPanel: AppShellStateApi['handleToggleOrFocusAIPanel'];
  aiPanelVisible: AppShellStateApi['aiPanelVisible'];
  aiChatDetached: AppShellStateApi['aiChatDetached'];
  aiPanelOverlayActive: AppProxySettingsApi['aiPanelOverlayActive'];
  aiPanelFullscreenOverlay: AppProxySettingsApi['aiPanelFullscreenOverlay'];
  titleBarHeight: AppShellStateApi['titleBarHeight'];
  t: AppCoreStateApi['t'];
  handleCloseAIPanel: AppShellStateApi['handleCloseAIPanel'];
  aiPanelRenderNonce: AppShellStateApi['aiPanelRenderNonce'];
  handleAIPanelRenderError: AppWorkbenchActionsApi['handleAIPanelRenderError'];
  aiPanelRenderWidth: AppProxySettingsApi['aiPanelRenderWidth'];
  bgContent: AppSecurityUpdateApi['bgContent'];
  handleRetryAIPanelRender: AppWorkbenchActionsApi['handleRetryAIPanelRender'];
  LazyAIChatPanel: AppShellStateApi['LazyAIChatPanel'];
  setAIPanelWidth: AppShellStateApi['setAIPanelWidth'];
  handleDetachAIPanel: AppShellStateApi['handleDetachAIPanel'];
  registerAIPanelTerminalGuard: AppShellStateApi['registerAIPanelTerminalGuard'];
}

export const AppContent = ({
  isSecurityUpdateBannerVisible, securityUpdateStatus, darkMode, overlayTheme, effectiveOpacity,
  handleStartSecurityUpdate, handleRetrySecurityUpdate, handleRestartSecurityUpdate,
  handleOpenSecurityUpdateSettings, setIsSecurityUpdateBannerDismissed, isLogPanelOpen,
  handleFocusSidebarSearch, handleOpenAISettings, handleToggleOrFocusAIPanel, aiPanelVisible,
  aiChatDetached, aiPanelOverlayActive, aiPanelFullscreenOverlay, titleBarHeight, t,
  handleCloseAIPanel, aiPanelRenderNonce, handleAIPanelRenderError, aiPanelRenderWidth, bgContent,
  handleRetryAIPanelRender, LazyAIChatPanel, setAIPanelWidth, handleDetachAIPanel,
  registerAIPanelTerminalGuard,
}: AppContentProps) => (
  <Content
    style={{ background: 'var(--gn-bg-panel-2)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}
  >
    {isSecurityUpdateBannerVisible && (
       <SecurityUpdateBanner
         status={securityUpdateStatus}
         darkMode={darkMode}
         overlayTheme={overlayTheme}
         surfaceOpacity={effectiveOpacity}
         onStart={handleStartSecurityUpdate}
         onRetry={handleRetrySecurityUpdate}
         onRestart={handleRestartSecurityUpdate}
         onOpenDetails={() => handleOpenSecurityUpdateSettings(
             hasSecurityUpdateRecentResult(securityUpdateStatus) ? 'recent_result' : null,
         )}
         onDismiss={() => setIsSecurityUpdateBannerDismissed(true)}
       />
    )}
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'row', position: 'relative' }}>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent', marginBottom: isLogPanelOpen ? 8 : 0, borderRadius: isLogPanelOpen ? 'var(--gonavi-border-radius)' : 0, clipPath: isLogPanelOpen ? 'inset(0 round var(--gonavi-border-radius))' : 'none' }}>
         <TabManager onFocusSidebarSearch={handleFocusSidebarSearch} />
         <FloatingWorkbenchWindows />
         <FloatingQueryResultWindows />
         <NativeDetachedWindowController
           onOpenAISettings={handleOpenAISettings}
           onToggleAI={handleToggleOrFocusAIPanel}
         />
      </div>

      {aiPanelVisible && !aiChatDetached && (
         <div
           className={aiPanelOverlayActive ? 'gn-v2-ai-panel-overlay' : undefined}
           style={aiPanelOverlayActive
             ? aiPanelFullscreenOverlay
               ? {
                   position: 'fixed',
                   top: titleBarHeight,
                   right: 0,
                   bottom: 0,
                   left: 0,
                   display: 'flex',
                   justifyContent: 'flex-end',
                   pointerEvents: 'none',
                   zIndex: 14,
                 }
               : { position: 'absolute', inset: 0, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none', zIndex: 14 }
             : { position: 'relative', display: 'flex', flexShrink: 0, overflow: 'visible' }}
         >
             {aiPanelOverlayActive && (
                 <button
                   type="button"
                   className="gn-v2-ai-panel-backdrop"
                   aria-label={t('app.ai_panel.aria.close')}
                   onClick={handleCloseAIPanel}
                   style={{
                     position: 'absolute',
                     inset: 0,
                     border: 0,
                     padding: 0,
                     background: darkMode ? 'rgba(3, 7, 18, 0.26)' : 'rgba(248, 250, 252, 0.38)',
                     backdropFilter: 'blur(2px)',
                     pointerEvents: 'auto',
                   }}
                 />
             )}
             <div
               className={`gn-v2-ai-panel-dock${aiPanelOverlayActive ? ' is-overlay' : ''}`}
               style={aiPanelOverlayActive
                 ? {
                     position: 'relative',
                     display: 'flex',
                     height: '100%',
                     pointerEvents: 'auto',
                     zIndex: 1,
                     boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
                   }
                 : undefined}
             >

             <AIPanelErrorBoundary
               key={aiPanelRenderNonce}
               onError={handleAIPanelRenderError}
               fallback={(error) => (
                 <div
                   style={{
                     width: aiPanelRenderWidth,
                     minWidth: 0,
                     height: '100%',
                     display: 'flex',
                     alignItems: 'center',
                     justifyContent: 'center',
                     padding: 20,
                     background: bgContent,
                     color: darkMode ? 'rgba(255,255,255,0.88)' : '#162033',
                   }}
                 >
                   <div
                     style={{
                       width: '100%',
                       maxWidth: 360,
                       display: 'grid',
                       gap: 12,
                       padding: 18,
                       borderRadius: 16,
                       border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.08)',
                       background: darkMode ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.94)',
                       boxShadow: darkMode ? '0 16px 36px rgba(0,0,0,0.32)' : '0 16px 36px rgba(15,23,42,0.12)',
                     }}
                   >
                     <div style={{ fontSize: 15, fontWeight: 600 }}>{t('app.ai_panel.error.title')}</div>
                     <div style={{ fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.68)' : '#526075' }}>
                       {t('app.ai_panel.error.description')}
                     </div>
                     {error?.message && (
                       <div
                         style={{
                           fontSize: 12,
                           lineHeight: 1.5,
                           wordBreak: 'break-word',
                           padding: '10px 12px',
                           borderRadius: 10,
                           background: darkMode ? 'rgba(2,6,23,0.7)' : 'rgba(248,250,252,0.92)',
                           border: darkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid rgba(148,163,184,0.22)',
                         }}
                       >
                         {error.message}
                       </div>
                     )}
                     <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                       <Button aria-label={t('app.ai_panel.aria.close')} onClick={handleCloseAIPanel}>{t('app.ai_panel.action.close')}</Button>
                       <Button type="primary" onClick={handleRetryAIPanelRender}>{t('app.ai_panel.action.reload')}</Button>
                     </div>
                   </div>
                 </div>
               )}
             >
               <React.Suspense
                 fallback={(
                   <div
                     style={{
                       width: aiPanelRenderWidth,
                       height: '100%',
                       display: 'grid',
                       placeItems: 'center',
                       background: bgContent,
                     }}
                     aria-busy="true"
                   >
                     <Spin />
                   </div>
                 )}
               >
                 <LazyAIChatPanel
                   width={aiPanelRenderWidth}
                   onWidthChange={setAIPanelWidth}
                   darkMode={darkMode}
                   bgColor={bgContent}
                   presentation="dock"
                   onClose={handleCloseAIPanel}
                   onDetach={handleDetachAIPanel}
                   onRegisterTerminalGuard={registerAIPanelTerminalGuard}
                   onOpenSettings={(providerId) => {
                     handleOpenAISettings(providerId);
                   }}
                   overlayTheme={overlayTheme}
                 />
               </React.Suspense>
             </AIPanelErrorBoundary>
             </div>
         </div>
      )}
      {aiPanelVisible && aiChatDetached && !hasNativeDetachedWindowManager() && (
         <FloatingAIChatWindow
           darkMode={darkMode}
           bgColor={bgContent}
           overlayTheme={overlayTheme}
           renderNonce={aiPanelRenderNonce}
           onOpenSettings={(providerId) => handleOpenAISettings(providerId)}
           onRenderError={handleAIPanelRenderError}
           onRetryRender={handleRetryAIPanelRender}
           onRegisterTerminalGuard={registerAIPanelTerminalGuard}
         />
      )}
    </div>

  </Content>
);
