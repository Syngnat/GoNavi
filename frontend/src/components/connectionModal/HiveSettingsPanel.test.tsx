/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Form, type FormInstance } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { HiveSettingsPanel } from './HiveSettingsPanel';
import { t } from '../../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }));

const renderPanel = async (dbType = 'hive', initial: Record<string, unknown> = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let form: FormInstance | undefined;
  const onChange = vi.fn();
  function Harness() {
    const [instance] = Form.useForm();
    form = instance;
    return <Form form={instance} initialValues={{ port: 10000, connectionParams: '', useSSL: false, ...initial }}>
      <HiveSettingsPanel dbType={dbType} onChange={onChange} />
    </Form>;
  }
  await act(async () => root.render(<Harness />));
  return { host, onChange, form: () => form!, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
};

const selectOption = async (host: HTMLDivElement, id: string, title: string) => {
  const selector = host.querySelector('#' + id)?.closest('.ant-select-selector');
  expect(selector).not.toBeNull();
  await act(async () => { selector!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  const option = Array.from(document.querySelectorAll('.ant-select-item-option')).find(element => element.getAttribute('title') === title);
  expect(option).toBeDefined();
  await act(async () => { option!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('Hive settings panel', () => {
  it('renders nothing for unrelated data sources', async () => {
    const view = await renderPanel('mysql');
    try { expect(view.host.querySelector('section')).toBeNull(); } finally { await view.cleanup(); }
  });

  it('updates family/transport defaults but preserves custom ports and session options', async () => {
    const view = await renderPanel('hive', { connectionParams: 'session.custom=a%26b' });
    try {
      await selectOption(view.host, 'hive-transportMode', 'HTTP / HTTPS');
      expect(view.form().getFieldValue('port')).toBe(10001);
      expect(view.host.querySelector('#hive-httpPath')).not.toBeNull();
      await selectOption(view.host, 'hive-hiveFamily', 'Impala');
      expect(view.form().getFieldValue('port')).toBe(28000);
      expect(new URLSearchParams(view.form().getFieldValue('connectionParams')).get('session.custom')).toBe('a&b');
      await act(async () => view.form().setFieldValue('port', 12345));
      await selectOption(view.host, 'hive-hiveFamily', 'Apache Hive');
      expect(view.form().getFieldValue('port')).toBe(12345);
      expect(view.onChange).toHaveBeenCalled();
    } finally { await view.cleanup(); }
  });

  it('shows the distinct service SPN, keytab/cache and QOP guidance for Kerberos', async () => {
    const view = await renderPanel('hive', { connectionParams: 'authMode=KERBEROS&transportMode=http' });
    try {
      expect(view.host.querySelector('#hive-principal')?.getAttribute('placeholder')).toBe('HTTP/_HOST@EXAMPLE.COM');
      for (const id of ['realm', 'keytab', 'credentialCache', 'krb5Config']) expect(view.host.querySelector('#hive-' + id)).not.toBeNull();
      expect(view.host.textContent).toContain(t('connection.modal.hive.kerberosHelp'));
      await act(async () => view.form().setFieldsValue({ connectionParams: 'authMode=LDAP', useSSL: false }));
      expect(view.host.querySelector('#hive-keytab')).toBeNull();
      expect(view.host.textContent).toContain(t('connection.modal.hive.plainWarning'));
      await act(async () => view.form().setFieldValue('useSSL', true));
      expect(view.host.textContent).not.toContain(t('connection.modal.hive.plainWarning'));
      expect(view.host.textContent).toContain(t('connection.modal.hive.capabilities'));
    } finally { await view.cleanup(); }
  });

  it('stores authentication under authMode rather than the secret auth key', async () => {
    const view = await renderPanel();
    try {
      await selectOption(view.host, 'hive-auth', 'LDAP');
      const params = new URLSearchParams(view.form().getFieldValue('connectionParams'));
      expect(params.get('authMode')).toBe('LDAP');
      expect(params.has('auth')).toBe(false);
    } finally { await view.cleanup(); }
  });
});
