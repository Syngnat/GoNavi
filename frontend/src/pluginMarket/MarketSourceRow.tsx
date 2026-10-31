import { useId } from 'react';
import { Button, Checkbox, Input, Tag } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import type { MarketSource } from './types';

export interface SourceDraft extends MarketSource { key: string }
interface Props { row: SourceDraft; index: number; allowed: boolean; busy: boolean; onChange: (patch: Partial<SourceDraft>) => void; onRemove: () => void }
export function MarketSourceRow({ row, index, allowed, busy, onChange, onRemove }: Props) {
  const { t } = useI18n();
  const inputId = useId();
  return <div className="plugin-market-source-row" data-official={row.trustedOfficial}>
    <div className="plugin-market-source-row-header">
      <label htmlFor={inputId}>{row.trustedOfficial ? <Tag color="success">{t('plugin.market.official')}</Tag> : t('plugin.market.sources_custom', { index })}</label>
      <div className="plugin-market-source-row-actions">
        <Checkbox aria-label={t('plugin.market.sources_enable_for', { source: row.baseUrl || index })} checked={row.enabled}
          disabled={!allowed || busy} onChange={(event) => { if (allowed && !busy) onChange({ enabled: event.target.checked }); }}>{t('plugin.market.sources_enabled')}</Checkbox>
        {!row.trustedOfficial && <Button danger type="text" icon={<DeleteOutlined aria-hidden />}
          aria-label={t('plugin.market.sources_remove_for', { source: row.baseUrl || index })} disabled={!allowed || busy} onClick={onRemove} />}
      </div>
    </div>
    <Input id={inputId} value={row.baseUrl} maxLength={2048} readOnly={row.trustedOfficial || !allowed} disabled={busy}
      autoComplete="url" spellCheck={false} onChange={(event) => { if (allowed && !busy && !row.trustedOfficial) onChange({ baseUrl: event.target.value }); }} />
  </div>;
}
