import { Alert, Input, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import type { MarketInstallIdentity } from './installIdentity';

interface Props {
  expected: MarketInstallIdentity;
  name: string;
  repository: string;
  matched: boolean;
  onNameChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
}

export function MarketTypedConfirmation({ expected, name, repository, matched, onNameChange, onRepositoryChange }: Props) {
  const { t } = useI18n();
  const showMismatch = name.trim().length > 0 && repository.trim().length > 0 && !matched;
  return <section className="market-install-confirmation">
    <div>
      <Typography.Title level={5}>{t('plugin.market.install_typed_title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('plugin.market.install_typed_hint')}</Typography.Paragraph>
    </div>
    <div className="market-install-confirmation-grid">
      <label className="market-install-confirmation-field">
        <span>{t('plugin.market.install_name')}</span>
        <Input aria-label={t('plugin.market.install_name')} value={name} maxLength={256} autoComplete="off" spellCheck={false}
          placeholder={t('plugin.market.install_name')} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <label className="market-install-confirmation-field">
        <span>{t('plugin.market.install_repository')}</span>
        <Input aria-label={t('plugin.market.install_repository')} value={repository} maxLength={2048} autoComplete="off" spellCheck={false}
          placeholder={t('plugin.market.install_repository')} onChange={(event) => onRepositoryChange(event.target.value)} />
      </label>
    </div>
    <Typography.Text type="secondary">{t('plugin.market.install_repository_hint')}</Typography.Text>
    <div className="market-install-expected" aria-live="polite">
      <span>{t('plugin.market.install_name')}: <code>{expected.name}</code></span>
      <span>{t('plugin.market.install_repository')}: <code>{expected.repository}</code></span>
    </div>
    {showMismatch && <Alert type="warning" showIcon message={t('plugin.market.install_mismatch')} />}
  </section>;
}
