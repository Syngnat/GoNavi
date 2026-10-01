import { useEffect, type RefObject } from 'react';

/** Class added to the located setting for a moment so the eye can find it. */
export const SETTINGS_CENTER_ENTRY_FLASH_CLASS = 'gonavi-settings-entry-flash';

const CONTENT_SELECTOR = '.gonavi-settings-center-content';
const ROW_SELECTOR = '.ant-form-item, .ant-descriptions-item, [data-settings-entry-row]';
const FLASH_DURATION_MS = 2200;
/** Lazy panes (AI settings) may need a moment before their controls exist. */
const LOCATE_TIMEOUT_MS = 4000;
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'OPTION', 'TEXTAREA', 'INPUT']);

export type SettingsCenterEntryFocusRequest = {
  /** Rendered label of the setting; the page is scanned for this text. */
  text: string;
};

type PendingRequest = SettingsCenterEntryFocusRequest & { nonce: number; requestedAt: number };

let pending: PendingRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/**
 * Asks the mounted settings center to scroll to and highlight a setting once
 * its page is on screen. The latest request wins.
 */
export const requestSettingsCenterEntryFocus = (request: SettingsCenterEntryFocusRequest): void => {
  nonce += 1;
  pending = { ...request, nonce, requestedAt: Date.now() };
  listeners.forEach((listener) => listener());
};

const normalizeText = (text: string): string => (
  text
    .replace(/\s+/g, ' ')
    // Form labels are commonly rendered as "名称：" or "* 名称".
    .replace(/^\*\s*/, '')
    .replace(/\s*[*:：]+$/, '')
    .trim()
    .toLocaleLowerCase()
);

const isHidden = (element: Element): boolean => (
  Boolean(element.closest('[hidden], [aria-hidden="true"]'))
);

/** Descends to the innermost element that still carries exactly `target`. */
const innermostWithText = (element: HTMLElement, target: string): HTMLElement => {
  let current = element;
  for (;;) {
    const matching = Array.from(current.children).filter(
      (child): child is HTMLElement => (
        child instanceof HTMLElement && normalizeText(child.textContent ?? '') === target
      ),
    );
    if (matching.length !== 1) {
      return current;
    }
    current = matching[0];
  }
};

/**
 * Finds the element that renders `text` inside `root`: the innermost element
 * whose whole text equals the label, falling back to a control labelled with
 * it via `aria-label` (switches render their label separately).
 */
export const findSettingsEntryElement = (root: ParentNode, text: string): HTMLElement | null => {
  const target = normalizeText(text);
  if (!target) {
    return null;
  }
  // Text longer than the label (plus a colon / asterisk) cannot equal it.
  const maxLength = target.length + 8;
  let labelled: HTMLElement | null = null;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (SKIPPED_TAGS.has(element.tagName) || isHidden(element)) {
      continue;
    }
    const content = element.textContent ?? '';
    if (content.length <= maxLength && normalizeText(content) === target) {
      return innermostWithText(element, target);
    }
    if (!labelled && normalizeText(element.getAttribute('aria-label') ?? '') === target) {
      labelled = element;
    }
  }
  return labelled;
};

/** The row to highlight: the form item, or the widest wrapper that adds no extra text. */
const flashTargetFor = (element: HTMLElement, root: Element): HTMLElement => {
  const row = element.closest<HTMLElement>(ROW_SELECTOR);
  if (row && row !== root && root.contains(row)) {
    return row;
  }
  const label = normalizeText(element.textContent ?? '');
  let target = element;
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = target.parentElement;
    if (!parent || parent === root || !root.contains(parent)) {
      break;
    }
    if (label && normalizeText(parent.textContent ?? '') !== label) {
      break;
    }
    target = parent;
  }
  return target;
};

/** Scrolls the located setting into view and flashes it. */
export const revealSettingsEntry = (element: HTMLElement, root: Element): void => {
  const target = flashTargetFor(element, root);
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  target.classList.remove(SETTINGS_CENTER_ENTRY_FLASH_CLASS);
  // Reflow so re-triggering on the same element restarts the animation.
  void target.offsetWidth;
  target.classList.add(SETTINGS_CENTER_ENTRY_FLASH_CLASS);
  window.setTimeout(() => target.classList.remove(SETTINGS_CENTER_ENTRY_FLASH_CLASS), FLASH_DURATION_MS);
};

const resolveContentRoot = (host: HTMLElement): HTMLElement => (
  host.querySelector<HTMLElement>(CONTENT_SELECTOR) ?? host
);

/**
 * Fulfils `requestSettingsCenterEntryFocus` inside the settings-center host:
 * waits for the target page to render, then reveals the setting. Gives up
 * silently when the text never shows up, leaving the opened page as is.
 */
export const useSettingsCenterEntryFocus = (hostRef: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    let stopWaiting: (() => void) | null = null;

    const settle = (request: PendingRequest): void => {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      const tryReveal = (): boolean => {
        const root = resolveContentRoot(host);
        const element = findSettingsEntryElement(root, request.text);
        if (!element) {
          return false;
        }
        if (pending?.nonce === request.nonce) {
          pending = null;
        }
        revealSettingsEntry(element, root);
        return true;
      };
      const observer = new MutationObserver(() => {
        if (pending?.nonce !== request.nonce || tryReveal()) {
          stopWaiting?.();
        }
      });
      // The request is usually issued in the same tick as the navigation that
      // swaps the page; let that render commit first so the text of the page
      // being left is never mistaken for the target.
      const firstTry = window.setTimeout(() => {
        if (tryReveal()) {
          stopWaiting?.();
          return;
        }
        observer.observe(host, { childList: true, subtree: true, characterData: true });
      }, 0);
      const giveUp = window.setTimeout(() => stopWaiting?.(), LOCATE_TIMEOUT_MS);
      stopWaiting = () => {
        observer.disconnect();
        window.clearTimeout(firstTry);
        window.clearTimeout(giveUp);
        stopWaiting = null;
      };
    };

    const handleRequest = (): void => {
      stopWaiting?.();
      if (pending && Date.now() - pending.requestedAt > LOCATE_TIMEOUT_MS) {
        // Nobody could show it in time (page never rendered it); do not fire late.
        pending = null;
      }
      if (pending) {
        settle(pending);
      }
    };

    listeners.add(handleRequest);
    // A request issued before this host mounted (tab just opened) is still pending.
    handleRequest();
    return () => {
      listeners.delete(handleRequest);
      stopWaiting?.();
    };
  }, [hostRef]);
};

/** Test hook: drop any request that no mounted host consumed. */
export const resetSettingsCenterEntryFocusForTest = (): void => {
  pending = null;
};
