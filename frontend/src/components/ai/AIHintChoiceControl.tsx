import React from 'react';
import { Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';

import { passThroughHintTooltip } from '../common/tooltipTiming';

export interface AIHintChoiceOption<T extends string> {
  value: T;
  label: string;
}

interface AIHintChoiceControlProps<T extends string> {
  description?: React.ReactNode;
  options: readonly AIHintChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  choiceHint?: React.ReactNode;
  groupLabel: string;
  questionLabel?: string;
  hideQuestion?: boolean;
}

/** Title note + framed segmented buttons + a pass-through question mark. */
const AIHintChoiceControl = <T extends string>({
  description, options, value, onChange, choiceHint, groupLabel, questionLabel, hideQuestion,
}: AIHintChoiceControlProps<T>) => (
  <div className="gonavi-ai-hint-choice">
    {description ? <div className="gonavi-ai-hint-choice-copy">{description}</div> : null}
    <div className="gonavi-ai-hint-choice-row">
      <div className="gonavi-ai-provider-density" role="group" aria-label={groupLabel}>
        {options.map((option) => <button key={option.value} type="button"
          aria-pressed={value === option.value}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onChange(option.value); }}>
          {option.label}</button>)}
      </div>
      {!hideQuestion && choiceHint && <Tooltip {...passThroughHintTooltip} title={choiceHint}>
        <button type="button" className="gonavi-ai-provider-hint" aria-label={questionLabel}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
          <QuestionCircleOutlined aria-hidden="true" />
        </button>
      </Tooltip>}
    </div>
  </div>
);

export default AIHintChoiceControl;
