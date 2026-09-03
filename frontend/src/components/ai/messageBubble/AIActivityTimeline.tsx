import React, { useEffect, useState } from 'react';
import {
  ApiOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  StopFilled,
  SyncOutlined,
} from '@ant-design/icons';

import type { AIChatRunActivity } from '../../../types';
import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import type { I18nParams } from '../../../i18n/types';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';

interface AIActivityTimelineProps {
  activities: AIChatRunActivity[];
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
}

const isInProgress = (activity: AIChatRunActivity): boolean => (
  activity.status === 'active' || activity.status === 'waiting'
);

const activityColor = (status: AIChatRunActivity['status']): string => {
  switch (status) {
    case 'active': return '#1677ff';
    case 'waiting': return '#d97706';
    case 'completed': return '#10b981';
    case 'failed': return '#dc2626';
    case 'canceled': return '#6b7280';
  }
};

const ActivityStatusIcon: React.FC<{ status: AIChatRunActivity['status'] }> = ({ status }) => {
  const style = { color: activityColor(status), fontSize: 13 };
  switch (status) {
    case 'active': return <LoadingOutlined spin style={style} />;
    case 'waiting': return <ClockCircleOutlined style={style} />;
    case 'completed': return <CheckCircleFilled style={style} />;
    case 'failed': return <CloseCircleFilled style={style} />;
    case 'canceled': return <StopFilled style={style} />;
  }
};

const ActivityKindIcon: React.FC<{ kind: AIChatRunActivity['kind'] }> = ({ kind }) => {
  const style = { fontSize: 12 };
  switch (kind) {
    case 'model': return <RobotOutlined style={style} />;
    case 'tool': return <ApiOutlined style={style} />;
    case 'approval': return <SafetyCertificateOutlined style={style} />;
    case 'retry': return <SyncOutlined style={style} />;
    case 'workspace': return <ClockCircleOutlined style={style} />;
    case 'run': return <CheckCircleFilled style={style} />;
  }
};

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

  const activityLabel = (activity: AIChatRunActivity): string => (
    `${activityKindLabel(activity)} · ${copy(`ai_chat.message.activity.status.${activity.status}`)}`
  );

  const summary = activeActivity
    ? copy(`ai_chat.message.activity.status.${activeActivity.status}`)
    : hasFailure
      ? copy('ai_chat.message.activity.summary.failed')
      : wasCanceled
        ? copy('ai_chat.message.activity.summary.canceled')
        : copy('ai_chat.message.activity.summary.completed', {
          count: activities.filter((activity) => activity.kind !== 'run').length,
        });

  return (
    <section
      data-testid="ai-activity-timeline"
      aria-label={copy('ai_chat.message.activity.title')}
      style={{
        marginTop: 10,
        paddingTop: 9,
        borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'}`,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          minHeight: 24,
          padding: 0,
          border: 0,
          background: 'transparent',
          color: overlayTheme.mutedText,
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: '16px minmax(0, 1fr) 14px',
          alignItems: 'center',
          columnGap: 7,
          textAlign: 'left',
          fontSize: 12,
        }}
      >
        {activeActivity ? <ActivityStatusIcon status={activeActivity.status} /> : <ActivityKindIcon kind="run" />}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: overlayTheme.titleText, marginRight: 7 }}>{copy('ai_chat.message.activity.title')}</span>
          <span>{summary}</span>
        </span>
        <CaretRightOutlined style={{ fontSize: 10, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} />
      </button>

      {expanded && (
        <div style={{ position: 'relative', margin: '8px 0 1px 7px', paddingLeft: 17 }}>
          <div style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: 1, background: darkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.13)' }} />
          {visibleActivities.map((activity) => (
            <div
              key={activity.id}
              data-activity-kind={activity.kind}
              data-activity-status={activity.status}
              style={{
                position: 'relative',
                minHeight: 24,
                display: 'grid',
                gridTemplateColumns: '15px minmax(0, 1fr)',
                alignItems: 'center',
                columnGap: 7,
                color: activity.status === 'active' ? overlayTheme.titleText : overlayTheme.mutedText,
                fontSize: 12,
              }}
            >
              <span style={{ position: 'absolute', left: -24, top: 5, width: 14, height: 14, background: darkMode ? '#1b1f24' : '#ffffff', display: 'grid', placeItems: 'center' }}>
                <ActivityStatusIcon status={activity.status} />
              </span>
              <ActivityKindIcon kind={activity.kind} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activityLabel(activity)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
