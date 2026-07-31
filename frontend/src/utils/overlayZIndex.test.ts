import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigProvider } from 'antd';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APP_APPLICATION_QUIT_MODAL_Z_INDEX,
  APP_COMMAND_PALETTE_Z_INDEX,
  APP_DETACHED_WINDOW_Z_INDEX_BASE,
  APP_FOREGROUND_MODAL_Z_INDEX,
  APP_NESTED_MODAL_Z_INDEX,
  APP_OVERLAY_Z_INDEX_BASE,
  APP_POPUP_Z_INDEX,
  APP_STATIC_FEEDBACK_Z_INDEX_BASE,
  configureAntdStaticOverlayLayer,
} from './overlayZIndex';

const readSource = (path: string): string => readFileSync(
  fileURLToPath(new globalThis.URL(path, import.meta.url)),
  'utf8',
);
const floatingAIChatSource = readSource('../components/FloatingAIChatWindow.tsx');
const floatingWorkbenchSource = readSource('../components/FloatingWorkbenchWindows.tsx');
const floatingQueryResultSource = readSource('../components/FloatingQueryResultWindows.tsx');
const legacyGridContextMenuSource = readSource('../components/DataGridLegacyCellContextMenu.tsx');
const dataGridShellSource = readSource('../components/DataGridShell.tsx');
const sidebarSource = readSource('../components/Sidebar.tsx');
const tableOverviewSource = readSource('../components/TableOverview.tsx');

const collectRuntimeSources = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
  const absolutePath = `${directory}/${entry}`;
  if (statSync(absolutePath).isDirectory()) {
    return collectRuntimeSources(absolutePath);
  }
  if (!/\.(?:ts|tsx)$/.test(entry) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry)) {
    return [];
  }
  return [absolutePath];
});

const importsRawAntdModal = (source: string, filePath: string): boolean => {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const antdNamespaceAliases = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (/^antd\/(?:es|lib)\/modal(?:\/|$)/.test(moduleName)) return true;
    if (moduleName !== 'antd' || !statement.importClause) continue;

    if (statement.importClause.name) {
      antdNamespaceAliases.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      antdNamespaceAliases.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      const importsModal = bindings.elements.some((element) => (
        (element.propertyName || element.name).text === 'Modal'
      ));
      if (importsModal) return true;
    }
  }

  let usesNamespaceModal = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && antdNamespaceAliases.has(node.expression.text)
      && node.name.text === 'Modal'
    ) {
      usesNamespaceModal = true;
      return;
    }
    if (!usesNamespaceModal) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return usesNamespaceModal;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('application overlay z-index policy', () => {
  it('keeps root dialogs, floating windows, popups, and foreground dialogs ordered', () => {
    expect(APP_OVERLAY_Z_INDEX_BASE).toBe(10_000);
    expect(APP_DETACHED_WINDOW_Z_INDEX_BASE).toBeGreaterThan(APP_OVERLAY_Z_INDEX_BASE);
    expect(APP_POPUP_Z_INDEX).toBeGreaterThan(APP_DETACHED_WINDOW_Z_INDEX_BASE);
    expect(APP_FOREGROUND_MODAL_Z_INDEX).toBeGreaterThan(APP_POPUP_Z_INDEX);
    expect(APP_NESTED_MODAL_Z_INDEX).toBeGreaterThan(APP_FOREGROUND_MODAL_Z_INDEX);
    expect(APP_COMMAND_PALETTE_Z_INDEX).toBeGreaterThan(APP_NESTED_MODAL_Z_INDEX);
    expect(APP_APPLICATION_QUIT_MODAL_Z_INDEX).toBeGreaterThan(APP_COMMAND_PALETTE_Z_INDEX);
    expect(APP_STATIC_FEEDBACK_Z_INDEX_BASE).toBeGreaterThan(APP_APPLICATION_QUIT_MODAL_Z_INDEX);
  });

  it('configures static Ant Design feedback above every dialog layer', () => {
    const configSpy = vi.spyOn(ConfigProvider, 'config').mockImplementation(() => undefined);

    configureAntdStaticOverlayLayer();

    expect(configSpy).toHaveBeenCalledWith({
      theme: {
        token: {
          zIndexPopupBase: APP_STATIC_FEEDBACK_Z_INDEX_BASE,
        },
      },
    });
  });

  it('keeps every in-WebView floating window above root dialogs with usable portaled popups', () => {
    for (const source of [
      floatingAIChatSource,
      floatingWorkbenchSource,
      floatingQueryResultSource,
    ]) {
      expect(source).toContain("import { createPortal } from 'react-dom';");
      expect(source).toContain('zIndexPopupBase: APP_POPUP_Z_INDEX');
      expect(source).toContain('document.body');
    }
  });

  it('routes body-level context menus through the shared popup layer', () => {
    for (const source of [
      legacyGridContextMenuSource,
      dataGridShellSource,
      sidebarSource,
      tableOverviewSource,
    ]) {
      expect(source).toContain('zIndex: APP_POPUP_Z_INDEX');
    }
  });

  it('detects raw Ant Design Modal import variants', () => {
    expect(importsRawAntdModal("import { Modal } from 'antd';", 'named.ts')).toBe(true);
    expect(importsRawAntdModal("import * as antd from 'antd'; antd.Modal.confirm({});", 'namespace.ts')).toBe(true);
    expect(importsRawAntdModal("import antd from 'antd'; antd.Modal.confirm({});", 'default.ts')).toBe(true);
    expect(importsRawAntdModal("import Modal from 'antd/es/modal';", 'subpath.ts')).toBe(true);
    expect(importsRawAntdModal("import type { ModalProps } from 'antd';", 'types.ts')).toBe(false);
  });
});
