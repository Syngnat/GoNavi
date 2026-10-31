import { useEffect, useRef, useState } from 'react';
import { maskAccountKey, type AccountKeyItem } from './aiPluginProviderAccountApi';

// The replace state reuses the saved-key capsule shape instead of the antd
// select chrome, so picking a key never looks like a different control.
const keyLabel = (item: AccountKeyItem): string =>
  item.name ? `${item.name} · ${maskAccountKey(item.key)}` : maskAccountKey(item.key);

export default function AIPluginProviderKeyPicker({
  value, choices, onChange, onPicked, autoOpen,
}: {
  value?: string;
  choices: AccountKeyItem[];
  onChange?: (value: string) => void;
  onPicked?: () => void;
  /** Opening on mount keeps the replace action from needing a second click. */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(autoOpen));
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const selected = choices.find((item) => item.key === value);
  const pick = (item: AccountKeyItem) => {
    onChange?.(item.key);
    setOpen(false);
    onPicked?.();
  };
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    const node = menuRef.current;
    if (!open || !node) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      const goingUp = event.deltaY < 0;
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if ((goingUp && atTop) || (!goingUp && atBottom)) event.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [open]);
  return (
    <div className="gn-key-picker" ref={rootRef}>
      <button
        type="button"
        className="gn-key-saved gn-key-picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="gn-key-saved-dot" aria-hidden="true" />
        <span className="gn-key-saved-text">
          {selected ? keyLabel(selected) : value ? maskAccountKey(value) : ''}
        </span>
        <span className="gn-key-picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="gn-key-picker-menu" role="listbox" ref={menuRef}>
          {choices.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={`gn-key-picker-option${item.key === value ? ' is-on' : ''}`}
                onClick={() => pick(item)}
              >
                <span className="gn-key-picker-name">{item.name || maskAccountKey(item.key)}</span>
                <span className="gn-key-picker-value">{maskAccountKey(item.key)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
