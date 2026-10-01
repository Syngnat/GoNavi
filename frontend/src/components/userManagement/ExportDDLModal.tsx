import { useEffect, useState } from 'react';
import { Alert, Button, Spin, message } from 'antd';
import { GnCopyIcon } from '../icons/gnIcons';
import { useI18n } from '../../i18n/provider';
import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import Modal from '../common/ResizableDraggableModal';
import { principalDisplayName } from './userManagementModel';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';
import type { UMPrincipal } from './userManagementTypes';

interface ExportDDLModalProps {
  principal: UMPrincipal | null;
  backend: UserManagementBackend;
  config: RpcConnectionConfig;
  onClose: () => void;
}

/** 导出账号脚本（口令哈希已由后端脱敏），用于迁移或审阅。 */
export default function ExportDDLModal({ principal, backend, config, onClose }: ExportDDLModalProps) {
  const { t } = useI18n();
  const [ddl, setDDL] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDDL('');
    setError('');
    if (!principal) return undefined;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const call = requireUserManagementMethod(backend, 'UserMgmtExportDDL');
        const data = unwrapUserManagementResult(await call(config, principal.ref));
        if (alive) setDDL(String(data || ''));
      } catch (err) {
        if (alive) setError(resolveUserManagementErrorMessage(err, t('user_management.error.export_failed')));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [backend, config, principal, t]);

  if (!principal) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ddl);
      message.success(t('user_management.export.copied'));
    } catch {
      message.error(t('user_management.export.copy_failed'));
    }
  };

  return (
    <Modal
      open
      width={760}
      title={t('user_management.export.title', { name: principalDisplayName(principal.ref) })}
      onCancel={onClose}
      footer={[
        <Button key="copy" icon={<GnCopyIcon />} disabled={!ddl} onClick={() => void copy()}>{t('user_management.export.copy')}</Button>,
        <Button key="close" type="primary" onClick={onClose}>{t('user_management.apply.close')}</Button>,
      ]}
    >
      <Alert type="info" showIcon message={t('user_management.export.redacted')} />
      {loading ? <Spin /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {ddl && <pre className="gn-user-mgmt-preview-code">{ddl}</pre>}
    </Modal>
  );
}
