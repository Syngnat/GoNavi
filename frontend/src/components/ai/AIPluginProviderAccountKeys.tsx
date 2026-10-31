import { useMemo, useState } from 'react';
import { accountGroupLabel, accountGroupTone, formatAccountTime, maskAccountKey, type AccountGroupItem, type AccountKeyItem } from './aiPluginProviderAccountApi';
import type { AccountKeysView } from './useAccountKeys';
import AIPluginProviderAccountKeyCreate from './AIPluginProviderAccountKeyCreate';
import AIPluginProviderAccountKeyEdit from './AIPluginProviderAccountKeyEdit';
import { ACCOUNT_KEY_PAGE_SIZE, pageAccountKeys } from './pageAccountKeys';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

interface AIPluginProviderAccountKeysProps {
  keys: AccountKeysView;
  groups: AccountGroupItem[];
  creating: boolean;
  mutating?: boolean;
  t: CopyText;
  onOpenCreate: () => void;
  onCreate: (name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onUpdate?: (id: string, name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onDelete?: (id: string) => Promise<{ ok: boolean; message: string }>;
  onUseKey?: (key: string) => void;
}

const groupLabel = (item: AccountKeyItem, t: CopyText): string =>
  accountGroupLabel(item.groupName, item.rateMultiplier, t);

const quotaLabel = (item: AccountKeyItem, t: CopyText): string => {
  if (!item.quota) return t('plugin.ai_provider.account.keys_unlimited');
  const remaining = item.quota - (item.quotaUsed ?? 0);
  const count = Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(2);
  return t('plugin.ai_provider.account.quota_remaining', { count });
};

const writeClipboard = async (text: string): Promise<boolean> => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 3l18 18" />
    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
    <path d="M9.9 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.2 18.2 0 0 1-3.2 3.9" />
    <path d="M6.1 6.1A18 18 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.2-.9" />
  </svg>
);

const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3-3" />
  </svg>
);

const ChevronIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {dir === 'left' ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
  </svg>
);

interface KeyRowProps {
  item: AccountKeyItem;
  revealed: boolean;
  copied: boolean;
  failed: boolean;
  t: CopyText;
  onCopy: () => void;
  onUse?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  confirmDelete?: boolean;
}

function KeyRow({ item, revealed, copied, failed, t, onCopy, onUse, onEdit, onDelete, confirmDelete }: KeyRowProps) {
  const group = groupLabel(item, t);
  const copyLabel = t(copied ? 'plugin.ai_provider.account.keys_copied' : 'plugin.ai_provider.account.keys_copy');
  const useLabel = t('plugin.ai_provider.account.keys_use');
  return (
    <li className="gn-account-key">
      <div className="gn-account-key-body">
        <div className="gn-account-key-top">
          <span className="gn-account-key-name" title={item.name || item.id}>{item.name || item.id}</span>
          {group && <span className="gn-account-key-group" data-tone={accountGroupTone(item.groupName)}>{group}</span>}
        </div>
        <div className="gn-account-key-line">
          <code className="gn-account-key-value">{revealed ? item.key : maskAccountKey(item.key)}</code>
          <span className="gn-account-key-meta">
            <span className="gn-account-key-fact">{quotaLabel(item, t)}</span>
            <span className="gn-account-key-sep">·</span>
            <span className="gn-account-key-fact">
              {formatAccountTime(item.lastUsedAt) || t('plugin.ai_provider.account.keys_never')}
            </span>
            {item.status && item.status !== 'active' && (
              <><span className="gn-account-key-sep">·</span><span className="gn-account-key-inactive">{item.status}</span></>
            )}
            {failed && <span className="gn-account-key-failed">{t('plugin.ai_provider.account.keys_copy_failed')}</span>}
          </span>
        </div>
      </div>
      <span className="gn-account-key-actions">
        {onUse && (
          <button type="button" className="gn-account-key-use" onClick={onUse}>{useLabel}</button>
        )}
        {onEdit && (
          <button type="button" className="gn-account-key-use" onClick={onEdit}>{t('plugin.ai_provider.account.keys_edit')}</button>
        )}
        {onDelete && (
          <button type="button" className={confirmDelete ? 'gn-account-key-delete is-on' : 'gn-account-key-delete'} onClick={onDelete}>
            {t(confirmDelete ? 'plugin.ai_provider.account.keys_delete_confirm' : 'plugin.ai_provider.account.keys_delete')}
          </button>
        )}
        <button type="button" className="gn-account-key-icon" aria-label={copyLabel} title={copyLabel} onClick={onCopy}>
          <CopyIcon />
        </button>
      </span>
    </li>
  );
}

function KeyListItem({
  item, groups, revealed, copied, failed, editing, confirmDelete, mutating, t,
  onUse, onEdit, onDelete, onCopy, onSave, onCancel,
}: {
  item: AccountKeyItem;
  groups: AccountGroupItem[];
  revealed: boolean;
  copied: boolean;
  failed: boolean;
  editing: boolean;
  confirmDelete: boolean;
  mutating?: boolean;
  t: CopyText;
  onUse?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy: () => void;
  onSave: (name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onCancel: () => void;
}) {
  const id = item.id || item.key;
  if (editing) {
    return (
      <li className="gn-account-key is-editing" key={id}>
        <AIPluginProviderAccountKeyEdit
          item={item}
          groups={groups}
          busy={Boolean(mutating)}
          t={t}
          onSave={onSave}
          onCancel={onCancel}
        />
      </li>
    );
  }
  return (
    <KeyRow
      key={id}
      item={item}
      revealed={revealed}
      copied={copied}
      failed={failed}
      t={t}
      onUse={onUse}
      onEdit={onEdit}
      confirmDelete={confirmDelete}
      onDelete={onDelete}
      onCopy={onCopy}
    />
  );
}

export default function AIPluginProviderAccountKeys({
  keys, groups, creating, mutating, t, onOpenCreate, onCreate, onUpdate, onDelete, onUseKey,
}: AIPluginProviderAccountKeysProps) {
  const [revealed, setRevealed] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null);
  const [editingId, setEditingId] = useState('');
  const [pendingDelete, setPendingDelete] = useState('');
  const items = useMemo(() => keys.items ?? [], [keys.items]);
  const paged = useMemo(() => pageAccountKeys(items, query, page), [items, query, page]);
  const revealLabel = t(revealed ? 'plugin.ai_provider.account.keys_hide' : 'plugin.ai_provider.account.keys_show');
  const onSearch = (value: string) => { setQuery(value); setPage(1); };

  if (keys.state === 'error') {
    return (
      <div className="gn-account-keys-error" role="alert">
        {t('plugin.ai_provider.account.keys_error', { message: keys.message || t('plugin.ai_provider.account.action_failed') })}
      </div>
    );
  }

  const waiting = keys.state === 'loading';

  return (
    <div className="gn-account-keys">
      <div className="gn-account-keys-head">
        <span className="gn-account-keys-title">{t('plugin.ai_provider.account.keys_title')}</span>
        {items.length > 0 && <span className="gn-account-keys-count">({items.length})</span>}
        {items.length > 0 && (
          <button
            type="button"
            className="gn-account-keys-reveal"
            aria-label={revealLabel}
            title={revealLabel}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
        <AIPluginProviderAccountKeyCreate
          groups={groups}
          creating={creating}
          t={t}
          onOpen={onOpenCreate}
          onCreate={onCreate}
        />
      </div>
      {items.length === 0 && !waiting ? (
        <p className="gn-account-keys-empty">{t('plugin.ai_provider.account.keys_empty')}</p>
      ) : items.length === 0 ? (
        <>
          <label className="gn-account-keys-search">
            <SearchIcon />
            <input type="search" value="" disabled placeholder={t('plugin.ai_provider.account.keys_search')} readOnly />
          </label>
          <div className="gn-account-key-viewport" />
        </>
      ) : (
        <>
          <label className="gn-account-keys-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder={t('plugin.ai_provider.account.keys_search')}
              onChange={(event) => onSearch(event.target.value)}
            />
          </label>
          <div className="gn-account-key-viewport">
            {paged.total === 0 ? (
              <p className="gn-account-keys-empty">{t('plugin.ai_provider.account.keys_none')}</p>
            ) : (
              <ul className="gn-account-key-list">
                {paged.slice.map((item) => (
                  <KeyListItem
                    key={item.id || item.key}
                    item={item}
                    groups={groups}
                    revealed={revealed}
                    copied={Boolean(copyState && copyState.id === item.id && copyState.ok)}
                    failed={Boolean(copyState && copyState.id === item.id && !copyState.ok)}
                    editing={Boolean(onUpdate && editingId === item.id)}
                    confirmDelete={pendingDelete === item.id}
                    mutating={mutating}
                    t={t}
                    onUse={onUseKey && item.key ? () => onUseKey(item.key) : undefined}
                    onEdit={onUpdate ? () => { setPendingDelete(''); setEditingId(item.id); } : undefined}
                    onDelete={onDelete ? () => {
                      if (pendingDelete !== item.id) {
                        setEditingId('');
                        setPendingDelete(item.id);
                        return;
                      }
                      void onDelete(item.id).then((result) => { if (result.ok) setPendingDelete(''); });
                    } : undefined}
                    onCopy={() => {
                      void (async () => {
                        const ok = await writeClipboard(item.key);
                        setCopyState({ id: item.id, ok });
                      })();
                    }}
                    onSave={async (name, groupId) => {
                      if (!onUpdate) return { ok: false, message: '' };
                      const result = await onUpdate(item.id, name, groupId);
                      if (result.ok) setEditingId('');
                      return result;
                    }}
                    onCancel={() => setEditingId('')}
                  />
                ))}
              </ul>
            )}
          </div>
          {paged.total > ACCOUNT_KEY_PAGE_SIZE && (
            <div className="gn-account-keys-pager">
              <span className="gn-account-keys-range">{t('plugin.ai_provider.account.keys_page', { from: paged.from, to: paged.to, total: paged.total })}</span>
              <button type="button" className="gn-account-keys-page" disabled={paged.page <= 1} aria-label={t('plugin.ai_provider.account.keys_prev')} onClick={() => setPage(paged.page - 1)}>
                <ChevronIcon dir="left" />
              </button>
              <button type="button" className="gn-account-keys-page" disabled={paged.page >= paged.pages} aria-label={t('plugin.ai_provider.account.keys_next')} onClick={() => setPage(paged.page + 1)}>
                <ChevronIcon dir="right" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
