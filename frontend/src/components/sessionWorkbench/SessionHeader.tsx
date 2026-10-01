import { Tag, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';

export interface SessionHeaderProps {
  /** Engine reported by the last successful list call, e.g. "mysql". */
  engine?: string;
}

export default function SessionHeader({ engine }: SessionHeaderProps) {
  const { t } = useI18n();
  return (
    <div className="gn-session-workbench-header">
      <div>
        <Typography.Title level={4}>{t('session_workbench.title')}</Typography.Title>
        <Typography.Text type="secondary" className="gn-session-workbench-description">
          {t('session_workbench.description')}
        </Typography.Text>
      </div>
      {engine ? <Tag className="gn-session-workbench-engine">{engine}</Tag> : null}
    </div>
  );
}
