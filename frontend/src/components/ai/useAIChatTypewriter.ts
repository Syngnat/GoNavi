import React from 'react';

const TYPEWRITER_BATCH_FRAMES = 6;

export interface AIChatTypewriterState {
  content: string;
  isAnimating: boolean;
}

/**
 * Smooths streamed model batches for display without changing the durable
 * message content that is used for history, retries, and copy actions.
 */
export const useAIChatTypewriter = (content: string, isStreaming: boolean): AIChatTypewriterState => {
  const targetTextRef = React.useRef(content);
  const targetCharactersRef = React.useRef(Array.from(content));
  const displayedLengthRef = React.useRef(targetCharactersRef.current.length);
  const frameBudgetRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);
  const [displayedContent, setDisplayedContent] = React.useState(content);
  const [isAnimating, setIsAnimating] = React.useState(false);

  const cancelPendingFrame = React.useCallback(() => {
    if (frameRef.current === null) return;
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = null;
  }, []);

  const scheduleRef = React.useRef<() => void>();
  scheduleRef.current = () => {
    if (frameRef.current !== null) return;

    const targetCharacters = targetCharactersRef.current;
    if (displayedLengthRef.current >= targetCharacters.length) return;

    if (typeof globalThis.requestAnimationFrame !== 'function') {
      displayedLengthRef.current = targetCharacters.length;
      setDisplayedContent(targetCharacters.join(''));
      setIsAnimating(false);
      return;
    }

    frameRef.current = globalThis.requestAnimationFrame(() => {
      frameRef.current = null;
      const latestTarget = targetCharactersRef.current;
      const remaining = latestTarget.length - displayedLengthRef.current;
      if (remaining <= 0) return;

      const framesRemaining = Math.max(1, frameBudgetRef.current);
      const characterCount = Math.max(1, Math.ceil(remaining / framesRemaining));
      displayedLengthRef.current = Math.min(latestTarget.length, displayedLengthRef.current + characterCount);
      frameBudgetRef.current = Math.max(0, frameBudgetRef.current - 1);
      setDisplayedContent(latestTarget.slice(0, displayedLengthRef.current).join(''));
      if (displayedLengthRef.current >= latestTarget.length) {
        setIsAnimating(false);
        return;
      }
      scheduleRef.current?.();
    });
  };

  React.useEffect(() => {
    const previousTarget = targetTextRef.current;
    const hasPendingCharacters = displayedLengthRef.current < targetCharactersRef.current.length;
    const extendsPreviousTarget = content.startsWith(previousTarget);

    // A completed/history message must appear immediately. Once streaming has
    // started, however, drain queued text even if its terminal event arrives.
    if ((!isStreaming && !hasPendingCharacters) || !extendsPreviousTarget) {
      cancelPendingFrame();
      const nextCharacters = Array.from(content);
      targetTextRef.current = content;
      targetCharactersRef.current = nextCharacters;
      displayedLengthRef.current = nextCharacters.length;
      frameBudgetRef.current = 0;
      setDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    if (content !== previousTarget) {
      frameBudgetRef.current = TYPEWRITER_BATCH_FRAMES;
    }
    targetTextRef.current = content;
    targetCharactersRef.current = Array.from(content);
    setIsAnimating(displayedLengthRef.current < targetCharactersRef.current.length);
    scheduleRef.current?.();
  }, [cancelPendingFrame, content, isStreaming]);

  React.useEffect(() => cancelPendingFrame, [cancelPendingFrame]);

  return { content: displayedContent, isAnimating };
};
