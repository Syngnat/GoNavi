import { useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import { CheckCircleFilled, CopyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { PluginInspection } from '../plugins/types';
import { useI18n } from '../i18n/provider';
import { formatBytes } from '../utils/byteSize';

interface Props {
  inspection: PluginInspection;
  official?: boolean;
}

export function MarketPackageSummary({ inspection, official }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const manifest = inspection.manifest;

  const copyDigest = async () => {
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(inspection.digest);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <section className="market-install-package" data-component="market-install-package">
      <div className="market-install-package-main">
        <span className="market-install-package-icon" aria-hidden>
          <SafetyCertificateOutlined />
        </span>
        <div className="market-install-package-text">
          <div className="market-install-package-title-row">
            <Typography.Text strong className="market-install-package-title">{manifest.name || manifest.id}</Typography.Text>
            {official ? <Tag color="blue">{t('plugin.market.official')}</Tag> : null}
            <Tag>{manifest.version}</Tag>
          </div>
          <div className="market-install-package-meta">
            <span className="market-install-package-checked"><CheckCircleFilled /> {t('plugin.market.install_package_checked')}</span>
            <span>{t('plugin.label.size')} {formatBytes(inspection.sizeBytes)}</span>
          </div>
        </div>
      </div>
      <div className="market-install-package-digest">
        <span className="market-install-package-digest-label">SHA-256</span>
        <code title={inspection.digest}>{inspection.digest}</code>
        <Button
          size="small"
          type="text"
          icon={copied ? <CheckCircleFilled /> : <CopyOutlined />}
          onClick={copyDigest}
        >
          {copied ? t('plugin.market.install_copied') : t('plugin.market.install_copy')}
        </Button>
      </div>
      {copyFailed ? <Typography.Text type="danger">{t('plugin.market.install_copy_failed')}</Typography.Text> : null}
    </section>
  );
}
