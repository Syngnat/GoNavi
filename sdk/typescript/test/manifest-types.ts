import type { DataSource, Manifest } from '../src/types.js';

const valid: DataSource = { id: 'fixture', name: 'Fixture', dialect: 'sqlite', command: 'database', readOnly: true };
const manifestWithoutPanels: Manifest = {
  schemaVersion: 1, apiVersion: 1, id: 'example.database', name: 'Database', version: '1.0.0', permissions: ['data.sources'],
  backend: { default: { executable: 'database' } }, contributes: { commands: [{ id: 'database', title: 'Database' }], dataSources: [valid] },
};
// Writable data sources are part of the protocol slice; only the read-only effect rules differ.
const writable: DataSource = { ...valid, readOnly: false };
// The optional top-level icon is the installed-plugin logo; it stays a plain package path.
const withIcon: Manifest = { ...manifestWithoutPanels, icon: 'icons/logo.png' };
// @ts-expect-error Every declaration must explicitly opt into read-only behavior.
const missingReadOnly: DataSource = { id: 'fixture', name: 'Fixture', dialect: 'sqlite', command: 'database' };
// @ts-expect-error Only the three negotiated SQL families are supported.
const unsupportedDialect: DataSource = { ...valid, dialect: 'oracle' };
void [manifestWithoutPanels, writable, withIcon, missingReadOnly, unsupportedDialect];
