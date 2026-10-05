package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolveDataImportCapabilityFollowsRegistryDeclarations(t *testing.T) {
	cases := []struct {
		kind              string
		tableImport       bool
		sqlFileImport     bool
		transactionalRows bool
	}{
		{kind: "tidb", tableImport: true, sqlFileImport: true, transactionalRows: false},
		{kind: "cockroachdb", tableImport: true, sqlFileImport: true, transactionalRows: true},
		{kind: "gbase8c", tableImport: true, sqlFileImport: true, transactionalRows: true},
		{kind: "firebird", tableImport: true, sqlFileImport: true, transactionalRows: true},
		{kind: "questdb", tableImport: true, sqlFileImport: true, transactionalRows: false},
		{kind: "meilisearch", tableImport: true, sqlFileImport: false, transactionalRows: false},
		{kind: "etcd", tableImport: true, sqlFileImport: false, transactionalRows: false},
		{kind: "opensearch", tableImport: false, sqlFileImport: false},
		{kind: "presto", tableImport: false, sqlFileImport: false},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			config := connection.ConnectionConfig{Type: tc.kind}
			got := ResolveDataImportCapability(config, &fullyCapableImportDatabase{})
			if got.TableImport.Supported != tc.tableImport || got.SQLFileImport.Supported != tc.sqlFileImport {
				t.Fatalf("table=%v sqlFile=%v, want table=%v sqlFile=%v (%+v)", got.TableImport.Supported, got.SQLFileImport.Supported, tc.tableImport, tc.sqlFileImport, got)
			}
			if tc.tableImport && got.TableImport.SupportsTransactionalBatch != tc.transactionalRows {
				t.Fatalf("transactional batch = %v, want %v", got.TableImport.SupportsTransactionalBatch, tc.transactionalRows)
			}
			if isDataImportSQLDialectSupported(config) != tc.sqlFileImport {
				t.Fatalf("SQL import gate disagrees with the capability for %s", tc.kind)
			}
		})
	}
}
