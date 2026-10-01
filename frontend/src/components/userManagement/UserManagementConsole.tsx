import { useMemo, useState } from 'react';
import { Alert, Button, Spin } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { SavedConnection } from '../../types';
import ApplyReviewModal from './ApplyReviewModal';
import DropPrincipalModal from './DropPrincipalModal';
import { isPasswordDraftValid } from './editor/PasswordSection';
import { useObjectCatalog } from './editor/useObjectCatalog';
import ExportDDLModal from './ExportDDLModal';
import PasswordSyncModal from './PasswordSyncModal';
import PrincipalEditor from './PrincipalEditor';
import PrincipalListPanel from './PrincipalListPanel';
import UserManagementEmpty from './UserManagementEmpty';
import UserManagementHeader from './UserManagementHeader';
import { GnUsersIcon } from './userManagementIcons';
import type { UserManagementBackend } from './userManagementRpc';
import type { UMPrincipal } from './userManagementTypes';
import { useUserManagementConsole } from './useUserManagementConsole';

interface UserManagementConsoleProps {
  connection: SavedConnection;
  backend: UserManagementBackend;
}

/** 单个连接的用户管理控制台：头部 + 主体列表 + 编辑器 + 底栏与各类弹窗。 */
export default function UserManagementConsole({ connection, backend }: UserManagementConsoleProps) {
  const { t } = useI18n();
  const state = useUserManagementConsole(connection, backend, t);
  const { profile, draftState, detailState, preview } = state;
  const catalogEnabled = Boolean(profile?.supported && (
    profile.editorTabs.includes('object-privileges')
    || profile.features.databaseScoped
    || profile.kinds.some((item) => item.identityFields.includes('database'))
  ));
  const catalog = useObjectCatalog(backend, state.config, catalogEnabled, connection, profile?.objectScopes ?? []);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<UMPrincipal | null>(null);
  const [exportTarget, setExportTarget] = useState<UMPrincipal | null>(null);
  const inherited = useMemo(() => detailState.detail?.grants.filter((grant) => grant.inherited) ?? [], [detailState.detail]);
  const draft = draftState.draft;
  const kind = profile?.kinds.find((item) => item.kind === draft?.kind);
  const passwordValid = draft ? isPasswordDraftValid(draft, kind?.supportsPassword === true) : false;
  const canApply = state.writable && draftState.changeCount > 0 && passwordValid && Boolean(draft?.name.trim());

  if (state.overviewState.error && !profile) {
    return <div className="gn-user-mgmt"><Alert type="error" showIcon message={state.overviewState.error} action={<Button size="small" onClick={state.refreshAll}>{t('user_management.action.retry')}</Button>} /></div>;
  }

  return (
    <div className="gn-user-mgmt">
      <UserManagementHeader
        connection={connection}
        profile={profile}
        loading={state.overviewState.loading}
        databases={catalog.databases}
        database={state.database}
        onDatabaseChange={state.setDatabase}
        onRefresh={state.refreshAll}
      />
      {!profile ? <div className="gn-user-mgmt-loading"><Spin /></div> : !profile.supported ? null : (
        <div className="gn-user-mgmt-body">
          <PrincipalListPanel
            profile={profile}
            principals={state.principals}
            loading={state.overviewState.loading}
            selectedRef={state.selection.ref}
            creating={Boolean(state.selection.creating)}
            writable={state.writable}
            onSelect={state.select}
            onCreate={state.startCreate}
            onDrop={setDropTarget}
            onExport={setExportTarget}
          />
          <div className="gn-user-mgmt-editor-pane">
            {detailState.error && <Alert type="error" showIcon message={detailState.error} />}
            {detailState.loading && <div className="gn-user-mgmt-loading"><Spin /></div>}
            {!draft && !detailState.loading && <UserManagementEmpty className="gn-user-mgmt-empty" icon={<GnUsersIcon />} text={t('user_management.editor.empty')} />}
            {draft && (
              <PrincipalEditor
                profile={profile}
                controller={draftState}
                principals={state.principals}
                inherited={inherited}
                members={detailState.detail?.members ?? []}
                writable={state.writable}
                database={state.database}
                databases={catalog.databases}
                loadTables={catalog.loadTables}
                loadColumns={catalog.loadColumns}
                loadObjects={catalog.loadObjects}
                preview={preview}
                readOnlyReason={detailState.detail?.principal.readOnly ? detailState.detail.principal.readOnlyReason || t('user_management.editor.principal_read_only') : undefined}
              />
            )}
            {draft && (
              <div className="gn-user-mgmt-footer">
                <span className="gn-user-mgmt-footer-status">
                  {draftState.changeCount > 0 ? t('user_management.footer.changes', { count: draftState.changeCount }) : t('user_management.footer.no_changes')}
                </span>
                <Button disabled={draftState.changeCount === 0} onClick={draftState.reset}>{t('user_management.footer.discard')}</Button>
                <Button type="primary" disabled={!canApply} onClick={() => { state.clearOutcome(); setReviewOpen(true); }}>{t('user_management.footer.apply')}</Button>
              </div>
            )}
          </div>
        </div>
      )}
      <ApplyReviewModal
        open={reviewOpen}
        family={String(profile?.family || '')}
        plan={preview.plan}
        previewLoading={preview.loading}
        previewError={preview.error}
        applying={state.applying}
        outcome={state.outcome}
        onApply={() => void state.applyDraft()}
        onClose={() => { setReviewOpen(false); state.clearOutcome(); }}
      />
      {dropTarget && <DropPrincipalModal principal={dropTarget} principals={state.principals} backend={backend} config={state.config} onDrop={(options) => state.dropPrincipal(dropTarget.ref, options)} onClose={() => setDropTarget(null)} />}
      {exportTarget && <ExportDDLModal principal={exportTarget} backend={backend} config={state.config} onClose={() => setExportTarget(null)} />}
      {state.passwordSyncValue && !reviewOpen && <PasswordSyncModal connection={connection} password={state.passwordSyncValue} backend={backend} onClose={state.clearPasswordSync} />}
    </div>
  );
}
