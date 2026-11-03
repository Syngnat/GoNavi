import React from 'react';

import type { GnIconProps } from '../icons/gnIcon';
import {
  GnAllObjectsIcon,
  GnBoltIcon,
  GnClockIcon,
  GnCloudIcon,
  GnConfigFileIcon,
  GnDatabaseIcon,
  GnEventIcon,
  GnExportIcon,
  GnFunctionIcon,
  GnGaugeIcon,
  GnHistoryIcon,
  GnImportIcon,
  GnInsightIcon,
  GnLinkIcon,
  GnLogIcon,
  GnMaterializedViewIcon,
  GnPackageIcon,
  GnSequenceIcon,
  GnSettingsIcon,
  GnSqlDocIcon,
  GnTableDesignIcon,
  GnTableIcon,
  GnViewIcon,
} from '../icons/gnIcons';

const ICONS: Record<string, React.ComponentType<GnIconProps>> = {
  SQL: GnSqlDocIcon,
  TABLE: GnTableIcon,
  DESIGN: GnTableDesignIcon,
  DB: GnDatabaseIcon,
  EXPORT: GnExportIcon,
  IMPORT: GnImportIcon,
  MOCK: GnBoltIcon,
  COMPARE: GnInsightIcon,
  SYNC: GnHistoryIcon,
  ANALYZE: GnInsightIcon,
  AUDIT: GnLogIcon,
  SNAPSHOT: GnHistoryIcon,
  USERS: GnAllObjectsIcon,
  DRIVER: GnConfigFileIcon,
  PLUGIN: GnPackageIcon,
  BACKUP: GnCloudIcon,
  SETTINGS: GnSettingsIcon,
  TRACE: GnLogIcon,
  REDIS: GnDatabaseIcon,
  JVM: GnGaugeIcon,
  TRG: GnBoltIcon,
  MV: GnMaterializedViewIcon,
  VIEW: GnViewIcon,
  EVT: GnEventIcon,
  JOB: GnClockIcon,
  FUNC: GnFunctionIcon,
  SEQ: GnSequenceIcon,
  PKG: GnPackageIcon,
  DBLINK: GnLinkIcon,
};

export const TabOverflowKindIcon: React.FC<{ kind: string }> = ({ kind }) => {
  const Icon = ICONS[kind] || GnSqlDocIcon;
  return <Icon aria-hidden="true" />;
};
