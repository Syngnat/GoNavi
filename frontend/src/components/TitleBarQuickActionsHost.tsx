import { useLayoutEffect, useReducer } from 'react';
import { createPortal } from 'react-dom';

import { useOptionalI18n } from '../i18n/provider';
import { useStore } from '../store';
import TitleBarQuickActions, { type TitleBarQuickAction } from './TitleBarQuickActions';
import { TITLEBAR_QUICK_ACTIONS_SLOT_ID } from './titlebar/TitleBarActionRow';
import { resolveTitlebarQuickActionShortLabel } from './titlebar/titlebarShortLabels';

interface TitleBarQuickActionsHostProps {
  label: string;
  actions: TitleBarQuickAction[];
  trailingActions?: TitleBarQuickAction[];
}

const ABOUT_SLOT_ID = 'gonavi-titlebar-about-action';

const findSlot = (id: string): HTMLElement | null => (
  typeof document === 'undefined' ? null : document.getElementById(id)
);

/**
 * 工具入口和「关于」分开放，标题栏才能把「视图」插在「关于」前面。
 *
 * 插槽在渲染期按 id 查找，但「功能入口位置」切换时插槽会在工具条与标题栏之间重建：
 * 渲染期拿到的是即将卸载的旧节点，首次挂载时插槽也可能尚未进入 DOM。
 * 因此订阅该设置保证与 App 同批重渲染，并在提交后复查，插槽换新就补渲染一次。
 */
export default function TitleBarQuickActionsHost({
  label,
  actions: sourceActions,
  trailingActions: sourceTrailingActions,
}: TitleBarQuickActionsHostProps) {
  const placement = useStore((state) => state.appearance?.titlebarActionsPlacement);
  const t = useOptionalI18n()?.t;
  // 只有内联到标题栏时才可能用到精简名称，工具条保持原有结构。
  const withShortLabels = (items: TitleBarQuickAction[] | undefined) => (
    placement === 'titlebar' && t && items
      ? items.map((item) => ({ ...item, shortLabel: resolveTitlebarQuickActionShortLabel(item.key, t) }))
      : items
  );
  const actions = withShortLabels(sourceActions) ?? [];
  const trailingActions = withShortLabels(sourceTrailingActions);
  const [, refreshSlots] = useReducer((count: number) => count + 1, 0);
  const quickTarget = findSlot(TITLEBAR_QUICK_ACTIONS_SLOT_ID);
  const aboutTarget = findSlot(ABOUT_SLOT_ID);
  useLayoutEffect(() => {
    if (findSlot(TITLEBAR_QUICK_ACTIONS_SLOT_ID) !== quickTarget || findSlot(ABOUT_SLOT_ID) !== aboutTarget) {
      refreshSlots();
    }
  });
  if (!quickTarget) {
    return null;
  }
  if (!aboutTarget || !trailingActions?.length) {
    return createPortal(
      <TitleBarQuickActions label={label} actions={actions} trailingActions={trailingActions} />,
      quickTarget,
    );
  }
  return (
    <>
      {createPortal(
        <TitleBarQuickActions label={label} actions={actions} />,
        quickTarget,
      )}
      {createPortal(
        <TitleBarQuickActions label={label} actions={trailingActions} />,
        aboutTarget,
      )}
    </>
  );
}
