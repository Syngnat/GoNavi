import { describe, expect, it } from 'vitest';
import { buildSidebarDatabasePinKey, buildSidebarTablePinKey } from '../../utils/sidebarTreeOrder';
import { buildNacosGroupPinScope, buildNacosConfigPinScope, isNacosGroupPinned, isNacosConfigPinned, pinNacosConfigGroupNodes, sortPinnedNacosConfigs } from './nacosPinning';

describe('Nacos pinned groups and configs', () => {
  it('isolates identical groups and Data IDs by connection, namespace and group', () => {
    const config = { dataId: 'app.yaml', group: 'DEFAULT_GROUP' };
    const groups = [buildSidebarDatabasePinKey('c1', buildNacosGroupPinScope('dev', 'DEFAULT_GROUP'))];
    const configs = [buildSidebarTablePinKey('c1', buildNacosConfigPinScope('dev'), config.dataId, config.group)];
    expect(isNacosGroupPinned(groups, 'c1', 'dev', 'DEFAULT_GROUP')).toBe(true);
    expect(isNacosGroupPinned(groups, 'c1', 'prod', 'DEFAULT_GROUP')).toBe(false);
    expect(isNacosGroupPinned(groups, 'c2', 'dev', 'DEFAULT_GROUP')).toBe(false);
    expect(isNacosConfigPinned(configs, 'c1', 'dev', config)).toBe(true);
    expect(isNacosConfigPinned(configs, 'c1', 'dev', { ...config, group: 'OTHER' })).toBe(false);
    expect(isNacosConfigPinned(configs, 'c1', 'prod', config)).toBe(false);
    expect(isNacosConfigPinned(configs, 'c2', 'dev', config)).toBe(false);
  });

  it('pins groups ahead of All and restores original order on unpin without losing children', () => {
    const nodes = [{ dataRef: { nacosAllConfigs: true, nacosGroup: '' } },
      { dataRef: { nacosGroup: 'A' }, children: ['a'] }, { dataRef: { nacosGroup: 'B' } }];
    const keys = [buildSidebarDatabasePinKey('c1', buildNacosGroupPinScope('dev', 'B'))];
    const pinned = pinNacosConfigGroupNodes(nodes, keys, 'c1', 'dev');
    expect(pinned.map(n => n.dataRef.nacosGroup)).toEqual(['B', '', 'A']);
    const restored = pinNacosConfigGroupNodes(pinned, [], 'c1', 'dev');
    expect(restored.map(n => n.dataRef.nacosGroup)).toEqual(['', 'A', 'B']);
    expect(restored[1]).toHaveProperty('children', ['a']);
    expect(nodes[0]).not.toHaveProperty('dataRef.pinnedSidebarDatabase');
  });

  it('sorts the loaded config page stably and does not mutate source records', () => {
    const configs = [{ dataId: 'a.yaml', group: 'G' }, { dataId: 'b.yaml', group: 'G' }, { dataId: 'a.yaml', group: 'H' }];
    const keys = [buildSidebarTablePinKey('c1', buildNacosConfigPinScope(''), 'b.yaml', 'G')];
    expect(sortPinnedNacosConfigs(configs, keys, 'c1', '').map(c => c.dataId)).toEqual(['b.yaml', 'a.yaml', 'a.yaml']);
    expect(sortPinnedNacosConfigs(configs, [], 'c1', '')).toEqual(configs);
    expect(configs[0].dataId).toBe('a.yaml');
  });
});
