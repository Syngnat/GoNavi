package app

import (
	"reflect"
	"strings"
	"testing"
)

func TestPlanSQLImportRollbackScopesCreateOnlyFile(t *testing.T) {
	plan, err := planSQLImportRollbackReader(strings.NewReader(`
-- 14 条建表语句不应触发整库导出
CREATE TABLE `+"`users`"+` (id BIGINT);
CREATE TABLE IF NOT EXISTS `+"`orders`"+` (id BIGINT);
CREATE INDEX idx_users_id ON `+"`users`"+` (id);
CREATE VIEW `+"`active_users`"+` AS SELECT * FROM `+"`users`"+`;
`), "mysql", DefaultSQLImportMaxStatementBytes)
	if err != nil {
		t.Fatal(err)
	}
	if plan.WholeDatabase {
		t.Fatalf("CREATE-only file requested a whole database snapshot: %+v", plan)
	}
	if !plan.AdditiveOnly {
		t.Fatalf("CREATE-only file was not marked additive: %+v", plan)
	}
	want := []string{"users", "orders", "active_users"}
	if !reflect.DeepEqual(plan.Tables, want) {
		t.Fatalf("tables = %#v, want %#v", plan.Tables, want)
	}
}

func TestPlanSQLImportRollbackScopesDMLTargets(t *testing.T) {
	plan, err := planSQLImportRollbackReader(strings.NewReader(`
INSERT INTO users (id) VALUES (1);
UPDATE orders SET status = 'paid' WHERE id = 1;
DELETE FROM users WHERE id = 1;
ALTER TABLE orders ADD COLUMN note VARCHAR(20);
`), "mysql", DefaultSQLImportMaxStatementBytes)
	if err != nil {
		t.Fatal(err)
	}
	if plan.WholeDatabase {
		t.Fatalf("known DML requested a whole database snapshot: %+v", plan)
	}
	if plan.AdditiveOnly {
		t.Fatalf("DML file was incorrectly marked additive: %+v", plan)
	}
	want := []string{"users", "orders"}
	if !reflect.DeepEqual(plan.Tables, want) {
		t.Fatalf("tables = %#v, want %#v", plan.Tables, want)
	}
}

func TestPlanSQLImportRollbackFallsBackForUnknownStatements(t *testing.T) {
	cases := []string{
		"CALL refresh_sales();",
		"DROP DATABASE app;",
		"CREATE OR REPLACE VIEW v AS SELECT 1;",
		"WITH changed AS (SELECT 1) UPDATE users SET id = 1;",
	}
	for _, sql := range cases {
		plan, err := planSQLImportRollbackReader(strings.NewReader(sql), "mysql", DefaultSQLImportMaxStatementBytes)
		if err != nil {
			t.Fatalf("%q: %v", sql, err)
		}
		if !plan.WholeDatabase {
			t.Fatalf("%q did not fall back to a whole database snapshot: %+v", sql, plan)
		}
		if plan.AdditiveOnly {
			t.Fatalf("%q was incorrectly marked additive: %+v", sql, plan)
		}
	}
}
