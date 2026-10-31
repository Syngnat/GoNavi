import { useState } from 'react';
import type { AccountGroupItem } from './aiPluginProviderAccountApi';
import AIPluginProviderAccountGroupPicker from './AIPluginProviderAccountGroupPicker';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

interface AIPluginProviderAccountKeyCreateProps {
  groups: AccountGroupItem[];
  creating: boolean;
  t: CopyText;
  onOpen: () => void;
  onCreate: (name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
}

export default function AIPluginProviderAccountKeyCreate({
  groups, creating, t, onOpen, onCreate,
}: AIPluginProviderAccountKeyCreateProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [message, setMessage] = useState('');

  const close = () => {
    setOpen(false);
    setName('');
    setGroupId('');
    setMessage('');
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setMessage(t('plugin.ai_provider.account.keys_name'));
      return;
    }
    const parsed = groupId ? Number(groupId) : undefined;
    const result = await onCreate(trimmed, Number.isFinite(parsed) ? parsed : undefined);
    if (result.ok) close();
    else setMessage(result.message || t('plugin.ai_provider.account.action_failed'));
  };

  if (!open) {
    return (
      <button
        type="button"
        className="gn-account-keys-create"
        onClick={() => { setOpen(true); onOpen(); }}
      >
        <span aria-hidden="true">+</span>
        {t('plugin.ai_provider.account.keys_create')}
      </button>
    );
  }

  // Same rule as the edit row: never nest a real form inside the provider form.
  return (
    <div className="gn-account-key-form">
      <input
        className="gn-account-key-input"
        value={name}
        maxLength={64}
        placeholder={t('plugin.ai_provider.account.keys_name_placeholder')}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }}
        autoFocus
      />
      <AIPluginProviderAccountGroupPicker groups={groups} groupId={groupId} t={t} onChange={setGroupId} />
      <button type="button" className="gn-account-key-submit" disabled={creating} onClick={() => void submit()}>
        {t('plugin.ai_provider.account.keys_create_submit')}
      </button>
      <button type="button" className="gn-account-key-cancel" onClick={close} disabled={creating}>
        {t('common.cancel')}
      </button>
      {message && <span className="gn-account-key-form-error" role="alert">{message}</span>}
    </div>
  );
}
