import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export interface GonaviXtermHandle {
  /** Appends output (ANSI/VT sequences supported). */
  write(data: string): void;
  clear(): void;
  focus(): void;
}

export interface GonaviXtermTerminalProps {
  onData?: (data: string) => void;
  height?: number;
  readOnly?: boolean;
  dark?: boolean;
  fontSize?: number;
}

/** Host theme for xterm; exported so it can be asserted without a DOM. */
export function gonaviXtermTheme(dark: boolean) {
  return dark
    ? { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9' }
    : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328' };
}

/**
 * Full xterm.js terminal for plugin windows: cursor addressing, alternate
 * screen, key handling and resizing all work, so interactive programs (vim,
 * top, tab completion) behave normally. Output is written through the ref;
 * input arrives via `onData`.
 */
export const GonaviXtermTerminal = forwardRef<GonaviXtermHandle, GonaviXtermTerminalProps>(
  function GonaviXtermTerminal({ onData, height = 320, readOnly = false, dark = false, fontSize = 12 }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const onDataRef = useRef(onData);

    useEffect(() => { onDataRef.current = onData; }, [onData]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return undefined;
      const terminal = new Terminal({
        convertEol: true,
        fontSize,
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        theme: gonaviXtermTheme(dark),
      });
      terminal.open(container);
      const subscription = terminal.onData((data) => onDataRef.current?.(data));
      terminalRef.current = terminal;
      return () => {
        subscription.dispose();
        terminal.dispose();
        terminalRef.current = null;
      };
    }, [dark, fontSize, readOnly]);

    useImperativeHandle(ref, () => ({
      write: (data: string) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
      focus: () => terminalRef.current?.focus(),
    }), []);

    return <div ref={containerRef} className="gonavi-xterm" style={{ height }} />;
  },
);
