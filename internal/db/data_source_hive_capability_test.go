package db

import "testing"

func TestHiveCapabilityDoesNotBorrowRelationalTransactions(t *testing.T) {
	capability := ResolveDataSourceCapability("hive")
	if !capability.Query.Supported || !capability.Metadata.Supported || !capability.Pagination.Supported || !capability.Cancel.Supported {
		t.Fatalf("Hive core capability unavailable: %+v", capability)
	}
	if capability.Transaction.Supported || capability.Schema.Supported || capability.UI.UserManagement {
		t.Fatalf("Hive must not advertise MySQL/PG-only capabilities: %+v", capability)
	}
	// Hive has no server prepared statements; the driver binds ? placeholders into
	// escaped HiveQL literals, so parameter binding is a supported app capability.
	if !capability.UI.ParameterBinding {
		t.Fatalf("Hive client-side parameter binding missing: %+v", capability.UI)
	}
	if !capability.UI.SQLQueryExport || capability.UI.CopyInsert || !capability.UI.CreateDatabase || !capability.UI.DropDatabase || !capability.UI.ExplainDiagnosis {
		t.Fatalf("Hive native SQL tools missing: %+v", capability.UI)
	}
	if !capability.UI.ForceReadOnlyQueryResult || !capability.UI.PreferManualTotalCount || capability.UI.CreateDatabaseCharset {
		t.Fatalf("Hive table-specific write/count semantics lost: %+v", capability.UI)
	}
}
