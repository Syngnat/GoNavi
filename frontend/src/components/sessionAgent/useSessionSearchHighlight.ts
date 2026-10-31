import React from 'react';

const HIT_SELECTOR = 'mark.gn-session-agent-hit';

interface HitRecord {
  /** React 持有的原文本节点：所有命中共享同一个，还原时按文档序拼回。 */
  original: Text;
  /** 命中后缀文本节点（紧跟其后、中间无其他命中时才存在）。 */
  after: Text | null;
  /** 包裹完成时原节点的值，用于识别 React 是否已改写该节点。 */
  leading: string;
  /** 包裹完成时的完整原文。 */
  full: string;
}

type HitMark = HTMLElement & { __gnHit?: HitRecord };

const isHitMark = (node: Node): node is HitMark =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).matches(HIT_SELECTOR);

/**
 * 详情页「会话内搜索」的高亮引擎：对已渲染的 DOM 做浏览器式查找——
 * 把命中的文本节点切开包上 <mark>，React 持有的原文本节点保持原位
 * （还原时按记录拼回，并识别 React 是否已改写），不干扰 reconciliation。
 * 执行过程懒加载、思考块折叠等内容变化由 MutationObserver 兜底重扫。
 */
export const useSessionSearchHighlight = (
  containerRef: React.RefObject<HTMLElement | null>,
  needle: string,
  contentKey: string,
): { total: number; active: number; step: (delta: number) => void } => {
  const [total, setTotal] = React.useState(0);
  const [active, setActive] = React.useState(0);
  const activeRef = React.useRef(0);
  const observerRef = React.useRef<MutationObserver | null>(null);
  const frameRef = React.useRef(0);
  const needleRef = React.useRef(needle);

  const scan = React.useCallback(() => {
    // 断开观察再改 DOM：本次扫描自身的变异不再触发重扫。
    observerRef.current?.disconnect();
    const container = containerRef.current;
    const count = container ? wrapContainer(container, needle) : 0;
    if (needle !== needleRef.current) {
      needleRef.current = needle;
      activeRef.current = 0;
    }
    activeRef.current = count > 0 ? Math.min(activeRef.current, count - 1) : 0;
    setTotal(count);
    setActive(activeRef.current);
    const nextContainer = containerRef.current;
    if (nextContainer) {
      observerRef.current?.observe(nextContainer, { childList: true, subtree: true, characterData: true });
    }
  }, [containerRef, needle]);

  const scheduleScan = React.useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => scan());
  }, [scan]);

  React.useEffect(() => {
    scan();
    const observer = new MutationObserver(scheduleScan);
    observerRef.current = observer;
    const container = containerRef.current;
    if (container) {
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
      cancelAnimationFrame(frameRef.current);
    };
  }, [containerRef, needle, contentKey, scan, scheduleScan]);

  const step = React.useCallback((delta: number) => {
    const container = containerRef.current;
    if (!container) return;
    const marks = Array.from(container.querySelectorAll<HTMLElement>(HIT_SELECTOR));
    if (!marks.length) return;
    const next = (activeRef.current + delta + marks.length) % marks.length;
    activeRef.current = next;
    marks.forEach((mark) => mark.classList.remove('is-active'));
    marks[next].classList.add('is-active');
    marks[next].scrollIntoView({ block: 'center' });
    setActive(next);
  }, [containerRef]);

  return { total, active, step };
};

const stripMarks = (container: HTMLElement): void => {
  container.querySelectorAll(HIT_SELECTOR).forEach((node) => {
    const mark = node as HitMark;
    const record = mark.__gnHit;
    if (record) {
      // React 若已改写原节点（新内容的全文），保留它的值并直接丢弃
      // 我们的片段；否则把命中文本按文档序拼回原节点。
      if (record.original.isConnected && record.original.nodeValue === record.leading) {
        record.original.nodeValue = record.full;
      }
      record.after?.remove();
    }
    mark.remove();
  });
};

const wrapContainer = (container: HTMLElement, needle: string): number => {
  stripMarks(container);
  const lower = needle.trim().toLowerCase();
  if (!lower) return 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const value = text.nodeValue ?? '';
    if (!value.trim() || !value.toLowerCase().includes(lower)) continue;
    if (text.parentElement?.closest('script, style')) continue;
    targets.push(text);
  }
  let count = 0;
  for (const text of targets) {
    const value = text.nodeValue ?? '';
    const parent = text.parentNode;
    if (!parent) continue;
    const lowerValue = value.toLowerCase();
    const starts: number[] = [];
    let from = 0;
    for (let at = lowerValue.indexOf(lower, from); at >= 0; from = at + lower.length, at = lowerValue.indexOf(lower, from)) {
      starts.push(at);
    }
    if (!starts.length) continue;
    const parts: Node[] = [];
    let cursor = 0;
    for (const start of starts) {
      if (start > cursor) parts.push(document.createTextNode(value.slice(cursor, start)));
      const mark = document.createElement('mark');
      mark.className = 'gn-session-agent-hit';
      mark.textContent = value.slice(start, start + lower.length);
      parts.push(mark);
      cursor = start + lower.length;
      count += 1;
    }
    if (cursor < value.length) parts.push(document.createTextNode(value.slice(cursor)));
    // React 持有的是 text 本身：首段是文本时留在原节点，否则原节点清空、
    // 全部片段按顺序插到它后面；相邻命中之间没有文本节点，after 记 null，
    // 还原按文档序累加。
    const head = parts[0] instanceof Text ? (parts[0] as Text) : null;
    text.nodeValue = head ? head.nodeValue ?? '' : '';
    let anchor: Node = text;
    for (let i = head ? 1 : 0; i < parts.length; i++) {
      parent.insertBefore(parts[i], anchor.nextSibling);
      anchor = parts[i];
    }
    for (let i = 0; i < parts.length; i++) {
      if (!isHitMark(parts[i])) continue;
      const next = parts[i + 1];
      (parts[i] as HitMark).__gnHit = {
        original: text,
        after: next instanceof Text ? next : null,
        leading: text.nodeValue ?? '',
        full: value,
      };
    }
  }
  return count;
};
