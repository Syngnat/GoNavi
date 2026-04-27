package sync

import (
	"GoNavi-Wails/internal/connection"
	"strings"
	"testing"
)

func TestClassifyMigrationDataModel(t *testing.T) {
	t.Parallel()

	cases := map[string]MigrationDataModel{
		"mysql":      MigrationDataModelRelational,
		"postgres":   MigrationDataModelRelational,
		"kingbase":   MigrationDataModelRelational,
		"mongodb":    MigrationDataModelDocument,
		"clickhouse": MigrationDataModelColumnar,
		"tdengine":   MigrationDataModelTimeSeries,
		"redis":      MigrationDataModelKeyValue,
		"custom":     MigrationDataModelCustom,
	}

	for input, want := range cases {
		input, want := input, want
		t.Run(input, func(t *testing.T) {
			t.Parallel()
			got := classifyMigrationDataModel(input)
			if got != want {
				t.Fatalf("unexpected data model, input=%s got=%s want=%s", input, got, want)
			}
		})
	}
}

func TestResolveMigrationPlanner_PrefersMySQLKingbasePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "kingbase"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesSchemaInferencePlannerForMongoToMySQL(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mongodb"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "mongo-mysql-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestInferSchemaForPair_MongoToMySQLReturnsPlannedWarning(t *testing.T) {
	t.Parallel()

	result, err := inferSchemaForPair("mongodb", "mysql", "users")
	if err != nil {
		t.Fatalf("inferSchemaForPair returned error: %v", err)
	}
	if !result.NeedsReview {
		t.Fatalf("expected needs review")
	}
	if result.Object.Name != "users" {
		t.Fatalf("unexpected object name: %s", result.Object.Name)
	}
	if len(result.Issues) == 0 || !strings.Contains(result.Issues[0].Message, "schema 推断") {
		t.Fatalf("unexpected issues: %+v", result.Issues)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeMySQLPlannerForKingbaseToMySQL(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "kingbase"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "pglike-mysql-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesMySQLPGLikePlannerForMySQLToPostgres(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesPGLikePGLikePlannerForPostgresToPostgres(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "postgres"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "pglike-pglike-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesMySQLClickHousePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "clickhouse"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "mysql-clickhouse-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesClickHouseMySQLPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "clickhouse"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil {
		t.Fatalf("expected planner")
	}
	if planner.Name() != "clickhouse-mysql-planner" {
		t.Fatalf("unexpected planner: %s", planner.Name())
	}
}

func TestResolveMigrationPlanner_UsesMySQLMongoPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "mongodb"},
		},
	})
	if planner == nil || planner.Name() != "mysql-mongo-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMongoMySQLPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mongodb"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil || planner.Name() != "mongo-mysql-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMongoPGLikePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mongodb"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil || planner.Name() != "mongo-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeMongoPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "postgres"},
			TargetConfig: connection.ConnectionConfig{Type: "mongodb"},
		},
	})
	if planner == nil || planner.Name() != "pglike-mongo-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesClickHouseMongoPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "clickhouse"},
			TargetConfig: connection.ConnectionConfig{Type: "mongodb"},
		},
	})
	if planner == nil || planner.Name() != "clickhouse-mongo-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesTDengineMongoPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "tdengine"},
			TargetConfig: connection.ConnectionConfig{Type: "mongodb"},
		},
	})
	if planner == nil || planner.Name() != "tdengine-mongo-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMySQLPGLikePlannerForDirosToPostgres(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "diros"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil || planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeMySQLPlannerForPostgresToDiros(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "postgres"},
			TargetConfig: connection.ConnectionConfig{Type: "diros"},
		},
	})
	if planner == nil || planner.Name() != "pglike-mysql-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMySQLPGLikePlannerForMySQLToDuckDB(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "duckdb"},
		},
	})
	if planner == nil || planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeClickHousePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "postgres"},
			TargetConfig: connection.ConnectionConfig{Type: "clickhouse"},
		},
	})
	if planner == nil || planner.Name() != "pglike-clickhouse-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeMySQLPlannerForDuckDBToMySQL(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "duckdb"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil || planner.Name() != "pglike-mysql-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMySQLPGLikePlannerForSphinxToPostgres(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "sphinx"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil || planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeMySQLPlannerForCustomKingbaseToMySQL(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "custom", Driver: "kingbase8"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil || planner.Name() != "pglike-mysql-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMySQLPGLikePlannerForMySQLToCustomPostgres(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "custom", Driver: "postgresql"},
		},
	})
	if planner == nil || planner.Name() != "mysql-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesTDengineMySQLPlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "tdengine"},
			TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		},
	})
	if planner == nil || planner.Name() != "tdengine-mysql-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesTDenginePGLikePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "tdengine"},
			TargetConfig: connection.ConnectionConfig{Type: "kingbase"},
		},
	})
	if planner == nil || planner.Name() != "tdengine-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesMySQLLikeTDenginePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "mysql"},
			TargetConfig: connection.ConnectionConfig{Type: "tdengine"},
		},
	})
	if planner == nil || planner.Name() != "mysqllike-tdengine-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesPGLikeTDenginePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "postgres"},
			TargetConfig: connection.ConnectionConfig{Type: "tdengine"},
		},
	})
	if planner == nil || planner.Name() != "pglike-tdengine-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesClickHouseTDenginePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "clickhouse"},
			TargetConfig: connection.ConnectionConfig{Type: "tdengine"},
		},
	})
	if planner == nil || planner.Name() != "clickhouse-tdengine-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesClickHousePGLikePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "clickhouse"},
			TargetConfig: connection.ConnectionConfig{Type: "postgres"},
		},
	})
	if planner == nil || planner.Name() != "clickhouse-pglike-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}

func TestResolveMigrationPlanner_UsesTDengineTDenginePlanner(t *testing.T) {
	t.Parallel()

	planner := resolveMigrationPlanner(MigrationBuildContext{
		Config: SyncConfig{
			SourceConfig: connection.ConnectionConfig{Type: "tdengine"},
			TargetConfig: connection.ConnectionConfig{Type: "tdengine"},
		},
	})
	if planner == nil || planner.Name() != "tdengine-tdengine-planner" {
		t.Fatalf("unexpected planner: %v", planner)
	}
}
