import { Alert, Button } from 'antd';
import { useI18n } from '../i18n/provider';
export function SourceErrorNotice({ source, error, onRetry }: { source: string; error: string; onRetry: () => void }) {
 const { t } = useI18n();
 return <Alert type="error" showIcon message={t('plugin.market.source_failed', { source })} description={error} action={<Button onClick={onRetry}>{t('plugin.action.refresh')}</Button>} />;
}
