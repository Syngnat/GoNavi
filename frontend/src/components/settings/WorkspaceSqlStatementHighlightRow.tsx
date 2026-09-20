import { Switch } from 'antd';

import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';

export const WorkspaceSqlStatementHighlightRow = () => {
  const { t } = useI18n();
  const enabled = useStore((state) => state.appearance.highlightCurrentSqlStatement !== false);
  const setAppearance = useStore((state) => state.setAppearance);

  return (
    <div className="gonavi-settings-row">
      <div>
        <div className="gonavi-settings-label">{t('app.theme.sql_statement_highlight')}</div>
        <div className="gonavi-settings-label-hint">{t('app.theme.sql_statement_highlight_hint')}</div>
      </div>
      <div className="gonavi-settings-control">
        <Switch
          checked={enabled}
          onChange={(checked) => setAppearance({ highlightCurrentSqlStatement: checked })}
        />
      </div>
    </div>
  );
};
