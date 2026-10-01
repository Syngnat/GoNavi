import { Alert, Button, List, Tag } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { GnCheckCircleIcon, GnCloseCircleIcon, GnMinusCircleIcon } from './userManagementIcons';
import { useI18n } from '../../i18n/provider';
import PreviewTab from './editor/PreviewTab';
import type { UserManagementApplyOutcome } from './useUserManagementApply';
import type { UMPlan } from './userManagementTypes';

interface ApplyReviewModalProps {
  open: boolean;
  family: string;
  plan: UMPlan | null;
  previewLoading: boolean;
  previewError: string;
  applying: boolean;
  outcome: UserManagementApplyOutcome | null;
  onApply: () => void;
  onClose: () => void;
}

/** 执行前评审（语句 + 提示）与执行后逐条结果。 */
export default function ApplyReviewModal({ open, family, plan, previewLoading, previewError, applying, outcome, onApply, onClose }: ApplyReviewModalProps) {
  const { t } = useI18n();
  const done = Boolean(outcome);
  const footer = done
    ? [<Button key="close" type="primary" onClick={onClose}>{t('user_management.apply.close')}</Button>]
    : [
      <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
      <Button key="apply" type="primary" danger={plan?.statements.some((statement) => statement.risk === 'danger')} loading={applying} disabled={!plan || previewLoading || Boolean(previewError)} onClick={onApply}>
        {t('user_management.apply.execute')}
      </Button>,
    ];

  return (
    <Modal open={open} title={done ? t('user_management.apply.result_title') : t('user_management.apply.review_title')} width={760} onCancel={onClose} footer={footer} destroyOnHidden>
      {!done && <PreviewTab family={family} plan={plan} loading={previewLoading} error={previewError} hasChanges height="260px" />}
      {outcome && (
        <div className="gn-user-mgmt-outcome">
          <Alert type={outcome.success ? 'success' : 'error'} showIcon message={outcome.message || (outcome.success ? t('user_management.apply.success') : t('user_management.error.apply_failed'))} />
          {outcome.report?.rolledBack && <Alert type="info" showIcon message={t('user_management.apply.rolled_back')} />}
          {outcome.report?.notices.map((notice) => <Alert key={notice.code} type="warning" showIcon message={notice.text || notice.code} />)}
          {outcome.report && outcome.report.results.length > 0 && (
            <List
              size="small"
              dataSource={outcome.report.results}
              renderItem={(item) => (
                <List.Item className="gn-user-mgmt-outcome-item">
                  {item.success ? <GnCheckCircleIcon className="is-success" /> : item.skipped ? <GnMinusCircleIcon className="is-skipped" /> : <GnCloseCircleIcon className="is-failed" />}
                  <code>{item.display}</code>
                  {item.node && <Tag>{item.node}</Tag>}
                  {item.error && <div className="gn-user-mgmt-outcome-error">{item.error}</div>}
                </List.Item>
              )}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
