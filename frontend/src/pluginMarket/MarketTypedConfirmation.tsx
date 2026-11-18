import { useState } from 'react';
import { Button, Checkbox, Input, Typography } from 'antd';
import { CheckCircleFilled, CopyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import type { MarketInstallIdentity } from './installIdentity';

interface Props {
  expected: MarketInstallIdentity;
  repository: string;
  matched: boolean;
  trusted: boolean;
  onRepositoryChange: (value: string) => void;
  onTrustedChange: (value: boolean) => void;
}

export function MarketTypedConfirmation({
  expected,
  repository,
  matched,
  trusted,
  onRepositoryChange,
  onTrustedChange,
}: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const mismatch = repository.trim().length > 0 && !matched;

  const copyRepository = async () => {
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(expected.repository);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const pasteRepository = async () => {
    setPasteFailed(false);
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error('clipboard empty');
      onRepositoryChange(value);
    } catch {
      setPasteFailed(true);
    }
  };

  return (
    <section className="market-install-identity" data-component="market-install-identity">
      <div className="market-install-identity-head">
        <span className="market-install-identity-icon" aria-hidden><SafetyCertificateOutlined /></span>
        <div className="market-install-identity-text">
          <Typography.Title level={5}>{t('plugin.market.install_typed_title')}</Typography.Title>
          <Typography.Text type="secondary">{t('plugin.market.install_typed_hint')}</Typography.Text>
        </div>
      </div>

      <div className="market-install-repo-row market-install-repo-readonly">
        <span className="market-install-repo-label">{t('plugin.market.install_repository')}</span>
        <code className="market-install-repo-value" title={expected.repository}>{expected.repository}</code>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={copyRepository}
          aria-label={t('plugin.market.install_copy')}
        >
          {copied ? t('plugin.market.install_copied') : t('plugin.market.install_copy')}
        </Button>
      </div>

      <div className="market-install-confirm-line">
        <span>{t('plugin.market.install_confirm_hint')}</span>
        {matched ? (
          <span className="market-install-match" aria-live="polite">
            <CheckCircleFilled /> {t('plugin.market.install_repository_match')}
          </span>
        ) : null}
      </div>

      <div className={`market-install-repo-row market-install-repo-input${matched ? ' is-matched' : ''}`}>
        <span className="market-install-repo-label">{t('plugin.market.install_repository')}</span>
        <Input
          variant="borderless"
          value={repository}
          maxLength={2048}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('plugin.market.install_repository_placeholder')}
          onChange={event => onRepositoryChange(event.target.value)}
          aria-label={t('plugin.market.install_repository')}
        />
        <Button type="text" size="small" onClick={pasteRepository}>{t('plugin.market.install_paste')}</Button>
      </div>

      <div className="market-install-identity-notes">
        {pasteFailed ? <Typography.Text type="danger">{t('plugin.market.install_paste_failed')}</Typography.Text> : null}
        {copyFailed ? <Typography.Text type="danger">{t('plugin.market.install_copy_failed')}</Typography.Text> : null}
        {mismatch ? <Typography.Text type="danger">{t('plugin.market.install_mismatch')}</Typography.Text> : null}
        <Typography.Text type="secondary">{t('plugin.market.install_repository_hint')}</Typography.Text>
      </div>

      <Checkbox checked={trusted} onChange={event => onTrustedChange(event.target.checked)}>
        {t('plugin.market.install_trust')}
      </Checkbox>
    </section>
  );
}
