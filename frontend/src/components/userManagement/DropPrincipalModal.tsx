import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Select, Space, Spin } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import Modal from '../common/ResizableDraggableModal';
import { normalizeImpact, principalDisplayName } from './userManagementModel';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';
import type { UserManagementApplyOutcome } from './useUserManagementApply';
import type { UMDropImpact, UMDropOptions, UMPrincipal } from './userManagementTypes';

interface DropPrincipalModalProps {
  principal: UMPrincipal | null;
  principals: UMPrincipal[];
  backend: UserManagementBackend;
  config: RpcConnectionConfig;
  onDrop: (options: UMDropOptions) => Promise<UserManagementApplyOutcome | null>;
  onClose: () => void;
}

/** 删除前影响分析（DEFINER 对象、拥有的对象/模式、在线会话）与级联/转交选项。 */
export default function DropPrincipalModal({ principal, principals, backend, config, onDrop, onClose }: DropPrincipalModalProps) {
  const { t } = useI18n();
  const [impact, setImpact] = useState<UMDropImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [options, setOptions] = useState<UMDropOptions>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UserManagementApplyOutcome | null>(null);

  useEffect(() => {
    setImpact(null);
    setError('');
    setOptions({});
    setOutcome(null);
    if (!principal) return undefined;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const call = requireUserManagementMethod(backend, 'UserMgmtDropImpact');
        const data = unwrapUserManagementResult(await call(config, principal.ref));
        if (alive) setImpact(normalizeImpact(data));
      } catch (err) {
        if (alive) setError(resolveUserManagementErrorMessage(err, t('user_management.error.impact_failed')));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [backend, config, principal, t]);

  if (!principal) return null;
  const reassignCandidates = principals.filter((item) => item.ref.name !== principal.ref.name);

  const submit = async () => {
    setBusy(true);
    const result = await onDrop(options);
    setBusy(false);
    if (!result) return;
    if (result.success) onClose();
    else setOutcome(result);
  };

  return (
    <Modal
      open
      title={t('user_management.drop.title', { name: principalDisplayName(principal.ref) })}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button key="drop" danger type="primary" loading={busy} disabled={loading || impact?.blocking} onClick={() => void submit()}>{t('user_management.drop.confirm')}</Button>,
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message={t('user_management.drop.warning')} />
        {loading && <Spin />}
        {error && <Alert type="error" showIcon message={error} />}
        {impact?.items.map((item) => (
          <Alert key={`${item.code}-${item.database || ''}`} type="warning" showIcon message={item.text || item.code} description={item.samples && item.samples.length > 0 ? item.samples.join(', ') : undefined} />
        ))}
        {impact && impact.items.length === 0 && !loading && <Alert type="success" showIcon message={t('user_management.drop.no_impact')} />}
        {impact?.notices.map((notice) => <Alert key={notice.code} type="info" showIcon message={notice.text || notice.code} />)}
        {impact?.cascadeSupported && (
          <Checkbox checked={Boolean(options.cascade)} onChange={(event) => setOptions({ ...options, cascade: event.target.checked })}>{t('user_management.drop.cascade')}</Checkbox>
        )}
        {impact?.reassignSupported && (
          <>
            <Select
              allowClear
              placeholder={t('user_management.drop.reassign_to')}
              value={options.reassignTo}
              options={reassignCandidates.map((item) => ({ value: item.ref.name, label: principalDisplayName(item.ref) }))}
              onChange={(reassignTo) => setOptions({ ...options, reassignTo })}
              style={{ width: '100%' }}
            />
            <Checkbox checked={Boolean(options.dropOwned)} onChange={(event) => setOptions({ ...options, dropOwned: event.target.checked })}>{t('user_management.drop.drop_owned')}</Checkbox>
          </>
        )}
        {outcome && !outcome.success && <Alert type="error" showIcon message={outcome.message} />}
      </Space>
    </Modal>
  );
}
