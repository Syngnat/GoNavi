import { Button, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import type { MarketSource } from './types';

export function MarketSourceHeader({ source, refreshing, onRefresh }: { source: MarketSource; refreshing: boolean; onRefresh: () => void }) {
  const { t } = useI18n();
  return <header className="plugin-market-account">
    <div className="plugin-market-source-info"><div className="plugin-market-source-name">
      <Typography.Text strong ellipsis title={source.baseUrl}>{source.baseUrl}</Typography.Text>
      {source.trustedOfficial && <Tag color="success">{t('plugin.market.official')}</Tag>}
    </div><Typography.Text type="secondary">{t('plugin.market.anonymous_usage')}</Typography.Text></div>
    <Button icon={<ReloadOutlined aria-hidden />} loading={refreshing} onClick={onRefresh}>{t('plugin.action.refresh')}</Button>
  </header>;
}
