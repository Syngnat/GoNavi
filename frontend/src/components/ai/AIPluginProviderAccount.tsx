import { Button, Tooltip } from 'antd';
import { useOptionalI18n } from '../../i18n/provider';
import { t as translate } from '../../i18n';
import { formatAccountAmount, type AccountStatus } from './aiPluginProviderAccountApi';
import { usePluginProviderAccount, type PluginProviderAccountController } from './usePluginProviderAccount';
import AIPluginProviderAccountKeys from './AIPluginProviderAccountKeys';

interface AIPluginProviderAccountProps {
  pluginId?: string;
  /** The surrounding section already prints a heading, so the block can drop its own. */
  showTitle?: boolean;
  account?: PluginProviderAccountController;
  onUseKey?: (key: string) => void;
}

type CopyText = (key: string, params?: Record<string, string | number>) => string;

const accountMetrics = (status: AccountStatus | null | undefined, t: CopyText) => [
  { key: 'balance', label: t('plugin.ai_provider.account.metric_balance'), value: formatAccountAmount(status?.balance) },
  { key: 'frozen', label: t('plugin.ai_provider.account.metric_frozen'), value: formatAccountAmount(status?.frozenBalance) },
  { key: 'recharged', label: t('plugin.ai_provider.account.metric_recharged'), value: formatAccountAmount(status?.totalRecharged) },
  {
    key: 'concurrency',
    label: t('plugin.ai_provider.account.metric_concurrency'),
    value: status?.concurrency === undefined ? '-' : String(status.concurrency),
  },
];

// The account block opens the provider form, so it stays frameless: one header line,
// one ruled stat strip, then a quiet key list. No nested cards, no full-width buttons.
export default function AIPluginProviderAccount({ pluginId, showTitle = true, account: injected, onUseKey }: AIPluginProviderAccountProps) {
  const t = useOptionalI18n()?.t ?? translate;
  const owned = usePluginProviderAccount(injected ? undefined : pluginId);
  const account = injected ?? owned;
  if (!pluginId) return null;
  if (!account.visible && !account.pending) return null;

  const status = account.status;
  const ready = status?.state === 'ready';
  const showShell = account.pending || ready;
  const loginLoading = account.busy || account.polling;
  const email = status?.email || status?.userId || '';
  const metrics = accountMetrics(ready ? status : null, t);
  const keys = account.pending || account.keys.state === 'loading'
    ? { ...account.keys, state: 'loading' as const, items: account.keys.items }
    : account.keys;

  return (
    <section className="gn-account">
      {showShell ? (
        <>
          <header className="gn-account-head">
            <span className="gn-account-title">{t('plugin.ai_provider.account.current_account')}</span>
            <span className={`gn-account-email${email ? '' : ' is-pending'}`} title={email}>{email || '-'}</span>
            <span className="gn-account-actions">
              <Button type="text" size="small" onClick={account.onRefresh} loading={account.refreshing} disabled={!ready}>
                {t('plugin.ai_provider.account.refresh')}
              </Button>
              <Button type="text" size="small" className="gn-account-danger" onClick={account.onLogout} loading={account.busy} disabled={!ready}>
                {t('plugin.ai_provider.account.logout')}
              </Button>
            </span>
          </header>
          <dl className="gn-account-stats">
            {metrics.map((metric) => (
              <div className="gn-account-stat" key={metric.key}>
                <dt className="gn-account-stat-label">{metric.label}</dt>
                <dd className={`gn-account-stat-value${ready ? '' : ' is-pending'}`}>{metric.value}</dd>
              </div>
            ))}
          </dl>
          <AIPluginProviderAccountKeys
            keys={keys}
            groups={account.groups}
            creating={account.creating}
            mutating={account.mutating}
            t={t}
            onOpenCreate={account.onOpenCreate}
            onCreate={account.onCreateKey}
            onUpdate={account.onUpdateKey}
            onDelete={account.onDeleteKey}
            onUseKey={onUseKey}
          />
        </>
      ) : (
        <>
          <header className="gn-account-head">
            {showTitle && <span className="gn-account-title">{t('plugin.ai_provider.account.title')}</span>}
          </header>
          <div className="gn-account-empty">
            <span className="gn-account-avatar" aria-hidden="true">華</span>
            <div className="gn-account-empty-copy">
              <span className="gn-account-empty-title">{t('plugin.ai_provider.account.signed_out_hint')}</span>
              {account.timedOut && (
                <span className="gn-account-empty-note" role="status">{t('plugin.ai_provider.account.login_timeout')}</span>
              )}
            </div>
            <Tooltip title={account.polling ? t('plugin.ai_provider.account.login_waiting') : ''}>
              <Button size="small" onClick={account.onLogin} loading={loginLoading}>
                {t(loginLoading ? 'plugin.ai_provider.account.login_waiting' : 'plugin.ai_provider.account.login')}
              </Button>
            </Tooltip>
          </div>
        </>
      )}

      {account.error && <p className="gn-account-error" role="alert">{account.error}</p>}
    </section>
  );
}
