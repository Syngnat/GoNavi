import { describe, expect, it } from 'vitest';
import { buildMessagePublishCommand, createDefaultMessagePublishDraft, getMessagePublishPresentation } from './messagePublish';
import { buildMessageConsumeCommand, resolveMessageConsumeProfile } from './messageConsume';
import { parseUriToValues, buildUriFromValues, getPulsarPortAfterSSLChange } from '../components/connectionModal/connectionModalUri';
import { buildConnectionConfig } from '../components/connectionModal/connectionModalConfig';
import { isMessageQueueDataSource } from './dataSourceCapabilities';
import { getConnectionTypeDefaultPort, getAllConnectionTypeCatalogItems } from './connectionTypeCatalog';
import { PRIMARY_USERNAME_OPTIONAL_TYPES, supportsSSLForType } from './connectionTypeCapabilities';
import { buildTableSelectQuery } from './objectQueryTemplates';

const config = { type: 'pulsar', database: 'persistent://public/default/orders' };

describe('Pulsar integration', () => {
  it('registers connection defaults, anonymous auth and intact dotted topic templates', () => {
    expect(getAllConnectionTypeCatalogItems().some(item => item.key === 'pulsar')).toBe(true);
    expect(getConnectionTypeDefaultPort('pulsar')).toBe(6650);
    expect(PRIMARY_USERNAME_OPTIONAL_TYPES.has('pulsar')).toBe(true);
    expect(supportsSSLForType('pulsar')).toBe(true);
    expect(buildTableSelectQuery('pulsar', 'persistent://public/default/orders.events')).toBe('SELECT * FROM "persistent://public/default/orders.events" LIMIT 100;');
    expect(parseUriToValues('pulsar+ssl://localhost/public/default/orders?sslCAPath=root.pem', 'pulsar')).toMatchObject({ port: 6651, useSSL: true, sslCAPath: 'root.pem' });
  });
  it('uses the message workbench and read-only preview without consumer group controls', () => {
    expect(isMessageQueueDataSource(config)).toBe(true);
    expect(resolveMessageConsumeProfile(config)).toMatchObject({ type: 'pulsar', showConsumerGroup: false });
    expect(buildMessageConsumeCommand(config, { destination: config.database, limit: 10 }).commandText)
      .toBe('CONSUME FROM "persistent://public/default/orders" EARLIEST LIMIT 10;');
  });
  it('publishes JSON, keys and properties through the existing command API', () => {
    const draft = { ...createDefaultMessagePublishDraft(config), body: '{"n":1}', key: 'order-1', properties: '{"source":"test"}' };
    expect(JSON.parse(buildMessagePublishCommand(config, draft).commandText)).toEqual({ publish: config.database, value: { n: 1 }, key: 'order-1', properties: { source: 'test' } });
    expect(getMessagePublishPresentation(config)).toMatchObject({ showProperties: true, showHeaders: false, showKeyMode: false });
  });
  it('round trips TLS, topic and escaped authentication in URI mode', () => {
    const uri = buildUriFromValues({ ...config, host: 'localhost', port: 6651, user: 'user', password: 'p+a/ss', useSSL: true, sslMode: 'required' });
    expect(parseUriToValues(uri, 'pulsar')).toMatchObject({ host: 'localhost', port: 6651, database: config.database, password: 'p+a/ss', useSSL: true });
  });
  it('uses the TLS broker port when no port was entered, while preserving explicit ports', () => {
    expect(new URL(buildUriFromValues({ type: 'pulsar', host: 'localhost', useSSL: true })).port).toBe('6651');
    expect(new URL(buildUriFromValues({ type: 'pulsar', host: 'localhost', port: 7665, useSSL: true })).port).toBe('7665');
    expect(parseUriToValues('pulsar://localhost?tls=true', 'pulsar')).toMatchObject({ port: 6651, useSSL: true });
    expect(parseUriToValues('pulsar://localhost:6650?tls=true', 'pulsar')).toMatchObject({ port: 6650, useSSL: true });
    expect(getPulsarPortAfterSSLChange(6650, true, false)).toBe(6651);
    expect(getPulsarPortAfterSSLChange(6651, false, false)).toBe(6650);
    expect(getPulsarPortAfterSSLChange(6650, true, true)).toBe(6650);
    expect(getPulsarPortAfterSSLChange(7665, true, false)).toBe(7665);
  });
  it('uses the TLS broker port in saved configs when no port was entered', async () => {
    const result = await buildConnectionConfig({
      values: { ...config, host: 'localhost', useSSL: true },
      forPersist: false,
      translate: (key: string) => key,
    });
    expect(result).toMatchObject({ port: 6651, useSSL: true });
  });
  it('does not submit hidden tunnels after switching to Pulsar', async () => {
    const result = await buildConnectionConfig({
      values: {
        ...config, host: 'localhost', port: 6650, useSSH: true, sshHost: 'ssh.local',
        useProxy: true, proxyHost: 'proxy.local', useHttpTunnel: true, httpTunnelHost: 'https://tunnel.local',
      },
      forPersist: false,
      translate: (key: string) => key,
    });
    expect(result).toMatchObject({ useSSH: false, useProxy: false, useHttpTunnel: false });
  });
});
