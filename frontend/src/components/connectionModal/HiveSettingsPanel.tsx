import type { ReactNode } from 'react';
import { Alert, Form, Input, InputNumber, Select } from 'antd';
import { t } from '../../i18n';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import {
  HIVE_AUTH_MODES, getHiveDefaultPort, hiveAuth, hiveFamily, hiveTransport,
  isHiveConnectionType, readHiveParams, updateHiveParam,
} from '../../utils/hiveConnection';

const HiveSettingRow = ({ name, label, children }: { name: string; label: string; children: ReactNode }) => (
  <div className="gn-conn-f-row" data-align="start">
    <label className="gn-conn-f-label" htmlFor={'hive-' + name}>{label}</label>
    <div className="gn-conn-f-ctrl">{children}</div>
  </div>
);

const KERBEROS_FIELDS = [
  { key: 'principal', label: 'connection.modal.hive.principal', placeholder: 'hive/_HOST@EXAMPLE.COM' },
  { key: 'realm', label: 'connection.modal.hive.realm', placeholder: 'EXAMPLE.COM' },
  { key: 'keytab', label: 'connection.modal.hive.keytab', placeholder: '' },
  { key: 'credentialCache', label: 'connection.modal.hive.credentialCache', placeholder: '' },
  { key: 'krb5Config', label: 'connection.modal.hive.krb5Config', placeholder: '' },
];

type HiveSettingsPanelProps = { dbType: string; onChange?: () => void };

// Reuse the existing form and secret fields; Hive options stay in ConnectionParams.
export const HiveSettingsPanel = ({ dbType, onChange }: HiveSettingsPanelProps) => {
  const form = Form.useFormInstance();
  const raw = Form.useWatch('connectionParams', { form, preserve: true });
  const useSSL = Form.useWatch('useSSL', { form, preserve: true });
  if (!isHiveConnectionType(dbType)) return null;
  const params = readHiveParams(raw);
  const family = hiveFamily(params);
  const transport = hiveTransport(params);
  const auth = hiveAuth(params);
  const setParam = (key: string, value: unknown) => {
    const current = form.getFieldValue('connectionParams');
    const previousParams = readHiveParams(current);
    const next = updateHiveParam(current, key, value);
    const nextParams = readHiveParams(next);
    if (key === 'hiveFamily' || key === 'transportMode') {
      const port = Number(form.getFieldValue('port'));
      if (!port || port === getHiveDefaultPort(hiveFamily(previousParams), hiveTransport(previousParams))) {
        form.setFieldValue('port', getHiveDefaultPort(hiveFamily(nextParams), hiveTransport(nextParams)));
      }
    }
    form.setFieldValue('connectionParams', next);
    onChange?.();
  };
  return (
    <section aria-label={t('connection.modal.hive.title')}>
      <HiveSettingRow name="hiveFamily" label={t('connection.modal.hive.family')}>
        <Select id="hive-hiveFamily" value={family} style={{ width: '100%' }} onChange={value => setParam('hiveFamily', value)} options={[
          { value: 'hive', label: 'Apache Hive' }, { value: 'spark', label: 'Spark SQL Thrift' }, { value: 'impala', label: 'Impala' },
        ]} />
        <div className="gn-conn-mode-hint">{t('connection.modal.hive.familyHelp')}</div>
      </HiveSettingRow>
      <HiveSettingRow name="transportMode" label={t('connection.modal.hive.transport')}>
        <Select id="hive-transportMode" value={transport} style={{ width: '100%' }} onChange={value => setParam('transportMode', value)} options={[
          { value: 'binary', label: t('connection.modal.hive.binary') }, { value: 'http', label: 'HTTP / HTTPS' },
        ]} />
      </HiveSettingRow>
      {transport === 'http' && <HiveSettingRow name="httpPath" label={t('connection.modal.hive.httpPath')}>
        <Input id="hive-httpPath" {...noAutoCapInputProps} value={params.get('httpPath') ?? 'cliservice'} onChange={event => setParam('httpPath', event.target.value)} />
        <div className="gn-conn-mode-hint">{t('connection.modal.hive.httpHelp')}</div>
      </HiveSettingRow>}
      <HiveSettingRow name="auth" label={t('connection.modal.hive.auth')}>
        <Select id="hive-auth" value={auth} style={{ width: '100%' }} onChange={value => setParam('authMode', value)} options={HIVE_AUTH_MODES.map(value => ({
          value, label: value === 'NONE' ? t('connection.modal.hive.authNone') : value === 'NOSASL' ? t('connection.modal.hive.authNoSasl') : value,
        }))} />
      </HiveSettingRow>
      {auth === 'KERBEROS' && <>
        {KERBEROS_FIELDS.map(field => <HiveSettingRow key={field.key} name={field.key} label={t(field.label)}>
          <Input id={'hive-' + field.key} {...noAutoCapInputProps} value={params.get(field.key) ?? ''}
            placeholder={field.key === 'principal' && transport === 'http' ? 'HTTP/_HOST@EXAMPLE.COM' : field.placeholder}
            onChange={event => setParam(field.key, event.target.value)} />
        </HiveSettingRow>)}
        <Alert type="info" showIcon message={t('connection.modal.hive.kerberosHelp')} />
      </>}
      {auth !== 'KERBEROS' && auth !== 'NOSASL' && !useSSL && <Alert type="warning" showIcon message={t('connection.modal.hive.plainWarning')} />}
      <HiveSettingRow name="fetchSize" label={t('connection.modal.hive.fetchSize')}>
        <InputNumber id="hive-fetchSize" min={1} max={10000} value={Number(params.get('fetchSize') || 1000)} onChange={value => setParam('fetchSize', value)} />
      </HiveSettingRow>
      <Alert type="info" showIcon message={t('connection.modal.hive.capabilities')} description={<>{t('connection.modal.hive.paginationHelp')}<br />{t('hive.capability.copySql')}</>} />
    </section>
  );
};
