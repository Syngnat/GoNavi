import { Alert, Spin, Tag } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { useStore } from '../../../store';
import TableDesignerSqlPreview from '../../TableDesignerSqlPreview';
import UserManagementEmpty from '../UserManagementEmpty';
import { GnCheckCircleIcon } from '../userManagementIcons';
import type { UMPlan } from '../userManagementTypes';

interface PreviewTabProps {
  family: string;
  plan: UMPlan | null;
  loading: boolean;
  error: string;
  hasChanges: boolean;
  height?: string;
}

const COMMAND_FAMILIES = new Set(['mongodb', 'redis']);

export const joinPlanStatements = (plan: UMPlan, family: string): string => {
  const separator = COMMAND_FAMILIES.has(family) ? '\n' : ';\n';
  const suffix = COMMAND_FAMILIES.has(family) ? '' : ';';
  return plan.statements.map((statement) => statement.display).join(separator) + (plan.statements.length > 0 ? suffix : '');
};

/** 语句预览：口令位置由后端统一掩码，这里只做展示。 */
export default function PreviewTab({ family, plan, loading, error, hasChanges, height = '320px' }: PreviewTabProps) {
  const { t } = useI18n();
  const darkMode = useStore((state) => state.theme) === 'dark';
  if (!hasChanges) return <UserManagementEmpty icon={<GnCheckCircleIcon />} text={t('user_management.preview.no_changes')} />;
  if (error) return <Alert type="error" showIcon message={error} />;
  if (!plan) return <div className="gn-user-mgmt-preview-loading"><Spin spinning={loading} /></div>;
  const hasDanger = plan.statements.some((statement) => statement.risk === 'danger');
  const hasHigh = plan.statements.some((statement) => statement.risk === 'high');
  return (
    <div className="gn-user-mgmt-preview">
      <div className="gn-user-mgmt-preview-meta">
        <Tag>{t('user_management.preview.count', { count: plan.statements.length })}</Tag>
        {plan.transactional && <Tag color="green">{t('user_management.preview.transactional')}</Tag>}
        {plan.statements.some((statement) => statement.eachNode) && <Tag color="blue">{t('user_management.preview.each_node')}</Tag>}
        {hasDanger && <Tag color="red">{t('user_management.preview.danger')}</Tag>}
        {!hasDanger && hasHigh && <Tag color="orange">{t('user_management.preview.high')}</Tag>}
        {loading && <Spin size="small" />}
      </div>
      {COMMAND_FAMILIES.has(family) ? (
        <pre className="gn-user-mgmt-preview-code">{joinPlanStatements(plan, family)}</pre>
      ) : (
        <TableDesignerSqlPreview sql={joinPlanStatements(plan, family)} darkMode={darkMode} height={height} />
      )}
      {plan.notices.map((notice) => (
        <Alert key={notice.code} type={notice.level === 'danger' ? 'error' : notice.level === 'warning' ? 'warning' : 'info'} showIcon message={notice.text || notice.code} />
      ))}
    </div>
  );
}
