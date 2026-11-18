import { useEffect } from 'react';

type Anchored = { readonly current: HTMLElement | null };

const FALLBACK_SCROLLERS = [
  '.gonavi-settings-center-pane-scroll',
  '.gonavi-settings-center-content',
  '.gn-plugin-manager-workbench-body',
];

function isScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function scrollTargets(start: HTMLElement | null): HTMLElement[] {
  const found = new Set<HTMLElement>();
  if (typeof document === 'undefined') return [];
  let node = start?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollContainer(node)) found.add(node);
    node = node.parentElement;
  }
  // 市场页可能嵌在设置中心或插件工作台等不同外壳中；兜底锁住已知外壳的滚动容器。
  FALLBACK_SCROLLERS.forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      if (isScrollContainer(element)) found.add(element);
    });
  });
  return [...found];
}

// 弹窗打开时，锁住承载当前内容的所有可滚动容器，避免背景滚动条与弹窗滚动条叠在一起。
export function useScrollLock(anchor: Anchored, locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === 'undefined') return;
    const targets = scrollTargets(anchor.current);
    if (targets.length === 0) return;
    const previous = targets.map((element) => element.style.overflowY);
    targets.forEach((element) => { element.style.overflowY = 'hidden'; });
    return () => {
      targets.forEach((element, index) => { element.style.overflowY = previous[index] ?? ''; });
    };
  }, [anchor, locked]);
}
