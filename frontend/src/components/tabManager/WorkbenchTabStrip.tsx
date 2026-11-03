import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import type { MenuProps, TabsProps } from 'antd';

import {
  formatHiddenTabCount,
  resolveTabOverflowLayout,
} from './tabOverflowLayout';
import { V2_WORKBENCH_TAB_MAX_WIDTH, resolveV2WorkbenchTabWidth } from './tabManagerShortcuts';

/** 「更多」按钮占位宽度：数字 + 内边距 + 左右间距。 */
const MORE_BUTTON_WIDTH = 52;

type StripItem = {
  key: string;
  label: React.ReactNode;
};

export type WorkbenchTabStripProps = {
  /** 全部 tab（顺序即标签条顺序）。 */
  items: StripItem[];
  activeKey?: string;
  onTabClick: (key: string, event: React.MouseEvent | React.KeyboardEvent) => void;
  /** 右侧常驻挂载点（运行中 tab 指示等），由 antd 的 extra 传入。 */
  extra?: React.ReactNode;
  /** 把已渲染的 tab 包一层（拖拽排序、拖出窗口等既有能力挂在这里）。 */
  renderTab?: (input: { key: string; element: React.ReactElement }) => React.ReactNode;
  /** 「更多」菜单里每一项的标题与元信息。 */
  describeHiddenTab: (key: string) => { title: string; meta?: string };
  t: (key: string) => string;
};

/**
 * 工作台标签条：自绘可见性，溢出项收进紧凑的「更多」下拉。
 *
 * 不用 antd 自带的收纳：它把溢出项塞进一个大卡片（每项两行 + 关闭按钮），
 * 与 IDEA 那种单行紧凑列表差得远，且无法定制结构。
 *
 * 面板仍由 antd Tabs 渲染（items 全量传入），这里只负责标签条本身，所以
 * 切换 tab 不会丢编辑器状态。
 */
export const WorkbenchTabStrip = ({
  items,
  activeKey,
  onTabClick,
  extra,
  renderTab,
  describeHiddenTab,
  t,
}: WorkbenchTabStripProps) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  // 标签条宽度随窗口与侧栏变化，用 ResizeObserver 跟住；失败时退回全量渲染。
  useEffect(() => {
    const node = stripRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? node.clientWidth;
      setAvailableWidth((current) => (Math.abs(current - width) < 1 ? current : width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 标签宽度统一：溢出时才启用「更多」，因此按「全部放下」的宽度上限算，
  // 不做「均分收缩」——IDEA 的标签条也是固定宽度、超出的收进下拉。
  const tabWidth = useMemo(
    () => Math.min(V2_WORKBENCH_TAB_MAX_WIDTH, resolveV2WorkbenchTabWidth(availableWidth, items.length)),
    [availableWidth, items.length],
  );

  const layout = useMemo(
    () => resolveTabOverflowLayout({
      tabs: items.map((item) => ({ id: item.key, item })),
      activeTabId: activeKey,
      availableWidth,
      tabWidth,
      moreButtonWidth: MORE_BUTTON_WIDTH,
    }),
    [items, activeKey, availableWidth, tabWidth],
  );

  const hiddenMenu: MenuProps['items'] = useMemo(
    () => layout.hidden.map(({ item }) => {
      const { title, meta } = describeHiddenTab(item.key);
      return {
        key: item.key,
        label: (
          <div className="gn-v2-tab-more-row" data-tab-more-item={item.key}>
            <span className="gn-v2-tab-more-row__title">{title}</span>
            {meta ? <span className="gn-v2-tab-more-row__meta">{meta}</span> : null}
          </div>
        ),
      };
    }),
    [layout.hidden, describeHiddenTab],
  );

  return (
    <div className="gn-v2-tab-strip" data-tab-strip="true">
      <div className="gn-v2-tab-strip__scroll" ref={stripRef}>
        <div className="gn-v2-tab-strip__list" role="tablist">
          {layout.visible.map(({ item }) => {
            const active = item.key === activeKey;
            const element = (
              <div
                key={item.key}
                role="tab"
                aria-selected={active}
                className={`gn-v2-tab-strip__tab${active ? ' is-active' : ''}`}
                data-tab-strip-tab={item.key}
                style={{ width: tabWidth }}
                onClick={(event) => onTabClick(item.key, event)}
              >
                {item.label}
              </div>
            );
            return renderTab ? renderTab({ key: item.key, element }) : element;
          })}
        </div>
      </div>
      {layout.hidden.length > 0 ? (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: hiddenMenu,
            onClick: ({ key, domEvent }) => onTabClick(key, domEvent as React.MouseEvent),
            selectedKeys: activeKey ? [activeKey] : [],
            className: 'gn-v2-tab-more-menu',
          }}
        >
          <button
            type="button"
            className="gn-v2-tab-strip__more"
            data-tab-strip-more="true"
            title={t('query_editor.action.more')}
            aria-label={t('query_editor.action.more')}
          >
            {formatHiddenTabCount(layout.hidden.length)}
          </button>
        </Dropdown>
      ) : null}
      {extra ? <div className="gn-v2-tab-strip__extra">{extra}</div> : null}
    </div>
  );
};

export type WorkbenchTabBarProps = Parameters<NonNullable<TabsProps['renderTabBar']>>[0];
