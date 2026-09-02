import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { renderSidebarV2TreeTitle } from './SidebarTreeTitle';

const baseOptions = {
  hoverTitle: 'Oracle object',
  statusBadge: null,
  getV2TreeMetaText: () => '',
  sidebarTableMetadataFields: [],
  snapshotTreeSelectionBeforeDrag: vi.fn(),
  restoreTreeSelectionAfterDrag: vi.fn(),
  treeDragSelectSuppressUntilRef: { current: 0 },
  setIsTreeDragging: vi.fn(),
};

describe('Oracle object compilation status in the V2 sidebar tree', () => {
  it('renders an invalid compiler-status badge for a trigger', () => {
    const markup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      node: {
        type: 'db-trigger',
        key: 'oracle-trigger',
        title: 'TRG_AUDIT',
        dataRef: { objectStatus: 'INVALID' },
      },
    }));

    expect(markup).toContain('gn-v2-tree-object-status is-invalid');
    expect(markup).toContain('data-sidebar-object-status="INVALID"');
  });
});

describe('message queue nodes in the V2 sidebar tree', () => {
  it('makes a message object draggable into the SQL editor', () => {
    const markup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      node: {
        type: 'message-object',
        key: 'mqtt-topic',
        title: 'devices/+/telemetry',
        dataRef: {
          messageQueue: true,
          messageObjectName: 'devices/+/telemetry',
          messageObjectKind: 'topic-filter',
        },
      },
    }));

    expect(markup).toContain('draggable="true"');
    expect(markup).toContain('data-sidebar-node-type="message-object"');
    expect(markup).toContain('is-mono');
  });
});
