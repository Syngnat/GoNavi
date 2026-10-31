import { useRef, useState } from 'react';
import { Alert, Button, Modal, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import type { MarketSources } from './useMarketSources';
import { MarketSourceRow, type SourceDraft } from './MarketSourceRow';
import { MAX_MARKET_SOURCES, sourceConfigError } from './sourceConfig';

interface Props { manager: MarketSources; allowed: boolean; onClose: () => void }
export function MarketSourceSettings({ manager, allowed, onClose }: Props) {
  const { t } = useI18n();
  const nextId = useRef(0);
  const [rows, setRows] = useState<SourceDraft[]>(() => manager.sources.map((source) => ({ ...source, key: source.sourceId })));
  const error = sourceConfigError(rows);
  const save = async () => {
    if (!allowed || manager.busy || error) return;
    if (await manager.save(rows.map(({ baseUrl, enabled }) => ({ baseUrl: baseUrl.trim(), enabled })))) onClose();
  };
  return <Modal open width={720} className="plugin-market-source-manager" title={t('plugin.market.sources_title')}
    maskClosable={!manager.busy} onCancel={() => { if (!manager.busy) onClose(); }} footer={[
      <Button key="cancel" disabled={manager.busy} onClick={onClose}>{t('common.cancel')}</Button>,
      <Button key="save" type="primary" disabled={!allowed || Boolean(error)} loading={manager.busy} onClick={() => void save()}>{t('plugin.market.sources_save')}</Button>,
    ]}>
    <div className="plugin-stack">
      <Typography.Paragraph type="secondary">{t('plugin.market.sources_hint')}</Typography.Paragraph>
      {manager.error && <Alert type="error" showIcon message={manager.error} />}
      {rows.map((row, index) => <MarketSourceRow key={row.key} row={row} index={index + 1} allowed={allowed} busy={manager.busy}
        onChange={(patch) => setRows((previous) => previous.map((item) => item.key === row.key ? { ...item, ...patch } : item))}
        onRemove={() => { if (allowed && !manager.busy && !row.trustedOfficial) setRows((previous) => previous.filter((item) => item.key !== row.key)); }} />)}
      {error && <Alert type="warning" showIcon message={t(error, { count: MAX_MARKET_SOURCES })} />}
      <Button block icon={<PlusOutlined aria-hidden />} disabled={!allowed || manager.busy || rows.length >= MAX_MARKET_SOURCES}
        onClick={() => { if (allowed && !manager.busy && rows.length < MAX_MARKET_SOURCES) setRows((previous) => [...previous,
          { key: 'new-' + ++nextId.current, sourceId: '', baseUrl: '', enabled: true, trustedOfficial: false }]); }}>{t('plugin.market.sources_add')}</Button>
    </div>
  </Modal>;
}
