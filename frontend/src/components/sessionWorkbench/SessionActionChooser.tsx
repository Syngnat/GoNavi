import { Modal } from 'antd';
import { useI18n } from '../../i18n/provider';
import {
  actionHelperKey,
  actionLabelKey,
  availableSessionActions,
  type DatabaseSession,
  type SessionAction,
  type SessionCapability,
} from './sessionWorkbenchModel';

export interface SessionActionChooserProps {
  open: boolean;
  session: DatabaseSession | null;
  capability: SessionCapability;
  onSelect: (action: SessionAction) => void;
  onCancel: () => void;
}

export default function SessionActionChooser({
  open,
  session,
  capability,
  onSelect,
  onCancel,
}: SessionActionChooserProps) {
  const { t } = useI18n();
  if (!session) return null;
  const actions = availableSessionActions(capability, session);
  return (
    <Modal
      open={open}
      className="gn-session-workbench-modal"
      title={t('session_workbench.action.choose')}
      onCancel={onCancel}
      footer={null}
      destroyOnClose
    >
      {/*
        Native buttons on purpose: the v2 theme pins .ant-radio-button-wrapper
        and .ant-btn to a fixed 28px height with !important, which clipped the
        two-line option (label + helper) and hid the helper text.
      */}
      <div
        className="gn-session-workbench-action-chooser"
        role="group"
        aria-label={t('session_workbench.action.choose')}
      >
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`gn-session-workbench-action-option is-${action === 'terminateSession' ? 'terminate' : 'cancel'}`}
            onClick={() => onSelect(action)}
          >
            <strong className="gn-session-workbench-action-option-title">{t(actionLabelKey(action))}</strong>
            <span className="gn-session-workbench-action-option-helper">{t(actionHelperKey(action))}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
