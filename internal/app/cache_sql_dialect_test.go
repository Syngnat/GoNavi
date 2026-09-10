package app

import "testing"

func TestCacheAliasesUseIRISCompatibleSQLFileBehavior(t *testing.T) {
	t.Parallel()

	for _, dbType := range []string{"cache", "Caché", "InterSystems Cache", "InterSystems Caché"} {
		dbType := dbType
		t.Run(dbType, func(t *testing.T) {
			t.Parallel()

			if got := normalizeSQLClassifierDBType(dbType); got != "iris" {
				t.Fatalf("normalizeSQLClassifierDBType(%q) = %q, want iris", dbType, got)
			}
			beginSQL, commitSQL, rollbackSQL, ok := sqlFileBatchTransactionSQL(dbType)
			if !ok || beginSQL != "BEGIN" || commitSQL != "COMMIT" || rollbackSQL != "ROLLBACK" {
				t.Fatalf("sqlFileBatchTransactionSQL(%q) = %q, %q, %q, %v", dbType, beginSQL, commitSQL, rollbackSQL, ok)
			}
			if !isSQLFileSingleTransactionDialectSupported(dbType) {
				t.Fatalf("single-transaction SQL-file execution should support %q", dbType)
			}
			beginSQL, commitSQL, rollbackSQL, ok = sqlFileSingleTransactionSQL(dbType)
			if !ok || beginSQL != "BEGIN" || commitSQL != "COMMIT" || rollbackSQL != "ROLLBACK" {
				t.Fatalf("sqlFileSingleTransactionSQL(%q) = %q, %q, %q, %v", dbType, beginSQL, commitSQL, rollbackSQL, ok)
			}
			if !supportsTruncateTableForDBType(dbType) {
				t.Fatalf("TRUNCATE should be supported for %q", dbType)
			}
			if got := resolveSQLInsertExportMode(dbType); got != sqlInsertExportModeMultiValues {
				t.Fatalf("resolveSQLInsertExportMode(%q) = %v, want multi-values", dbType, got)
			}
		})
	}
}
