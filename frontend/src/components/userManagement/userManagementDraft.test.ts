import { describe, expect, it } from 'vitest';
import {
  buildChangeRequest,
  buildDraftFromDetail,
  buildNewDraft,
  countChanges,
  type PrincipalDraft,
} from './userManagementDraft';
import { normalizeDetail, normalizeOverview, principalDisplayName } from './userManagementModel';

const profile = normalizeOverview({
  profile: {
    supported: true,
    family: 'mysql',
    kinds: [
      { kind: 'user', creatable: true, identityFields: ['name', 'host'], renamable: true, supportsPassword: true },
      { kind: 'role', creatable: true, identityFields: ['name', 'host'] },
    ],
    options: [
      { id: 'authPlugin', type: 'enum', tab: 'general', kinds: ['user'], default: 'caching_sha2_password', choices: [{ value: 'caching_sha2_password' }] },
      { id: 'accountLocked', type: 'bool', tab: 'general', kinds: ['user'] },
      { id: 'maxUserConnections', type: 'int', tab: 'advanced', kinds: ['user'] },
    ],
  },
}).profile;

const detail = normalizeDetail({
  principal: { ref: { kind: 'user', name: 'app', host: '%' } },
  options: { authPlugin: 'caching_sha2_password', accountLocked: 'false', maxUserConnections: '0' },
  grants: [
    { privilege: 'SELECT', scope: 'database', database: 'sales' },
    { privilege: 'UPDATE', scope: 'table', database: 'sales', object: 't', withGrantOption: true },
    { privilege: 'INSERT', scope: 'table', database: 'sales', object: 't', inherited: 'reader' },
  ],
  memberOf: [{ role: { kind: 'role', name: 'reader', host: '%' } }],
});

const edit = (mutate: (draft: PrincipalDraft) => void) => {
  const original = buildDraftFromDetail(detail);
  const draft = buildDraftFromDetail(detail);
  mutate(draft);
  return buildChangeRequest(original, draft, { includeSecrets: true });
};

describe('user management draft diff', () => {
  it('builds a create request with descriptor defaults and a host default', () => {
    const draft = buildNewDraft(profile, 'user');
    expect(draft.host).toBe('%');
    expect(draft.options).toEqual({ authPlugin: 'caching_sha2_password', accountLocked: 'false' });
    draft.name = 'svc';
    draft.password = { ...draft.password, set: true, value: 'x', confirm: 'x' };
    const request = buildChangeRequest(null, draft, { includeSecrets: false });
    expect(request?.action).toBe('create');
    expect(request?.password).toEqual({ set: true, remove: undefined, retainCurrent: undefined, password: undefined, currentPassword: undefined });
  });

  it('returns null when nothing changed and ignores inherited grants', () => {
    expect(edit(() => {})).toBeNull();
    expect(buildDraftFromDetail(detail).grants).toHaveLength(2);
  });

  it('diffs options, rename and grants including grant-option-only changes', () => {
    const request = edit((draft) => {
      draft.options.accountLocked = 'true';
      draft.host = '10.0.%';
      draft.grants = [
        { privilege: 'SELECT', scope: 'database', database: 'sales', withGrantOption: true },
        { privilege: 'UPDATE', scope: 'table', database: 'sales', object: 't' },
        { privilege: 'DELETE', scope: 'table', database: 'sales', object: 't' },
      ];
    });
    expect(request?.options).toEqual({ accountLocked: 'true' });
    expect(request?.rename).toEqual({ kind: 'user', name: 'app', host: '10.0.%' });
    expect(request?.target).toEqual({ kind: 'user', name: 'app', host: '%' });
    expect(request?.grantsAdd).toEqual([
      { privilege: 'SELECT', scope: 'database', database: 'sales', withGrantOption: true },
      { privilege: 'DELETE', scope: 'table', database: 'sales', object: 't' },
    ]);
    expect(request?.grantsRevoke).toEqual([
      { privilege: 'UPDATE', scope: 'table', database: 'sales', object: 't', withGrantOption: true },
    ]);
    expect(countChanges(request)).toBe(5);
  });

  it('diffs memberships and re-grants when admin option changes', () => {
    const request = edit((draft) => {
      draft.memberOf = [
        { role: { kind: 'role', name: 'reader', host: '%' }, adminOption: true },
        { role: { kind: 'role', name: 'writer', host: '%' } },
      ];
    });
    expect(request?.membershipsRemove).toEqual([{ role: { kind: 'role', name: 'reader', host: '%' } }]);
    expect(request?.membershipsAdd).toHaveLength(2);
  });

  it('keeps password plaintext out of preview requests', () => {
    const preview = edit((draft) => {
      draft.password = { set: true, value: 'S3cret!', confirm: 'S3cret!', current: 'old', retainCurrent: true, remove: false };
    });
    expect(preview?.password?.password).toBe('S3cret!');
    const original = buildDraftFromDetail(detail);
    const draft = buildDraftFromDetail(detail);
    draft.password = { set: true, value: 'S3cret!', confirm: 'S3cret!', current: 'old', retainCurrent: true, remove: false };
    const stripped = buildChangeRequest(original, draft, { includeSecrets: false });
    expect(JSON.stringify(stripped)).not.toContain('S3cret');
    expect(JSON.stringify(stripped)).not.toContain('old');
    expect(stripped?.password?.retainCurrent).toBe(true);
  });

  it('formats principal display names per identity shape', () => {
    expect(principalDisplayName({ kind: 'user', name: 'app', host: '%' })).toBe('app@%');
    expect(principalDisplayName({ kind: 'user', name: 'reporter', database: 'admin' })).toBe('reporter (admin)');
    expect(principalDisplayName({ kind: 'role', name: 'r' })).toBe('r');
  });
});
