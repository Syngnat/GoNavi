import React, { useState } from 'react';
import type { ScriptCellValue } from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';

const MAX_VISIBLE_CELL_CHARS = 2_000;

export const ScriptResultCell: React.FC<{
  value: ScriptCellValue;
  t: ScriptWorkbenchTranslate;
}> = ({ value, t }) => {
  const [expanded, setExpanded] = useState(false);
  if (value === null) return <em>{t('script_workbench.results.null')}</em>;
  if (value === undefined) {
    return (
      <span
        className="gn-script-result-empty-value"
        aria-label={t('script_workbench.results.empty_value')}
      >
        —
      </span>
    );
  }
  const text = String(value);
  if (text.length <= MAX_VISIBLE_CELL_CHARS) return <>{text}</>;
  return (
    <div className="gn-script-result-cell">
      <span>{expanded ? text : `${text.slice(0, MAX_VISIBLE_CELL_CHARS)}…`}</span>
      <button
        type="button"
        className="gn-script-result-cell-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded
          ? t('script_workbench.results.collapse_cell')
          : t('script_workbench.results.expand_cell')}
      </button>
    </div>
  );
};
