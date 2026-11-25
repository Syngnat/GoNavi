package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestCopyViewMySQLChoosesNextSuffixAndRewritesTarget(t *testing.T) {
	database := &fakeCopyTableDB{
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			switch {
			case strings.Contains(query, "TABLE_TYPE='VIEW'"):
				return []map[string]interface{}{
					{"schema_name": "sales", "object_name": "active_orders", "table_type": "VIEW"},
					{"schema_name": "sales", "object_name": "active_orders_copy1", "table_type": "VIEW"},
				}, nil
			case strings.Contains(query, "SHOW CREATE VIEW"):
				return []map[string]interface{}{{
					"Create View": "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER " +
						"VIEW `active_orders` AS select id, total from orders",
				}}, nil
			default:
				return nil, nil
			}
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyView(
		connection.ConnectionConfig{Type: "mysql", Database: "sales"},
		"sales",
		"sales",
		"active_orders",
		"sales",
		"",
	)

	if !result.Success {
		t.Fatalf("CopyView returned failure: %s", result.Message)
	}
	if result.Data != "active_orders_copy2" {
		t.Fatalf("CopyView target = %#v, want active_orders_copy2", result.Data)
	}
	if len(database.execQueries) != 1 {
		t.Fatalf("Exec count = %d, want 1: %#v", len(database.execQueries), database.execQueries)
	}
	got := database.execQueries[0]
	if !strings.Contains(got, "VIEW `sales`.`active_orders_copy2` AS select id, total from orders") {
		t.Fatalf("copy SQL = %q", got)
	}
	if strings.Contains(got, "DEFINER=") {
		t.Fatalf("copy SQL must not duplicate the original view name prefix: %q", got)
	}
}

func TestCopyViewPostgresBuildsQualifiedCreateStatement(t *testing.T) {
	database := &fakeCopyTableDB{
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			switch {
			case strings.Contains(query, "information_schema.views"):
				return []map[string]interface{}{
					{"schema_name": "public", "object_name": "orders_view"},
				}, nil
			case strings.Contains(query, "pg_get_viewdef"):
				return []map[string]interface{}{{
					"ddl": " SELECT id, total FROM orders;",
				}}, nil
			default:
				return nil, nil
			}
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyView(
		connection.ConnectionConfig{Type: "postgres", Database: "shop"},
		"shop",
		"public",
		"orders_view",
		"shop",
		"public",
	)

	if !result.Success {
		t.Fatalf("CopyView returned failure: %s", result.Message)
	}
	if len(database.execQueries) != 1 {
		t.Fatalf("Exec count = %d, want 1: %#v", len(database.execQueries), database.execQueries)
	}
	got := database.execQueries[0]
	if !strings.Contains(got, `CREATE VIEW "public"."orders_view_copy1" AS`) {
		t.Fatalf("copy SQL = %q", got)
	}
	if !strings.Contains(got, "SELECT id, total FROM orders") {
		t.Fatalf("copy SQL lost the view body: %q", got)
	}
}

func TestCopyViewMySQLCopiesAcrossDatabases(t *testing.T) {
	database := &fakeCopyTableDB{
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			switch {
			case strings.Contains(query, "TABLE_TYPE='VIEW'"):
				return []map[string]interface{}{}, nil
			case strings.Contains(query, "SHOW CREATE VIEW"):
				return []map[string]interface{}{{
					"Create View": "CREATE VIEW `active_orders` AS select id, total from orders",
				}}, nil
			default:
				return nil, nil
			}
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyView(
		connection.ConnectionConfig{Type: "mysql", Database: "sales"},
		"sales",
		"sales",
		"active_orders",
		"archive",
		"",
	)

	if !result.Success {
		t.Fatalf("CopyView returned failure: %s", result.Message)
	}
	if result.Data != "active_orders_copy1" {
		t.Fatalf("CopyView target = %#v, want active_orders_copy1", result.Data)
	}
	if len(database.execQueries) != 1 {
		t.Fatalf("Exec count = %d, want 1: %#v", len(database.execQueries), database.execQueries)
	}
	if got := database.execQueries[0]; !strings.Contains(
		got,
		"VIEW `archive`.`active_orders_copy1` AS select id, total from orders",
	) {
		t.Fatalf("copy SQL = %q", got)
	}
	targetLookupFound := false
	for _, query := range database.queryQueries {
		if strings.Contains(query, "TABLE_TYPE='VIEW'") &&
			strings.Contains(query, "archive") {
			targetLookupFound = true
			break
		}
	}
	if !targetLookupFound {
		t.Fatalf("target view lookup did not run against archive: %#v", database.queryQueries)
	}
}

func TestCopyViewPostgresCopiesAcrossDatabaseAndSchema(t *testing.T) {
	database := &fakeCopyTableDB{
		queryFunc: func(query string) ([]map[string]interface{}, error) {
			switch {
			case strings.Contains(query, "information_schema.views"):
				return []map[string]interface{}{}, nil
			case strings.Contains(query, "pg_get_viewdef"):
				return []map[string]interface{}{{
					"ddl": " SELECT id, total FROM orders;",
				}}, nil
			default:
				return nil, nil
			}
		},
	}
	app := installCopyTableTestDatabase(t, database)

	result := app.CopyView(
		connection.ConnectionConfig{Type: "postgres", Database: "shop"},
		"shop",
		"public",
		"orders_view",
		"archive",
		"reporting",
	)

	if !result.Success {
		t.Fatalf("CopyView returned failure: %s", result.Message)
	}
	if got := database.execQueries[0]; !strings.Contains(
		got,
		`CREATE VIEW "reporting"."orders_view_copy1" AS`,
	) {
		t.Fatalf("copy SQL = %q", got)
	}
}

func TestCopyViewRejectsCrossDatabaseForFlatDatabaseSources(t *testing.T) {
	app := installCopyTableTestDatabase(t, &fakeCopyTableDB{})

	result := app.CopyView(
		connection.ConnectionConfig{Type: "sqlite"},
		"main",
		"",
		"active_users",
		"other",
		"",
	)

	if result.Success {
		t.Fatal("CopyView unexpectedly allowed a cross-database SQLite copy")
	}
}

func TestRewriteCreateViewTargetSupportsQuotedAndBracketNames(t *testing.T) {
	tests := []struct {
		name      string
		ddl       string
		targetRef string
		want      string
	}{
		{
			name:      "mysql",
			ddl:       "CREATE ALGORITHM=UNDEFINED VIEW `db`.`v1` AS SELECT 1",
			targetRef: "`db`.`v1_copy1`",
			want:      "CREATE ALGORITHM=UNDEFINED VIEW `db`.`v1_copy1` AS SELECT 1",
		},
		{
			name:      "postgres",
			ddl:       `CREATE OR REPLACE VIEW "public"."v1" AS SELECT 1`,
			targetRef: `"public"."v1_copy1"`,
			want:      `CREATE OR REPLACE VIEW "public"."v1_copy1" AS SELECT 1`,
		},
		{
			name:      "sqlserver",
			ddl:       "CREATE VIEW [dbo].[v1] AS SELECT 1",
			targetRef: "[dbo].[v1_copy1]",
			want:      "CREATE VIEW [dbo].[v1_copy1] AS SELECT 1",
		},
		{
			name:      "oracle force",
			ddl:       `CREATE OR REPLACE FORCE VIEW "APP"."V1" AS SELECT 1 FROM DUAL`,
			targetRef: `"APP"."V1_COPY1"`,
			want:      `CREATE OR REPLACE FORCE VIEW "APP"."V1_COPY1" AS SELECT 1 FROM DUAL`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := rewriteCreateViewTarget(test.ddl, test.targetRef)
			if !ok {
				t.Fatal("rewriteCreateViewTarget rejected a supported CREATE VIEW")
			}
			if got != test.want {
				t.Fatalf("rewritten SQL = %q, want %q", got, test.want)
			}
		})
	}
}
