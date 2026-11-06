import React, { useEffect, useMemo, useRef, useState } from 'react';

/** One styled run of terminal text. SGR state applies until the next escape. */
export interface GonaviAnsiSegment {
  text: string;
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
}

const ANSI_PATTERN = /\u001b\[([0-9;?]*)([A-Za-z])/g;

const ANSI_FOREGROUND = [
  '#c9d1d9', '#ff7b72', '#7ee787', '#d29922', '#79c0ff', '#d2a8ff', '#76e3ea', '#b1bac4',
];
const ANSI_FOREGROUND_BRIGHT = [
  '#8b949e', '#ffa198', '#56d364', '#e3b341', '#a5d6ff', '#e2c5ff', '#b3f0ff', '#f0f6fc',
];
const ANSI_BACKGROUND = [
  '#0d1117', '#ff7b72', '#7ee787', '#d29922', '#79c0ff', '#d2a8ff', '#76e3ea', '#b1bac4',
];
const ANSI_BACKGROUND_BRIGHT = [
  '#6e7681', '#ffa198', '#56d364', '#e3b341', '#a5d6ff', '#e2c5ff', '#b3f0ff', '#f0f6fc',
];

type AnsiState = Omit<GonaviAnsiSegment, 'text'>;

function applySgr(state: AnsiState, code: number): AnsiState {
  if (code === 0) return {};
  if (code === 1) return { ...state, bold: true };
  if (code === 2) return { ...state, dim: true };
  if (code === 22) return { ...state, bold: false, dim: false };
  if (code === 39) return { ...state, foreground: undefined };
  if (code === 49) return { ...state, background: undefined };
  if (code >= 30 && code <= 37) return { ...state, foreground: ANSI_FOREGROUND[code - 30] };
  if (code >= 90 && code <= 97) return { ...state, foreground: ANSI_FOREGROUND_BRIGHT[code - 90] };
  if (code >= 40 && code <= 47) return { ...state, background: ANSI_BACKGROUND[code - 40] };
  if (code >= 100 && code <= 107) return { ...state, background: ANSI_BACKGROUND_BRIGHT[code - 100] };
  return state;
}

/**
 * Parses SGR colour codes into styled runs. Non-SGR escapes are dropped: this
 * is a scrollback terminal, not a full VT100 emulator.
 */
export function parseGonaviAnsi(text: string): GonaviAnsiSegment[] {
  const segments: GonaviAnsiSegment[] = [];
  let state: AnsiState = {};
  let last = 0;
  for (const match of text.matchAll(ANSI_PATTERN)) {
    const value = text.slice(last, match.index ?? 0);
    if (value) segments.push({ text: value, ...state });
    // Only SGR changes style; cursor/screen escapes are dropped.
    if (match[2] === 'm') {
      const codes = match[1] === '' ? [0] : match[1].split(';').map((part) => Number.parseInt(part, 10) || 0);
      for (const code of codes) state = applySgr(state, code);
    }
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) segments.push({ text: rest, ...state });
  // Escape codes between two plain runs must not split the visible text.
  return segments.reduce<GonaviAnsiSegment[]>((merged, segment) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.foreground === segment.foreground && previous.background === segment.background
      && previous.bold === segment.bold && previous.dim === segment.dim) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
    return merged;
  }, []);
}

export interface GonaviTerminalProps {
  /** Full scrollback text. ANSI SGR colours are rendered; other escapes are dropped. */
  text: string;
  height?: number;
  readOnly?: boolean;
  placeholder?: string;
  onData?: (data: string) => void;
  className?: string;
}

/**
 * Host-styled scrollback terminal for plugin windows. The plugin owns the
 * stream and writes text; this component never interprets commands or runs
 * anything. Full VT100 (cursor addressing, alternate screen) is out of scope.
 */
export const GonaviTerminal: React.FC<GonaviTerminalProps> = ({
  text,
  height = 320,
  readOnly = false,
  placeholder,
  onData,
  className,
}) => {
  const [draft, setDraft] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);
  const segments = useMemo(() => parseGonaviAnsi(text), [text]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  const submit = () => {
    if (!onData) return;
    onData(draft + '\n');
    setDraft('');
  };

  return (
    <div className={`gonavi-terminal${className ? ' ' + className : ''}`} style={{ height }}>
      <pre ref={outputRef} className="gonavi-terminal-output" aria-live="polite">
        {segments.map((segment, index) => (
          <span
            key={index}
            style={{
              color: segment.foreground,
              background: segment.background,
              fontWeight: segment.bold ? 600 : undefined,
              opacity: segment.dim ? 0.7 : undefined,
            }}
          >
            {segment.text}
          </span>
        ))}
      </pre>
      {!readOnly && (
        <input
          className="gonavi-terminal-input"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
      )}
    </div>
  );
};
