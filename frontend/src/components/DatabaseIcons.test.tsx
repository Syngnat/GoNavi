import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DB_ICON_TYPES,
  getDbIcon,
  getDbIconAssetSrc,
  getDbIconLabel,
  hasDbIconAsset,
} from './DatabaseIcons';
const translate = (key: string) =>
  key === 'connection_modal.db_icon_label.custom' ? 'T:custom' : key;

const BRAND_ICON_CASES: Array<[string, string, string]> = [
  ['elasticsearch', 'Elasticsearch', 'elasticsearch.svg'],
  ['oceanbase', 'OceanBase', 'oceanbase.png'],
  ['oracle', 'Oracle', 'oracle.ico'],
  ['starrocks', 'StarRocks', 'starrocks.png'],
  ['trino', 'Trino', 'trino.svg'],
  ['kingbase', 'Kingbase', 'kingbase.ico'],
  ['dameng', 'Dameng', 'dameng.png'],
  ['vastbase', 'VastBase', 'vastbase.svg'],
  ['opengauss', 'OpenGauss', 'opengauss.ico'],
  ['gaussdb', 'GaussDB', 'gaussdb.ico'],
  ['goldendb', 'GoldenDB', 'goldendb.ico'],
  ['highgo', 'HighGo', 'highgo.ico'],
  ['iris', 'InterSystems IRIS', 'iris.png'],
  ['cache', 'InterSystems Caché', 'iris.png'],
  ['tdengine', 'TDengine', 'tdengine.ico'],
  ['iotdb', 'Apache IoTDB', 'iotdb.svg'],
  ['rocketmq', 'RocketMQ', 'rocketmq.png'],
  ['mqtt', 'MQTT', 'mqtt.svg'],
  ['kafka', 'Kafka', 'kafka.png'],
  ['rabbitmq', 'RabbitMQ', 'rabbitmq.svg'],
  ['nacos', 'Nacos', 'nacos.svg'],
  ['chroma', 'Chroma', 'chroma.svg'],
  ['qdrant', 'Qdrant', 'qdrant.svg'],
  ['milvus', 'Milvus', 'milvus.svg'],
  ['jvm', 'JVM', 'java.svg'],
];

describe('DatabaseIcons', () => {
  for (const [type, label, asset] of BRAND_ICON_CASES) {
    it(`includes ${label} in the selectable database icons`, () => {
      expect(DB_ICON_TYPES).toContain(type);
      expect(getDbIconLabel(type)).toBe(label);
      expect(hasDbIconAsset(type)).toBe(true);
      expect(getDbIconAssetSrc(type)).toContain(asset);
      const markup = renderToStaticMarkup(<>{getDbIcon(type, undefined, 22)}</>);
      expect(markup).toContain(`src="${getDbIconAssetSrc(type)}"`);
      expect(markup).toContain(`alt="${type}"`);
    });
  }

  it('renders brand logos for the agent data source types', () => {
    // 智能体类型（ChatGPT / Claude Code）也要有品牌图标：没有品牌资源时，
    // 选型卡片会回退成通用数据库圆柱，认不出是哪个智能体。
    const AGENT_ICON_CASES: Array<[string, string]> = [
      ['codex', 'codex.svg'],
      ['claude', 'claudecode.svg'],
    ];

    for (const [type, asset] of AGENT_ICON_CASES) {
      expect(hasDbIconAsset(type)).toBe(true);
      expect(getDbIconAssetSrc(type)).toContain(asset);
      const markup = renderToStaticMarkup(<>{getDbIcon(type, undefined, 22)}</>);
      expect(markup).toContain(`src="${getDbIconAssetSrc(type)}"`);
    }
  });

  it('wraps database icons in a consistent frame for sidebar sizing', () => {
    const mysqlMarkup = renderToStaticMarkup(<>{getDbIcon('mysql', undefined, 22)}</>);
    const jvmMarkup = renderToStaticMarkup(<>{getDbIcon('jvm', undefined, 22)}</>);

    expect(mysqlMarkup).toContain('data-db-icon-frame="true"');
    expect(jvmMarkup).toContain('data-db-icon-frame="true"');
    expect(mysqlMarkup).toContain('width:22px');
    expect(jvmMarkup).toContain('width:22px');
  });

  it('localizes the custom icon label without translating database brand names', () => {
    expect(getDbIconLabel('custom', translate)).toBe('T:custom');
    expect(getDbIconLabel('mysql', translate)).toBe('MySQL');
    expect(getDbIconLabel('kingbase', translate)).toBe('Kingbase');
    expect(getDbIconLabel('dameng', translate)).toBe('Dameng');
    expect(getDbIconLabel('highgo', translate)).toBe('HighGo');
  });
});
