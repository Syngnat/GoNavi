import { Alert } from 'antd';
import { useI18n } from '../i18n/provider';

interface Props {
  error: string;
  consumed: boolean;
  installing: boolean;
}

export function MarketInspectionNotices({ error, consumed, installing }: Props) {
  const { t } = useI18n();
  return (
    <>
      {error ? <Alert showIcon type="warning" message={error} /> : null}
      {consumed && !installing ? <Alert showIcon type="info" message={t('plugin.market.inspection_used')} /> : null}
    </>
  );
}
