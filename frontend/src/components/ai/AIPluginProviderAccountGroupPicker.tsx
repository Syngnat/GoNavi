import { useEffect, useRef, useState } from 'react';
import { accountGroupLabel, accountGroupTone, type AccountGroupItem } from './aiPluginProviderAccountApi';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

const GroupChip = ({ name, rate, t }: { name: string; rate?: number; t: CopyText }) => (
  <span className="gn-account-key-group" data-tone={accountGroupTone(name)}>
    {accountGroupLabel(name, rate, t)}
  </span>
);

export default function AIPluginProviderAccountGroupPicker({
  groups, groupId, t, onChange,
}: {
  groups: AccountGroupItem[];
  groupId: string;
  t: CopyText;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  const selected = groups.find((group) => group.id === groupId);
  const pick = (id: string) => { onChange(id); setOpen(false); };
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
    <div className="gn-account-key-select">
      <button
        type="button"
        className="gn-account-key-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selected
          ? <GroupChip name={selected.name} rate={selected.rateMultiplier} t={t} />
          : <span className="gn-account-key-select-placeholder">{t('plugin.ai_provider.account.keys_group_none')}</span>}
      </button>
      {open && (
        <ul className="gn-account-group-menu" role="listbox" ref={menuRef}>
          <li>
            <button type="button" className={`gn-account-group-option${groupId ? '' : ' is-on'}`} onClick={() => pick('')}>
              {t('plugin.ai_provider.account.keys_group_none')}
            </button>
          </li>
          {groups.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                className={`gn-account-group-option${groupId === group.id ? ' is-on' : ''}`}
                onClick={() => pick(group.id)}
              >
                <GroupChip name={group.name} rate={group.rateMultiplier} t={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
