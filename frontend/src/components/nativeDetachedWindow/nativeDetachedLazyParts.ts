import React from 'react';

export const AIChatPanel = React.lazy(() => import('../AIChatPanel'));
export const WorkbenchTabContent = React.lazy(() => import('../WorkbenchTabContent'));
export const NativeDetachedWindowController = React.lazy(
  () => import('../NativeDetachedWindowController'),
);
