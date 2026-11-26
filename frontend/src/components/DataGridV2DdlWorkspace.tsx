import React from 'react';
import { Button, Segmented } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import Editor, { type OnMount } from './MonacoEditor';
import { t as defaultTranslate, type I18nParams } from '../i18n';

type DdlViewLayoutMode = 'bottom' | 'side';
export type DataGridV2DdlWorkspaceTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridV2DdlViewProps {
  layout: DdlViewLayoutMode;
  translate?: DataGridV2DdlWorkspaceTranslate;
  tableName?: string;
  ddlViewLayout: DdlViewLayoutMode;
  ddlLoading: boolean;
  ddlText: string;
  darkMode: boolean;
  onDdlViewLayoutChange: (layout: DdlViewLayoutMode) => void;
  onClose?: () => void;
  onReload: () => void;
  onCopy: () => void;
}

const handleReadOnlyDdlEditorMount: OnMount = (editor, monaco) => {
  const contentMouseTargetTypes = new Set([
    monaco.editor.MouseTargetType.CONTENT_TEXT,
    monaco.editor.MouseTargetType.CONTENT_EMPTY,
  ]);
  let pendingContentInteraction:
    | { x: number; y: number; scrollLeft: number }
    | null = null;

  const getMousePoint = (event: any) => ({
    x: Number.isFinite(Number(event?.posx)) ? Number(event.posx) : Number(event?.browserEvent?.clientX ?? 0),
    y: Number.isFinite(Number(event?.posy)) ? Number(event.posy) : Number(event?.browserEvent?.clientY ?? 0),
  });

  const restoreScrollLeft = (scrollLeft: number) => {
    const apply = () => {
      if (typeof editor.getScrollLeft === 'function' && editor.getScrollLeft() === scrollLeft) return;
      editor.setScrollLeft?.(scrollLeft);
    };
    apply();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
    }
  };

  editor.onDidScrollChange?.((event: any) => {
    if (!pendingContentInteraction) return;
    if (event?.scrollLeftChanged === false) return;
    restoreScrollLeft(pendingContentInteraction.scrollLeft);
  });

  editor.onMouseDown((event: any) => {
    pendingContentInteraction = null;
    if (!contentMouseTargetTypes.has(event.target?.type)) return;
    const mouseEvent = event.event;
    if (mouseEvent?.browserEvent && mouseEvent.browserEvent.button !== 0) return;
    if (mouseEvent?.leftButton === false) return;
    const point = getMousePoint(mouseEvent);
    pendingContentInteraction = {
      ...point,
      scrollLeft: typeof editor.getScrollLeft === 'function' ? editor.getScrollLeft() : 0,
    };
  });

  editor.onMouseUp((event: any) => {
    const interaction = pendingContentInteraction;
    if (!interaction) return;
    const point = getMousePoint(event.event);
    const moved = Math.abs(point.x - interaction.x) > 3 || Math.abs(point.y - interaction.y) > 3;
    restoreScrollLeft(interaction.scrollLeft);
    if (!moved) {
      pendingContentInteraction = null;
      return;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (pendingContentInteraction === interaction) {
            pendingContentInteraction = null;
          }
        });
      });
      return;
    }
    pendingContentInteraction = null;
  });
};

export const DataGridV2DdlView: React.FC<DataGridV2DdlViewProps> = ({
  layout,
  translate = defaultTranslate,
  tableName,
  ddlViewLayout,
  ddlLoading,
  ddlText,
  darkMode,
  onDdlViewLayoutChange,
  onClose,
  onReload,
  onCopy,
}) => (
  <div data-grid-ddl-view={layout} className={`gn-v2-data-grid-ddl-view${layout === 'side' ? ' is-side' : ''}`}>
    <div className="gn-v2-data-grid-alt-toolbar">
      <div className="gn-v2-data-grid-ddl-title">
        <span>DDL</span>
        <strong>{tableName ? `DDL - ${tableName}` : 'DDL'}</strong>
      </div>
      <div className="gn-v2-data-grid-ddl-actions">
        <Segmented
          size="small"
          value={ddlViewLayout}
          options={[
            { label: translate('data_grid.ddl.layout_fullscreen'), value: 'bottom' },
            { label: translate('data_grid.ddl.layout_side'), value: 'side' },
          ]}
          onChange={(value) => onDdlViewLayoutChange(String(value) as DdlViewLayoutMode)}
        />
        <Button size="small" onClick={onReload} loading={ddlLoading}>
          {translate('data_grid.ddl.reload')}
        </Button>
        <Button size="small" icon={<CopyOutlined />} onClick={onCopy} disabled={!ddlText.trim()}>
          {translate('data_grid.ddl.copy')}
        </Button>
        {layout === 'side' && (
          <Button size="small" onClick={onClose}>
            {translate('common.close')}
          </Button>
        )}
      </div>
    </div>
    <div className="gn-v2-data-grid-ddl-code">
      <Editor
        height="100%"
        gonaviTypography="sql"
        language="sql"
        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
        value={ddlLoading ? translate('data_grid.ddl.loading') : ddlText}
        onMount={handleReadOnlyDdlEditorMount}
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          automaticLayout: true,
          mouseStyle: 'default',
          renderLineHighlight: 'none',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 2,
        }}
      />
    </div>
  </div>
);

export interface DataGridV2DdlSideWorkspaceProps extends Omit<DataGridV2DdlViewProps, 'layout'> {
  tableContent: React.ReactNode;
  ddlSidebarWidth: number;
  ddlSidebarResizePreviewX: number | null;
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export const DataGridV2DdlSideWorkspace: React.FC<DataGridV2DdlSideWorkspaceProps> = ({
  tableContent,
  ddlSidebarWidth,
  ddlSidebarResizePreviewX,
  onResizeStart,
  ...ddlViewProps
}) => {
  const translate = ddlViewProps.translate ?? defaultTranslate;

  return (
    <div
      data-grid-ddl-layout="side"
      className="gn-v2-data-grid-split-workspace"
      style={{
        gridTemplateColumns: `minmax(0, 1fr) 8px ${ddlSidebarWidth}px`,
        '--gn-v2-ddl-sidebar-width': `${ddlSidebarWidth}px`,
      } as React.CSSProperties}
    >
      <div className="gn-v2-data-grid-split-main">
        {tableContent}
      </div>
      <div
        data-grid-ddl-resizer="true"
        className="gn-v2-data-grid-ddl-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={760}
        aria-valuenow={ddlSidebarWidth}
        onMouseDown={onResizeStart}
      />
      <aside aria-label={translate('data_grid.ddl.sidebar_aria')} className="gn-v2-data-grid-ddl-sidebar">
        <DataGridV2DdlView layout="side" {...ddlViewProps} />
      </aside>
      <div
        data-grid-ddl-resize-preview="true"
        className="gn-v2-data-grid-ddl-resize-preview"
        style={{
          opacity: ddlSidebarResizePreviewX === null ? 0 : 1,
          transform: ddlSidebarResizePreviewX === null ? undefined : `translateX(${ddlSidebarResizePreviewX}px)`,
        }}
      />
    </div>
  );
};
