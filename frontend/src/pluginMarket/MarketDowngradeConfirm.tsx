import { useState } from 'react';
import { Alert, Checkbox, Modal } from 'antd';
import { useI18n } from '../i18n/provider';
interface Props { from: string; to: string; onCancel: () => void; onConfirm: () => void }
export function MarketDowngradeConfirm({ from, to, onCancel, onConfirm }: Props) {
 const { t } = useI18n(); const [accepted, setAccepted] = useState(false);
 return <Modal open title={t('plugin.market.versions.downgrade_title')} onCancel={onCancel} onOk={() => { if (accepted) onConfirm(); }} okText={t('plugin.market.versions.downgrade_confirm')} okButtonProps={{ danger: true, disabled: !accepted }} destroyOnClose>
  <Alert type="warning" showIcon message={t('plugin.market.versions.downgrade_warning', { from, to })} />
  <Checkbox checked={accepted} onChange={(event) => setAccepted(event.target.checked)}>{t('plugin.market.versions.downgrade_ack')}</Checkbox>
 </Modal>;
}
