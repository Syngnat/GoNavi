import React, { useEffect, useState } from 'react';
import {
  CaretRightOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  StopFilled,
} from '@ant-design/icons';

import type { AIChatRunActivity } from '../../../types';
import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import type { I18nParams } from '../../../i18n/types';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { formatProcessingDuration } from '../aiMessageTimeFormat';

interface AIActivityTimelineProps {
  activities: AIChatRunActivity[];
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
}

type ActivityStatus = AIChatRunActivity['status'];

const STATUS_COLORS: Record<ActivityStatus, string> = {
  active: '#1677ff',
  waiting: '#d97706',
  completed: '#10b981',
  failed: '#dc2626',
  canceled: '#6b7280',
};

const isInProgress = (activity: AIChatRunActivity): boolean => (
  activity.status === 'active' || activity.status === 'waiting'
);

const StatusIcon: React.FC<{ status: ActivityStatus }> = ({ status }) => {
  switch (status) {
    case 'active': return <span className="ai-spinning-ring ai-run-spinner" />;
    case 'waiting': return <ClockCircleOutlined />;
    case 'completed': return <CheckOutlined />;
    case 'failed': return <CloseCircleFilled />;
    case 'canceled': return <StopFilled />;
  }
};

/**
 * How long a finished step took: from its first appearance to the next step's.
 * The last step has no successor, so it shows nothing rather than a guess.
 */
const stepDurationMs = (
  activity: AIChatRunActivity,
  next: AIChatRunActivity | undefined,
): number => (
  activity.status === 'completed' && next && next.timestamp > activity.timestamp
    ? next.timestamp - activity.timestamp
    : 0
);

export const AIActivityTimeline: React.FC<AIActivityTimelineProps> = ({
  activities,
  darkMode,
  overlayTheme,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: I18nParams) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
  // `run` is the Harness aggregate record. Once a concrete step exists, it
  // would only repeat the same state already represented by that step.
  const visibleActivities = activities.some((activity) => activity.kind !== 'run')
    ? activities.filter((activity) => activity.kind !== 'run')
    : activities;
  const activeActivity = [...visibleActivities].reverse().find(isInProgress);
  const hasFailure = activities.some((activity) => activity.status === 'failed');
  const wasCanceled = !hasFailure && activities.some((activity) => activity.status === 'canceled');
  const [expanded, setExpanded] = useState(Boolean(activeActivity));

  useEffect(() => {
    if (activeActivity) setExpanded(true);
    else setExpanded(false);
  }, [activeActivity?.id, activeActivity?.status]);

  if (activities.length === 0) return null;

  const activityKindLabel = (activity: AIChatRunActivity): string => {
    if (activity.kind !== 'tool') return copy(`ai_chat.message.activity.kind.${activity.kind}`);
    const actionKey = `ai_chat.message.tool_call.${activity.toolName || ''}`;
    const translatedToolName = activity.toolName && copy(actionKey) !== actionKey
      ? copy(actionKey)
      : activity.toolName || copy('ai_chat.message.activity.tool_unknown');
    return copy('ai_chat.message.activity.kind.tool', { name: translatedToolName });
  };

  const summary = activeActivity
    ? copy(`ai_chat.message.activity.status.${activeActivity.status}`)
    : hasFailure
      ? copy('ai_chat.message.activity.summary.failed')
      : wasCanceled
        ? copy('ai_chat.message.activity.summary.canceled')
        : copy('ai_chat.message.activity.summary.completed', {
          count: activities.filter((activity) => activity.kind !== 'run').length,
        });
  const headerStatus: ActivityStatus = activeActivity
    ? activeActivity.status
    : hasFailure ? 'failed' : wasCanceled ? 'canceled' : 'completed';
  const language = i18n?.language ?? 'en-US';

  const themeVars = {
    '--ai-run-title': overlayTheme.titleText,
    '--ai-run-muted': overlayTheme.mutedText,
    '--ai-run-border': darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    '--ai-run-rail': darkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
    '--ai-run-surface': darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.018)',
    '--ai-run-hover': darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
  } as React.CSSProperties;

  return (
    <section
      className="ai-run"
      data-testid="ai-activity-timeline"
      aria-label={copy('ai_chat.message.activity.title')}
      style={themeVars}
    >
      <button
        type="button"
        className="ai-run-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="ai-run-icon" style={{ color: STATUS_COLORS[headerStatus] }}>
          <StatusIcon status={headerStatus} />
        </span>
        <span className="ai-run-header-text">
          <span className="ai-run-header-title">{copy('ai_chat.message.activity.title')}</span>
          <span className="ai-run-header-summary">{summary}</span>
        </span>
        <CaretRightOutlined className="ai-run-caret" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
      </button>
      {expanded && (
        <ol className="ai-run-steps">
          {visibleActivities.map((activity, index) => {
            const label = activityKindLabel(activity);
            const durationMs = stepDurationMs(activity, visibleActivities[index + 1]);
            const trailing = activity.status === 'completed'
              ? formatProcessingDuration(durationMs, language)
              : copy(`ai_chat.message.activity.status.${activity.status}`);
            return (
              <li
                key={activity.id}
                className="ai-run-step"
                data-activity-kind={activity.kind}
                data-activity-status={activity.status}
                aria-label={`${label} · ${copy(`ai_chat.message.activity.status.${activity.status}`)}`}
              >
                <span className="ai-run-icon" style={{ color: STATUS_COLORS[activity.status] }}>
                  <StatusIcon status={activity.status} />
                </span>
                <span className="ai-run-step-label">{label}</span>
                <span className="ai-run-step-trailing" style={activity.status === 'completed' ? undefined : { color: STATUS_COLORS[activity.status] }}>
                  {trailing}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
