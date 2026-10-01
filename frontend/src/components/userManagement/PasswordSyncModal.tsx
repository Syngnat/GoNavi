import { useState } from 'react';
import { Alert, Button } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { SavedConnection } from '../../types';
import Modal from '../common/ResizableDraggableModal';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';

interface PasswordSyncModalProps {
  connection: SavedConnection;
  password: string;
  backend: UserManagementBackend;
  onClose: () => void;
}

/**
 * 修改的是本连接自身的登录账号口令时，提示同步更新已保存的连接口令，
 * 否则下次连接会因旧口令失败。口令只在本次调用中传给后端 secretstore。
 */
export default function PasswordSyncModal({ connection, password, backend, onClose }: PasswordSyncModalProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!password) return null;

  const sync = async () => {
    setBusy(true);
    setError('');
    try {
      const call = requireUserManagementMethod(backend, 'UserMgmtSyncConnectionPassword');
      unwrapUserManagementResult(await call(connection.id, password));
      onClose();
    } catch (err) {
      setError(resolveUserManagementErrorMessage(err, t('user_management.password_sync.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t('user_management.password_sync.title')}
      onCancel={onClose}
      footer={[
        <Button key="skip" onClick={onClose}>{t('user_management.password_sync.skip')}</Button>,
        <Button key="sync" type="primary" loading={busy} onClick={() => void sync()}>{t('user_management.password_sync.confirm')}</Button>,
      ]}
    >
      <p>{t('user_management.password_sync.description', { name: connection.name })}</p>
      {error && <Alert type="error" showIcon message={error} />}
    </Modal>
  );
}
