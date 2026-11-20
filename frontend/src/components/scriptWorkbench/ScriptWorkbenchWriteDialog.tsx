import React from 'react';
import { DatabaseOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { ScriptWorkbenchConfirmDialog } from './ScriptWorkbenchConfirmDialog';
import {
  formatScriptBytes,
  scriptSourceBytes,
  scriptSourceHash,
} from './scriptWorkbenchUtils';

export interface ScriptWriteTarget {
  alias: string;
  connectionName: string;
  database: string;
  environment: 'production' | 'test' | 'development' | 'local';
}

interface ScriptWorkbenchWriteDialogProps {
  open: boolean;
  source: string;
  targets: ScriptWriteTarget[];
  t: ScriptWorkbenchTranslate;
  onResolve: (confirmed: boolean) => void;
}

export const ScriptWorkbenchWriteDialog: React.FC<ScriptWorkbenchWriteDialogProps> = ({
  open,
  source,
  targets,
  t,
  onResolve,
}) => (
  <ScriptWorkbenchConfirmDialog
    open={open}
    title={t('script_workbench.write_dialog.title')}
    description={t('script_workbench.write_dialog.description')}
    cancelLabel={t('script_workbench.write_dialog.keep_readonly')}
    confirmLabel={t('script_workbench.write_dialog.allow')}
    danger
    testId="script-workbench-write-dialog"
    onResolve={onResolve}
  >
    <div className="gn-script-dialog-targets">
      {targets.map((target) => (
        <div className="gn-script-dialog-target" key={`${target.alias}:${target.connectionName}`}>
          <span className={target.environment === 'production' ? 'is-production' : undefined}>
            {target.alias}
          </span>
          <DatabaseOutlined aria-hidden="true" />
          <div>
            <strong>{target.database || target.connectionName}</strong>
            <small>
              {target.environment === 'production'
                ? t('script_workbench.write_dialog.target_production')
                : t('script_workbench.write_dialog.target_other')}
            </small>
          </div>
        </div>
      ))}
    </div>
    <div className="gn-script-dialog-hash">
      <span><SafetyCertificateOutlined aria-hidden="true" />{t('script_workbench.write_dialog.hash')}</span>
      <code>
        {scriptSourceHash(source)} · {source.split('\n').length} · {formatScriptBytes(scriptSourceBytes(source))}
      </code>
    </div>
  </ScriptWorkbenchConfirmDialog>
);
