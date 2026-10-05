import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { WorkbenchTabType } from '../tabTypes';

type PendingSidebarToggleFocus = 'collapsed' | 'explorer' | null;

/** 折叠前让出侧栏内的焦点，避免焦点留在被隐藏 / inert 的树里。 */
export const blurFocusInsideSidebarContent = () => {
  if (typeof document === 'undefined') return;
  const activeElement = document.activeElement as HTMLElement | null;
  if (activeElement?.closest?.('[data-sidebar-content="true"]')) {
    activeElement.blur();
  }
};

/** 自成一体、不依赖左侧树选中上下文的工作台标签页：显示时自动折叠左侧树。 */
const SIDEBAR_AUTO_COLLAPSE_TAB_TYPES: ReadonlySet<WorkbenchTabType> = new Set<WorkbenchTabType>([
  'settings-center',
  'driver-manager',
  'data-sync',
  'table-export',
  'data-import',
]);

export const isSidebarAutoCollapseTabType = (tabType: WorkbenchTabType | undefined): boolean => (
  tabType !== undefined && SIDEBAR_AUTO_COLLAPSE_TAB_TYPES.has(tabType)
);

/**
 * 设置中心、驱动管理、同步 / 导入 / 导出工作台显示时自动折叠左侧树，离开时恢复。
 *
 * - 只恢复自己折叠的：进入前左侧树本来就折叠着，离开时保持折叠。
 * - 显示期间用户手动展开过左侧树，视为用户接管，离开时不再干预。
 * - 在这类标签页之间切换（显示状态不变）不触发展开 / 折叠，保持折叠不闪烁。
 * - 自动折叠不转移焦点（手动折叠会把焦点交给折叠按钮），只让出树内焦点。
 * - 用布局副作用在绘制前完成切换，避免左侧树闪现一帧。
 */
export const useWorkbenchSidebarAutoCollapse = (
  activeTabType: WorkbenchTabType | undefined,
  isSidebarCollapsed: boolean,
  setIsSidebarCollapsed: (collapsed: boolean) => void,
) => {
  const autoCollapseTabActive = isSidebarAutoCollapseTabType(activeTabType);
  const previousActiveRef = useRef(autoCollapseTabActive);
  const autoCollapsedRef = useRef(false);

  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = autoCollapseTabActive;
    if (autoCollapseTabActive && !wasActive) {
      if (!isSidebarCollapsed) {
        autoCollapsedRef.current = true;
        blurFocusInsideSidebarContent();
        setIsSidebarCollapsed(true);
      }
      return;
    }
    if (!autoCollapseTabActive && wasActive) {
      if (autoCollapsedRef.current && isSidebarCollapsed) {
        setIsSidebarCollapsed(false);
      }
      autoCollapsedRef.current = false;
      return;
    }
    if (autoCollapseTabActive && !isSidebarCollapsed) {
      autoCollapsedRef.current = false;
    }
  }, [autoCollapseTabActive, isSidebarCollapsed, setIsSidebarCollapsed]);
};

/**
 * Owns the explorer collapse state, the titlebar host for docked collapsed
 * actions and the focus hand-off between the two toggle buttons.
 */
export const useAppSidebarCollapse = (shouldDockCollapsedSidebarActionsInTitlebar: boolean) => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [collapsedSidebarActionsTarget, setCollapsedSidebarActionsTarget] = useState<HTMLDivElement | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const sidebarCollapsedToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarExplorerToggleRef = useRef<HTMLButtonElement>(null);
  const pendingSidebarToggleFocusRef = useRef<PendingSidebarToggleFocus>(null);
  const isSidebarCollapsedRef = useRef(isSidebarCollapsed);
  isSidebarCollapsedRef.current = isSidebarCollapsed;
  const isCollapsedSidebarActionsDocked = isSidebarCollapsed && shouldDockCollapsedSidebarActionsInTitlebar;

  useLayoutEffect(() => {
    const sidebarContent = sidebarContentRef.current;
    if (!sidebarContent) return;
    // aria-hidden alone does not remove focusable tree wrappers from the tab order.
    sidebarContent.inert = isCollapsedSidebarActionsDocked;
  }, [isCollapsedSidebarActionsDocked]);

  const handleCollapseSidebarPanel = useCallback(() => {
    blurFocusInsideSidebarContent();
    pendingSidebarToggleFocusRef.current = 'collapsed';
    setIsSidebarCollapsed(true);
  }, []);

  const handleExpandSidebarPanel = useCallback(() => {
    pendingSidebarToggleFocusRef.current = 'explorer';
    setIsSidebarCollapsed(false);
  }, []);

  // Stable identity keeps the memoized explorer from re-rendering on every toggle.
  const handleEnsureSidebarExpanded = useCallback(() => {
    if (isSidebarCollapsedRef.current) handleExpandSidebarPanel();
  }, [handleExpandSidebarPanel]);

  useLayoutEffect(() => {
    const target = pendingSidebarToggleFocusRef.current;
    if (!target) return;
    if (
      target === 'collapsed'
      && isCollapsedSidebarActionsDocked
      && !collapsedSidebarActionsTarget
    ) return;
    pendingSidebarToggleFocusRef.current = null;
    // The collapsed explorer keeps its expanded width inside a clipping parent;
    // scrolling the focused toggle into view would shift that parent sideways.
    (target === 'collapsed' ? sidebarCollapsedToggleRef : sidebarExplorerToggleRef).current?.focus({ preventScroll: true });
  }, [collapsedSidebarActionsTarget, isCollapsedSidebarActionsDocked, isSidebarCollapsed]);

  return {
    collapsedSidebarActionsTarget,
    handleCollapseSidebarPanel,
    handleEnsureSidebarExpanded,
    handleExpandSidebarPanel,
    isCollapsedSidebarActionsDocked,
    isSidebarCollapsed,
    setCollapsedSidebarActionsTarget,
    setIsSidebarCollapsed,
    sidebarCollapsedToggleRef,
    sidebarContentRef,
    sidebarExplorerToggleRef,
  };
};
