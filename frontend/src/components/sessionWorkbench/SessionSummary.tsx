import { Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import { sessionStateTone, type DatabaseSession } from './sessionWorkbenchModel';

export interface SessionSummaryProps {
  /** Sessions currently shown in the table (after filtering). */
  sessions: DatabaseSession[];
}

export default function SessionSummary({ sessions }: SessionSummaryProps) {
  const { t } = useI18n();
  const active = sessions.filter((session) => sessionStateTone(session.state) === 'active').length;
  return (
    <Typography.Text type="secondary" className="gn-session-workbench-summary">
      {t('session_workbench.summary', { total: sessions.length, active })}
    </Typography.Text>
  );
}
