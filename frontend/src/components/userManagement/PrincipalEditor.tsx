import { useMemo, useState } from 'react';
import { Alert, Tabs } from 'antd';
import { useI18n } from '../../i18n/provider';
import GeneralTab from './editor/GeneralTab';
import MembershipTab from './editor/MembershipTab';
import ObjectPrivilegesTab from './editor/ObjectPrivilegesTab';
import type { CatalogObject } from './editor/objectPrivilegeTree';
import OptionsForm from './editor/OptionsForm';
import PreviewTab from './editor/PreviewTab';
import RedisAclRulesTab from './editor/RedisAclRulesTab';
import ServerPrivilegesTab from './editor/ServerPrivilegesTab';
import { userManagementEditorTabLabel } from './userManagementFieldLabels';
import type { PrincipalDraftController } from './usePrincipalDraft';
import type { PrincipalRef, UMGrant, UMPlan, UMPrincipal, UMServerProfile } from './userManagementTypes';

interface PrincipalEditorProps {
  profile: UMServerProfile;
  controller: PrincipalDraftController;
  principals: UMPrincipal[];
  inherited: UMGrant[];
  members: PrincipalRef[];
  writable: boolean;
  database: string;
  databases: string[];
  loadTables: (database: string) => Promise<string[]>;
  loadColumns: (database: string, table: string) => Promise<string[]>;
  loadObjects: (database: string) => Promise<CatalogObject[]>;
  preview: { plan: UMPlan | null; loading: boolean; error: string };
  readOnlyReason?: string;
}

/** 主体编辑器：按服务端版本下发的标签页组合各编辑面板。 */
export default function PrincipalEditor(props: PrincipalEditorProps) {
  const { profile, controller, principals, inherited, members, writable, database, databases, loadTables, loadColumns, loadObjects, preview, readOnlyReason } = props;
  const { t } = useI18n();
  const draft = controller.draft;
  const [activeTab, setActiveTab] = useState('general');
  const kind = profile.kinds.find((item) => item.kind === draft?.kind);
  const tabs = useMemo(() => (kind?.editorTabs.length ? kind.editorTabs : profile.editorTabs), [kind, profile.editorTabs]);
  if (!draft) return null;

  const renderTab = (tab: string) => {
    switch (tab) {
      case 'general':
        return (
          <GeneralTab
            profile={profile}
            draft={draft}
            writable={writable}
            databases={databases}
            onIdentityChange={controller.update}
            onPasswordChange={controller.setPassword}
            onOptionChange={controller.setOption}
          />
        );
      case 'advanced':
        return <div className="gn-user-mgmt-tab-body"><OptionsForm profile={profile} draft={draft} tab="advanced" writable={writable} onChange={controller.setOption} /></div>;
      case 'server-privileges':
        return <ServerPrivilegesTab profile={profile} draft={draft} inherited={inherited} writable={writable} onOptionChange={controller.setOption} onGrantsChange={controller.setGrants} />;
      case 'object-privileges':
        return (
          <ObjectPrivilegesTab
            profile={profile}
            draft={draft}
            inherited={inherited}
            writable={writable}
            database={database}
            databases={databases}
            loadTables={loadTables}
            loadColumns={loadColumns}
            loadObjects={loadObjects}
            onGrantsChange={controller.setGrants}
          />
        );
      case 'membership':
        return <MembershipTab profile={profile} draft={draft} principals={principals} members={members} writable={writable} onMembershipsChange={controller.setMemberOf} onOptionChange={controller.setOption} />;
      case 'redis-rules':
        return <RedisAclRulesTab profile={profile} draft={draft} writable={writable} onOptionChange={controller.setOption} />;
      case 'preview':
        return <PreviewTab family={String(profile.family)} plan={preview.plan} loading={preview.loading} error={preview.error} hasChanges={controller.changeCount > 0} />;
      default:
        return null;
    }
  };

  return (
    <div className="gn-user-mgmt-editor">
      {readOnlyReason && <Alert type="warning" showIcon message={readOnlyReason} className="gn-user-mgmt-editor-alert" />}
      <Tabs
        className="gn-user-mgmt-editor-tabs"
        activeKey={tabs.includes(activeTab) ? activeTab : tabs[0]}
        onChange={setActiveTab}
        items={tabs.map((tab) => ({ key: tab, label: userManagementEditorTabLabel(tab, t), children: renderTab(tab) }))}
      />
    </div>
  );
}
