import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Drawer, Form, InputNumber, Select, Space, Spin, Switch, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import {
  DEFAULT_SQL_AUDIT_SETTINGS,
  normalizeSQLAuditSettings,
  type SQLAuditSettings,
} from './sqlAuditModel';
import {
  requireSQLAuditMethod,
  resolveSQLAuditBackend,
  unwrapSQLAuditResult,
  type SQLAuditBackend,
} from './sqlAuditRpc';

interface SqlAuditSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: SQLAuditSettings) => void;
  backend?: SQLAuditBackend;
}

export default function SqlAuditSettingsDrawer({
  open,
  onClose,
  onSaved,
  backend: backendOverride,
}: SqlAuditSettingsDrawerProps) {
  const { t } = useI18n();
  const [form] = Form.useForm<SQLAuditSettings>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  const backend = backendOverride ?? resolveSQLAuditBackend();

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setSettingsReady(false);
    setError('');
    try {
      const getSettings = requireSQLAuditMethod(backend, 'GetSQLAuditSettings');
      const data = unwrapSQLAuditResult(await getSettings());
      form.setFieldsValue(normalizeSQLAuditSettings(data));
      setSettingsReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      form.resetFields();
    } finally {
      setLoading(false);
    }
  }, [backend, form]);

  useEffect(() => {
    if (open) void loadSettings();
  }, [loadSettings, open]);

  const handleSave = async () => {
    if (!settingsReady || loading) return;
    const values = normalizeSQLAuditSettings(await form.validateFields());
    setSaving(true);
    setError('');
    try {
      const updateSettings = requireSQLAuditMethod(backend, 'UpdateSQLAuditSettings');
      unwrapSQLAuditResult(await updateSettings(values));
      message.success(t('sql_audit.settings.message.saved'));
      onSaved?.(values);
      onClose();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(detail);
      message.error(t('sql_audit.settings.message.save_failed', { detail }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={440}
      title={t('sql_audit.settings.title')}
      destroyOnHidden
      extra={(
        <Space className="gn-sql-audit-settings-actions">
          <Button size="middle" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="middle"
            type="primary"
            icon={<SaveOutlined aria-hidden="true" />}
            loading={saving}
            disabled={!settingsReady || loading}
            onClick={() => void handleSave()}
          >
            {t('common.save')}
          </Button>
        </Space>
      )}
      styles={{ body: { overscrollBehavior: 'contain' } }}
    >
      <Spin spinning={loading}>
        <div aria-live="polite">
          {error ? (
            <Alert
              type="error"
              showIcon
              message={t('sql_audit.settings.error.load_or_save')}
              description={error}
              action={<Button size="small" onClick={() => void loadSettings()}>{t('common.retry')}</Button>}
              style={{ marginBottom: 16 }}
            />
          ) : null}
        </div>
        <Form
          form={form}
          layout="vertical"
          initialValues={DEFAULT_SQL_AUDIT_SETTINGS}
          requiredMark={false}
          disabled={!settingsReady || loading}
        >
          <Form.Item
            name="enabled"
            label={t('sql_audit.settings.enabled.label')}
            valuePropName="checked"
            extra={t('sql_audit.settings.enabled.description')}
          >
            <Switch aria-label={t('sql_audit.settings.enabled.label')} />
          </Form.Item>
          <Form.Item
            name="captureMode"
            label={t('sql_audit.settings.capture_mode.label')}
            extra={t('sql_audit.settings.capture_mode.description')}
          >
            <Select
              aria-label={t('sql_audit.settings.capture_mode.label')}
              options={[
                { value: 'redacted', label: t('sql_audit.settings.capture_mode.redacted') },
                { value: 'metadata', label: t('sql_audit.settings.capture_mode.metadata') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="retentionDays"
            label={t('sql_audit.settings.retention_days.label')}
            extra={t('sql_audit.settings.retention_days.description')}
            rules={[{ required: true, type: 'number', min: 1, max: 3650 }]}
          >
            <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} aria-label={t('sql_audit.settings.retention_days.label')} />
          </Form.Item>
          <Form.Item
            name="maxRecords"
            label={t('sql_audit.settings.max_records.label')}
            extra={t('sql_audit.settings.max_records.description')}
            rules={[{ required: true, type: 'number', min: 100, max: 10_000_000 }]}
          >
            <InputNumber min={100} max={10_000_000} step={1_000} precision={0} style={{ width: '100%' }} aria-label={t('sql_audit.settings.max_records.label')} />
          </Form.Item>
        </Form>
      </Spin>
    </Drawer>
  );
}
