import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Select, Segmented, Spin, Switch, Typography, message } from 'antd';
import { CloudDownloadOutlined, CloudUploadOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  showCloudBackupRestoreDialog,
  type CloudBackupRestorePreview,
  type CloudBackupRestoreResult,
} from './CloudBackupRestoreDialog';
import CloudBackupCategorySelector, {
  CLOUD_BACKUP_CATEGORY_IDS,
} from './CloudBackupCategorySelector';
import CloudBackupRemotePreview from './CloudBackupRemotePreview';

type CloudBackupConfig = {
  enabled: boolean;
  provider: string;
  webdavEndpoint: string;
  webdavFilePath: string;
  s3Endpoint: string;
  s3Bucket?: string;
  s3Region?: string;
  s3ObjectKey: string;
  schedule: string;
  backupCategories: string[];
  hasWebdavCredential: boolean;
  hasS3Credential: boolean;
  hasEncryptionKey: boolean;
  webdavLastSyncAt?: string;
  webdavLastSyncSuccess: boolean;
  webdavLastSyncError?: string;
  webdavRemoteAvailable: boolean;
  webdavRemoteUpdatedAt?: string;
  s3LastSyncAt?: string;
  s3LastSyncSuccess: boolean;
  s3LastSyncError?: string;
  s3RemoteAvailable: boolean;
  s3RemoteUpdatedAt?: string;
};

type CloudBackupBindings = {
  CloudBackupGetConfig?: () => Promise<CloudBackupConfig>;
  SaveCloudBackupConfig?: (input: Record<string, unknown>) => Promise<CloudBackupConfig>;
  CloudBackupSyncNow?: () => Promise<{ lastSyncAt?: string }>;
  CloudBackupPreviewRestore?: () => Promise<CloudBackupRestorePreview>;
  CloudBackupRestore?: (request: { confirmationToken: string; categories: string[] }) => Promise<CloudBackupRestoreResult>;
};

type Props = {
  t: (key: string, params?: any) => string;
};

const getBindings = (): CloudBackupBindings | null => {
  if (typeof window === 'undefined') return null;
  return ((window as any).go?.app?.App || null) as CloudBackupBindings | null;
};

const fallback = (t: Props['t'], key: string, value: string, params?: any): string => {
  const translated = t(key, params);
  return translated === key ? value : translated;
};

const formatSyncTimestamp = (value?: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const showSuccessFeedback = (key: string, title: string, description: string): void => {
  void message.success({
    key,
    duration: 4,
    content: (
      <span className="gonavi-cloud-backup-feedback">
        <span className="gonavi-cloud-backup-feedback__title">{title}</span>
        <span className="gonavi-cloud-backup-feedback__description">{description}</span>
      </span>
    ),
  });
};

const DEFAULT_CONFIG: CloudBackupConfig = {
  enabled: false,
  provider: 'webdav',
  webdavEndpoint: '',
  webdavFilePath: 'gonavi/backup.gonavi',
  s3Endpoint: '',
  s3Bucket: '',
  s3Region: 'us-east-1',
  s3ObjectKey: 'gonavi/backup.gonavi',
  schedule: 'manual',
  backupCategories: [...CLOUD_BACKUP_CATEGORY_IDS],
  hasWebdavCredential: false,
  hasS3Credential: false,
  hasEncryptionKey: false,
  webdavLastSyncSuccess: false,
  webdavRemoteAvailable: false,
  s3LastSyncSuccess: false,
  s3RemoteAvailable: false,
};

export default function CloudBackupSettings({ t }: Props) {
  const [config, setConfig] = useState<CloudBackupConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<CloudBackupConfig>(DEFAULT_CONFIG);
  const [webdavUsername, setWebdavUsername] = useState('');
  const [webdavPassword, setWebdavPassword] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<CloudBackupRestorePreview | null>(null);

  const labels = useMemo(() => ({
    title: fallback(t, 'app.cloud_backup.title', 'Cloud backup'),
    description: fallback(t, 'app.cloud_backup.description', 'Encrypt GoNavi connections and application settings before syncing them to WebDAV or S3.'),
    unavailable: fallback(t, 'app.cloud_backup.unavailable', 'Cloud backup is unavailable in this runtime. Restart with the Wails desktop runtime.'),
    enabled: fallback(t, 'app.cloud_backup.enabled', 'Enable cloud backup'),
    provider: fallback(t, 'app.cloud_backup.provider', 'Provider'),
    webdav: fallback(t, 'app.cloud_backup.provider.webdav', 'WebDAV'),
    s3: fallback(t, 'app.cloud_backup.provider.s3', 'S3'),
    webdavEndpoint: fallback(t, 'app.cloud_backup.webdav.endpoint', 'WebDAV server URL'),
    webdavFilePath: fallback(t, 'app.cloud_backup.webdav.file_path', 'Backup file path'),
    s3Endpoint: fallback(t, 'app.cloud_backup.s3.endpoint', 'S3 endpoint'),
    s3ObjectKey: fallback(t, 'app.cloud_backup.s3.object_key', 'Object key'),
    webdavHint: fallback(t, 'app.cloud_backup.provider.webdav_hint', 'WebDAV stores the encrypted backup as a file under the server URL.'),
    s3Hint: fallback(t, 'app.cloud_backup.provider.s3_hint', 'S3 stores the encrypted backup in a bucket under the object key.'),
    s3Bucket: fallback(t, 'app.cloud_backup.s3.bucket', 'Bucket'),
    s3Region: fallback(t, 'app.cloud_backup.s3.region', 'Region'),
    webdavUsername: fallback(t, 'app.cloud_backup.webdav.username', 'Username'),
    webdavPassword: fallback(t, 'app.cloud_backup.webdav.password', 'Password'),
    s3AccessKey: fallback(t, 'app.cloud_backup.s3.access_key', 'Access key'),
    s3SecretKey: fallback(t, 'app.cloud_backup.s3.secret_key', 'Secret key'),
    encryptionPassword: fallback(t, 'app.cloud_backup.encryption_password', 'Encryption password'),
    secretHint: fallback(t, 'app.cloud_backup.secret_hint', 'Leave secret fields empty to keep the value in the OS keyring.'),
    schedule: fallback(t, 'app.cloud_backup.schedule', 'Automatic sync'),
    backupScope: fallback(t, 'app.cloud_backup.backup_scope', 'Backup content'),
    selectionRequired: fallback(t, 'app.cloud_backup.selection.required', 'Select at least one category to back up.'),
    manual: fallback(t, 'app.cloud_backup.schedule.manual', 'Manual only'),
    immediate: fallback(t, 'app.cloud_backup.schedule.immediate', 'After changes'),
    tenMinutes: fallback(t, 'app.cloud_backup.schedule.10m', 'Every 10 minutes'),
    thirtyMinutes: fallback(t, 'app.cloud_backup.schedule.30m', 'Every 30 minutes'),
    hour: fallback(t, 'app.cloud_backup.schedule.1h', 'Every hour'),
    onExit: fallback(t, 'app.cloud_backup.schedule.on_exit', 'Before exit'),
    save: fallback(t, 'common.save', 'Save'),
    sync: fallback(t, 'app.cloud_backup.action.sync', 'Sync now'),
    check: fallback(t, 'app.cloud_backup.action.check', 'Check remote'),
    restore: fallback(t, 'app.cloud_backup.action.restore', 'Restore'),
    saveSuccess: fallback(t, 'app.cloud_backup.feedback.saved.title', 'Cloud backup settings saved'),
    syncSuccess: fallback(t, 'app.cloud_backup.feedback.synced.title', 'Cloud backup synced'),
    restoreRestart: fallback(t, 'app.cloud_backup.restore.restart_required', 'Restore completed. Restart GoNavi to apply the restored settings and credentials.'),
    status: fallback(t, 'app.cloud_backup.status', 'Status'),
    notSynced: fallback(t, 'app.cloud_backup.status.not_synced', 'Not synced yet'),
    remoteFound: fallback(t, 'app.cloud_backup.status.remote_found', 'A remote backup is available'),
    noRemote: fallback(t, 'app.cloud_backup.status.no_remote', 'No remote backup found'),
  }), [t]);

  const loadConfig = useCallback(async () => {
    const bindings = getBindings();
    if (!bindings?.CloudBackupGetConfig) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const loadedConfig = await bindings.CloudBackupGetConfig();
      const nextConfig = {
        ...DEFAULT_CONFIG,
        ...loadedConfig,
        backupCategories: Array.isArray(loadedConfig.backupCategories)
          ? loadedConfig.backupCategories
          : [...CLOUD_BACKUP_CATEGORY_IDS],
      };
      setConfig(nextConfig);
      setSavedConfig(nextConfig);
    } catch (loadError: any) {
      setError(loadError?.message || String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const save = async () => {
    const bindings = getBindings();
    if (!bindings?.SaveCloudBackupConfig) return;
    if (config.backupCategories.length === 0) {
      setError((current) => current === labels.selectionRequired ? '' : current);
      message.warning(labels.selectionRequired);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await bindings.SaveCloudBackupConfig({
        enabled: config.enabled,
        provider: config.provider,
        webdavEndpoint: config.webdavEndpoint,
        webdavFilePath: config.webdavFilePath,
        s3Endpoint: config.s3Endpoint,
        s3Bucket: config.s3Bucket,
        s3Region: config.s3Region,
        s3ObjectKey: config.s3ObjectKey,
        schedule: config.schedule,
        backupCategories: config.backupCategories,
        webdavUsername,
        webdavPassword,
        s3AccessKey,
        s3SecretKey,
        encryptionPassword,
      });
      const nextConfig = { ...DEFAULT_CONFIG, ...saved };
      setConfig(nextConfig);
      setSavedConfig(nextConfig);
      setWebdavUsername('');
      setWebdavPassword('');
      setS3AccessKey('');
      setS3SecretKey('');
      setEncryptionPassword('');
      const providerLabel = saved.provider === 's3' ? labels.s3 : labels.webdav;
      const scheduleLabel = {
        manual: labels.manual,
        immediate: labels.immediate,
        '10m': labels.tenMinutes,
        '30m': labels.thirtyMinutes,
        '1h': labels.hour,
        on_exit: labels.onExit,
      }[saved.schedule] || saved.schedule;
      showSuccessFeedback(
        'cloud-backup-config-saved',
        labels.saveSuccess,
        fallback(
          t,
          'app.cloud_backup.feedback.saved.description',
          `Saved the ${providerLabel} configuration, ${saved.backupCategories.length} backup categories, and the “${scheduleLabel}” sync schedule.`,
          { provider: providerLabel, count: saved.backupCategories.length, schedule: scheduleLabel },
        ),
      );
    } catch (saveError: any) {
      setError(saveError?.message || String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const sync = async () => {
    const bindings = getBindings();
    if (!bindings?.CloudBackupSyncNow || remoteOperationsDisabled) return;
    setSyncing(true);
    setError('');
    try {
      const syncStatus = await bindings.CloudBackupSyncNow();
      await loadConfig();
      const providerLabel = config.provider === 's3' ? labels.s3 : labels.webdav;
      const syncedAt = formatSyncTimestamp(syncStatus?.lastSyncAt) || formatSyncTimestamp(new Date().toISOString());
      showSuccessFeedback(
        'cloud-backup-sync-complete',
        labels.syncSuccess,
        fallback(
          t,
          'app.cloud_backup.feedback.synced.description',
          `Encrypted and synced ${config.backupCategories.length} categories to ${providerLabel} at ${syncedAt}.`,
          { provider: providerLabel, count: config.backupCategories.length, time: syncedAt },
        ),
      );
    } catch (syncError: any) {
      setError(syncError?.message || String(syncError));
    } finally {
      setSyncing(false);
    }
  };

  const previewRestore = async () => {
    const bindings = getBindings();
    if (!bindings?.CloudBackupPreviewRestore || remoteOperationsDisabled) return;
    setSyncing(true);
    setError('');
    try {
      const nextPreview = await bindings.CloudBackupPreviewRestore();
      setPreview(nextPreview);
    } catch (previewError: any) {
      setError(previewError?.message || String(previewError));
    } finally {
      setSyncing(false);
    }
  };

  const restore = async () => {
    const bindings = getBindings();
    if (!bindings?.CloudBackupRestore || remoteOperationsDisabled) return;
    setSyncing(true);
    try {
      const outcome = await showCloudBackupRestoreDialog({ bindings, preview, t });
      if (outcome.cancelled) return;
      const result = outcome.result;
      setPreview(null);
      if (result?.restartRequired) {
        message.warning(labels.restoreRestart);
      } else {
        message.success(labels.restore);
      }
      await loadConfig();
    } catch (restoreError: any) {
      setError(restoreError?.message || String(restoreError));
    } finally {
      setSyncing(false);
    }
  };

  const unavailable = !getBindings()?.CloudBackupGetConfig;
  const hasUnsavedConfiguration = [
    'enabled', 'provider', 'webdavEndpoint', 'webdavFilePath', 's3Endpoint', 's3Bucket', 's3Region', 's3ObjectKey', 'schedule',
  ].some((key) => config[key as keyof CloudBackupConfig] !== savedConfig[key as keyof CloudBackupConfig])
    || config.backupCategories.length !== savedConfig.backupCategories.length
    || config.backupCategories.some((category, index) => category !== savedConfig.backupCategories[index]);
  const hasUnsavedSecrets = Boolean(webdavUsername || webdavPassword || s3AccessKey || s3SecretKey || encryptionPassword);
  const hasUnsavedChanges = hasUnsavedConfiguration || hasUnsavedSecrets;
  const remoteOperationsDisabled = unavailable || !config.enabled || hasUnsavedChanges;

  useEffect(() => {
    setPreview(null);
  }, [config.provider, config.webdavEndpoint, config.webdavFilePath, config.s3Endpoint, config.s3Bucket, config.s3Region, config.s3ObjectKey, webdavUsername, webdavPassword, s3AccessKey, s3SecretKey, encryptionPassword]);

  if (loading) return <div style={{ minHeight: 180, display: 'grid', placeItems: 'center' }}><Spin /></div>;

  const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6, minWidth: 0 };
  const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0 };
  const twoColumnStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, minWidth: 0 };
  const activeStatus = config.provider === 's3'
    ? { lastSyncAt: config.s3LastSyncAt, lastSyncSuccess: config.s3LastSyncSuccess, lastSyncError: config.s3LastSyncError, remoteAvailable: config.s3RemoteAvailable }
    : { lastSyncAt: config.webdavLastSyncAt, lastSyncSuccess: config.webdavLastSyncSuccess, lastSyncError: config.webdavLastSyncError, remoteAvailable: config.webdavRemoteAvailable };
  const activeRemoteCredential = config.provider === 's3' ? config.hasS3Credential : config.hasWebdavCredential;

  return (
    <div className="gonavi-cloud-backup-settings" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 4px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      <div>
        <Typography.Title level={4} style={{ marginTop: 0 }}>{labels.title}</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{labels.description}</Typography.Paragraph>
      </div>
      {unavailable ? <Alert type="info" showIcon message={labels.unavailable} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      <div style={{ display: 'grid', gap: 12, minWidth: 0, opacity: unavailable ? 0.55 : 1 }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span>{labels.enabled}</span>
          <Switch checked={config.enabled} onChange={(enabled) => setConfig((current) => ({ ...current, enabled }))} disabled={unavailable} />
        </label>
        <CloudBackupCategorySelector
          categories={CLOUD_BACKUP_CATEGORY_IDS.map((id) => ({ id }))}
          selected={config.backupCategories}
          title={labels.backupScope}
          t={t}
          disabled={unavailable}
          onChange={(backupCategories) => {
            setConfig((current) => ({ ...current, backupCategories }));
            if (backupCategories.length > 0) {
              setError((current) => current === labels.selectionRequired ? '' : current);
            }
          }}
        />
        <label style={fieldStyle}>{labels.provider}<Segmented block value={config.provider} onChange={(provider) => setConfig((current) => ({ ...current, provider: String(provider) }))} options={[{ label: labels.webdav, value: 'webdav' }, { label: labels.s3, value: 's3' }]} disabled={unavailable} /><Typography.Text type="secondary">{config.provider === 's3' ? labels.s3Hint : labels.webdavHint}</Typography.Text></label>
        {config.provider === 's3' ? (
          <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
            <Typography.Text strong>{labels.s3}</Typography.Text>
            <label style={fieldStyle}>{labels.s3Endpoint}<Input style={inputStyle} value={config.s3Endpoint} onChange={(event) => setConfig((current) => ({ ...current, s3Endpoint: event.target.value }))} disabled={unavailable} /></label>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
            <Typography.Text strong>{labels.webdav}</Typography.Text>
            <label style={fieldStyle}>{labels.webdavEndpoint}<Input style={inputStyle} value={config.webdavEndpoint} onChange={(event) => setConfig((current) => ({ ...current, webdavEndpoint: event.target.value }))} disabled={unavailable} /></label>
          </div>
        )}
        {config.provider === 's3' ? <div style={twoColumnStyle}><label style={fieldStyle}>{labels.s3Bucket}<Input style={inputStyle} value={config.s3Bucket} onChange={(event) => setConfig((current) => ({ ...current, s3Bucket: event.target.value }))} disabled={unavailable} /></label><label style={fieldStyle}>{labels.s3Region}<Input style={inputStyle} value={config.s3Region} onChange={(event) => setConfig((current) => ({ ...current, s3Region: event.target.value }))} disabled={unavailable} /></label></div> : null}
        {config.provider === 's3' ? <label style={fieldStyle}>{labels.s3ObjectKey}<Input style={inputStyle} value={config.s3ObjectKey} onChange={(event) => setConfig((current) => ({ ...current, s3ObjectKey: event.target.value }))} disabled={unavailable} /></label> : <label style={fieldStyle}>{labels.webdavFilePath}<Input style={inputStyle} value={config.webdavFilePath} onChange={(event) => setConfig((current) => ({ ...current, webdavFilePath: event.target.value }))} disabled={unavailable} /></label>}
        {config.provider === 's3' ? <div style={twoColumnStyle}><label style={fieldStyle}>{labels.s3AccessKey}<Input.Password style={inputStyle} value={s3AccessKey} placeholder={activeRemoteCredential ? '••••••••' : undefined} onChange={(event) => setS3AccessKey(event.target.value)} disabled={unavailable} /></label><label style={fieldStyle}>{labels.s3SecretKey}<Input.Password style={inputStyle} value={s3SecretKey} placeholder={activeRemoteCredential ? '••••••••' : undefined} onChange={(event) => setS3SecretKey(event.target.value)} disabled={unavailable} /></label></div> : <div style={twoColumnStyle}><label style={fieldStyle}>{labels.webdavUsername}<Input style={inputStyle} value={webdavUsername} placeholder={activeRemoteCredential ? '••••••••' : undefined} onChange={(event) => setWebdavUsername(event.target.value)} disabled={unavailable} /></label><label style={fieldStyle}>{labels.webdavPassword}<Input.Password style={inputStyle} value={webdavPassword} placeholder={activeRemoteCredential ? '••••••••' : undefined} onChange={(event) => setWebdavPassword(event.target.value)} disabled={unavailable} /></label></div>}
        <label style={fieldStyle}>{labels.encryptionPassword}<Input.Password style={inputStyle} value={encryptionPassword} placeholder={config.hasEncryptionKey ? '••••••••' : undefined} onChange={(event) => setEncryptionPassword(event.target.value)} disabled={unavailable} /></label>
        <Typography.Text type="secondary">{labels.secretHint}</Typography.Text>
        <label style={fieldStyle}>{labels.schedule}<Select value={config.schedule} onChange={(schedule) => setConfig((current) => ({ ...current, schedule }))} style={inputStyle} disabled={unavailable} options={[{ value: 'manual', label: labels.manual }, { value: 'immediate', label: labels.immediate }, { value: '10m', label: labels.tenMinutes }, { value: '30m', label: labels.thirtyMinutes }, { value: '1h', label: labels.hour }, { value: 'on_exit', label: labels.onExit }]} /></label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={unavailable} onClick={() => void save()}>{labels.save}</Button>
        <Button icon={<CloudUploadOutlined />} loading={syncing} disabled={remoteOperationsDisabled} onClick={() => void sync()}>{labels.sync}</Button>
        <Button icon={<ReloadOutlined />} loading={syncing} disabled={remoteOperationsDisabled} onClick={() => void previewRestore()}>{labels.check}</Button>
        {preview ? <Button danger icon={<CloudDownloadOutlined />} loading={syncing} disabled={remoteOperationsDisabled} onClick={() => void restore()}>{labels.restore}</Button> : null}
      </div>
      <div>
        <Typography.Text strong>{labels.status}</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
          {activeStatus.lastSyncAt ? `${formatSyncTimestamp(activeStatus.lastSyncAt)}${activeStatus.lastSyncSuccess ? '' : ` (${activeStatus.lastSyncError || 'failed'})`}` : labels.notSynced}
          {activeStatus.remoteAvailable ? ` · ${labels.remoteFound}` : ` · ${labels.noRemote}`}
        </Typography.Paragraph>
      </div>
      {preview ? (
        <CloudBackupRemotePreview
          preview={preview}
          providerLabel={config.provider === 's3' ? labels.s3 : labels.webdav}
          t={t}
        />
      ) : null}
    </div>
  );
}
