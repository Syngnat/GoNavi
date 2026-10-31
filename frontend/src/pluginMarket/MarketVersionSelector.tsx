import { Alert, Button, Select, Spin, Tag, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { isPrerelease } from './versionChoices';
import './marketVersions.css';
import type { MarketVersionChoice } from './versionsApi';
interface Props { versions: MarketVersionChoice[]; selectedVersion?: string; recommended?: string; installedVersion?: string; loading: boolean; error: string; warning: string; source: string; onChange: (value: string) => void; onRetry: () => void }
export function MarketVersionSelector({ versions, selectedVersion, recommended, installedVersion, loading, error, warning, source, onChange, onRetry }: Props) {
 const { t } = useI18n();
 const selected = versions.find((choice) => choice.plugin.version === selectedVersion);
 return <section className="market-version-section" aria-label={t('plugin.market.versions.title')}>
  <div className="market-version-heading"><Typography.Text strong>{t('plugin.market.versions.title')}</Typography.Text>{loading && <Spin size="small" />}</div>
  {error && <Alert type="error" showIcon message={t('plugin.market.versions.unavailable', { source })} description={error} action={<Button onClick={onRetry}>{t('plugin.action.refresh')}</Button>} />}
  {warning && <Alert type="warning" showIcon message={t('plugin.market.versions.history_unavailable')} />}
  {!loading && !error && !recommended && !selectedVersion && <Alert type="info" showIcon message={t('plugin.market.versions.none_stable')} />}
  <Select<string> className="market-version-select" aria-label={t('plugin.market.versions.select')} value={selectedVersion} placeholder={t('plugin.market.versions.select')} loading={loading} disabled={loading || !versions.length} onChange={onChange}
   options={versions.map(({ plugin, compatible, reason }) => ({ value: plugin.version, disabled: !compatible, label: <span className="market-version-option"><code>{plugin.version}</code>
    {plugin.version === recommended && <Tag color="blue">{t('plugin.market.versions.recommended')}</Tag>}
    {plugin.version === installedVersion && <Tag>{t('plugin.market.versions.installed')}</Tag>}
    {isPrerelease(plugin.version) && <Tag color="warning">{t('plugin.market.versions.prerelease')}</Tag>}
    {!compatible && <Tag color="error">{t('plugin.market.versions.incompatible')}</Tag>}
    {!compatible && reason && <span className="market-version-reason">{t('plugin.market.versions.' + reason)}</span>}</span> }))} />
  {selected && <Typography.Text type="secondary">{t('plugin.market.versions.compatible')} · {selected.plugin.platforms.join(', ')}{selected.plugin.minHostVersion ? ' · ' + t('plugin.market.requires_host', { version: selected.plugin.minHostVersion }) : ''}</Typography.Text>}
  {selected && isPrerelease(selected.plugin.version) && <Alert type="warning" showIcon message={t('plugin.market.versions.prerelease_warning')} />}
 </section>;
}
