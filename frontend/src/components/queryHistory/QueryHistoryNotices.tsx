import { Alert } from 'antd';
import { useI18n } from '../../i18n/provider';
import SqlAuditHealthAlert from '../audit/SqlAuditHealthAlert';
import type { SQLAuditBackend } from '../audit/sqlAuditRpc';

interface QueryHistoryNoticesProps {
  backend: SQLAuditBackend;
  refreshKey: number;
  isActive: boolean;
}

/** 隐私说明 + 审计写入健康度，压成一行，把纵向空间让给记录列表。 */
export default function QueryHistoryNotices({ backend, refreshKey, isActive }: QueryHistoryNoticesProps) {
  const { t } = useI18n();
  const privacyText = `${t('query_history.privacy.title')} · ${t('query_history.privacy.description')}`;
  return (
    <div className="gn-qh-notices">
      <Alert
        className="gn-qh-privacy-note"
        type="info"
        showIcon
        message={(
          <span title={privacyText}>
            <strong>{t('query_history.privacy.title')}</strong>
            {' · '}
            {t('query_history.privacy.description')}
          </span>
        )}
      />
      <SqlAuditHealthAlert backend={backend} refreshKey={refreshKey} isActive={isActive} compact />
    </div>
  );
}
