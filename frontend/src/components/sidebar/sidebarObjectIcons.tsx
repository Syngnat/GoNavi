import React from 'react';

import type { GnIconProps } from '../icons/gnIcon';
import {
  GnAllObjectsIcon,
  GnBoltIcon,
  GnCloudIcon,
  GnConfigFileIcon,
  GnEventIcon,
  GnFunctionIcon,
  GnMaterializedViewIcon,
  GnPackageIcon,
  GnSequenceIcon,
  GnTableIcon,
  GnViewIcon,
} from '../icons/gnIcons';

/**
 * 侧栏里各类对象的图标只在这里定义：过滤标签、树分组 / 节点、命令搜索结果共用，
 * 同一类对象在任何位置都是同一个图标。
 */
export type SidebarObjectIconKind =
  | 'all'
  | 'table'
  | 'view'
  | 'materializedView'
  | 'sequence'
  | 'routine'
  | 'package'
  | 'trigger'
  | 'event'
  | 'nacosService'
  | 'nacosConfig';

const SIDEBAR_OBJECT_ICONS: Record<SidebarObjectIconKind, React.ComponentType<GnIconProps>> = {
  all: GnAllObjectsIcon,
  table: GnTableIcon,
  view: GnViewIcon,
  materializedView: GnMaterializedViewIcon,
  sequence: GnSequenceIcon,
  routine: GnFunctionIcon,
  package: GnPackageIcon,
  trigger: GnBoltIcon,
  event: GnEventIcon,
  nacosService: GnCloudIcon,
  nacosConfig: GnConfigFileIcon,
};

export const renderSidebarObjectIcon = (kind: SidebarObjectIconKind): React.ReactElement => {
  const Icon = SIDEBAR_OBJECT_ICONS[kind];
  return <Icon />;
};
