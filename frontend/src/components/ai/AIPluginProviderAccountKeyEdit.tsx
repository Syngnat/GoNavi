import { useState } from 'react';
import type { AccountGroupItem, AccountKeyItem } from './aiPluginProviderAccountApi';
import AIPluginProviderAccountGroupPicker from './AIPluginProviderAccountGroupPicker';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

const resolveGroupId = (item: AccountKeyItem, groups: AccountGroupItem[]): string => {
  if (item.groupId) return item.groupId;
  const match = groups.find((group) => group.name === item.groupName);
  return match?.id ?? '';
};

export default function AIPluginProviderAccountKeyEdit({
  item, groups, busy, t, onSave, onCancel,
}: {
  item: AccountKeyItem;
  groups: AccountGroupItem[];
  busy: boolean;
  t: CopyText;
  onSave: (name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [groupId, setGroupId] = useState(resolveGroupId(item, groups));
  const [message, setMessage] = useState('');

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setMessage(t('plugin.ai_provider.account.keys_name'));
      return;
    }
    const parsed = groupId ? Number(groupId) : 0;
    const result = await onSave(trimmed, Number.isFinite(parsed) ? parsed : 0);
    if (!result.ok) setMessage(result.message || t('plugin.ai_provider.account.action_failed'));
  };

  // No <form> here: the editor already renders one, and a nested submit would
  // reach the outer form and reload the window. Enter is handled on the field.
  return (
    <div className="gn-account-key-form is-row">
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
      <button type="button" className="gn-account-key-submit" disabled={busy} onClick={() => void submit()}>
        {t('plugin.ai_provider.account.keys_save')}
      </button>
      <button type="button" className="gn-account-key-cancel" onClick={onCancel} disabled={busy}>
        {t('common.cancel')}
      </button>
      {message && <span className="gn-account-key-form-error" role="alert">{message}</span>}
    </div>
  );
}
