package sync

import (
	"GoNavi-Wails/internal/connection"
	"testing"
)

func TestResolveMigrationCapability_MySQLToPostgresUsesFullPlanner(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "mysql"},
		connection.ConnectionConfig{Type: "postgres"},
	)
	want := MigrationCapability{
		SourceType:             "mysql",
		TargetType:             "postgres",
		SourceModel:            MigrationDataModelRelational,
		TargetModel:            MigrationDataModelRelational,
		Planner:                "mysql-pglike-planner",
		SupportLevel:           MigrationSupportLevelFull,
		CanExecute:             true,
		SupportsAutoCreate:     true,
		SupportsAutoAddColumns: true,
		RequiresExistingTarget: false,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_PostgresToKingbaseUsesSameFamilyPlanner(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "postgres"},
		connection.ConnectionConfig{Type: "kingbase"},
	)
	want := MigrationCapability{
		SourceType:             "postgres",
		TargetType:             "kingbase",
		SourceModel:            MigrationDataModelRelational,
		TargetModel:            MigrationDataModelRelational,
		Planner:                "pglike-pglike-planner",
		SupportLevel:           MigrationSupportLevelFull,
		CanExecute:             true,
		SupportsAutoCreate:     true,
		SupportsAutoAddColumns: true,
		RequiresExistingTarget: false,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_OracleToSQLServerUsesExistingTargetCompatibilityMode(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "oracle"},
		connection.ConnectionConfig{Type: "sqlserver"},
	)
	want := MigrationCapability{
		SourceType:             "oracle",
		TargetType:             "sqlserver",
		SourceModel:            MigrationDataModelRelational,
		TargetModel:            MigrationDataModelRelational,
		Planner:                "generic-legacy-planner",
		SupportLevel:           MigrationSupportLevelPartial,
		CanExecute:             true,
		SupportsAutoCreate:     false,
		SupportsAutoAddColumns: false,
		RequiresExistingTarget: true,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_MongoToOracleReportsPlannedNonExecutablePath(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "mongodb"},
		connection.ConnectionConfig{Type: "oracle"},
	)
	want := MigrationCapability{
		SourceType:             "mongodb",
		TargetType:             "oracle",
		SourceModel:            MigrationDataModelDocument,
		TargetModel:            MigrationDataModelRelational,
		Planner:                "mongo-relational-inference-planner",
		SupportLevel:           MigrationSupportLevelPlanned,
		CanExecute:             false,
		SupportsAutoCreate:     false,
		SupportsAutoAddColumns: false,
		RequiresExistingTarget: true,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_RedisToMongoReportsFullKeyspaceBridge(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "redis"},
		connection.ConnectionConfig{Type: "mongodb"},
	)
	want := MigrationCapability{
		SourceType:             "redis",
		TargetType:             "mongodb",
		SourceModel:            MigrationDataModelKeyValue,
		TargetModel:            MigrationDataModelDocument,
		Planner:                "redis-mongo-keyspace-planner",
		SupportLevel:           MigrationSupportLevelFull,
		CanExecute:             true,
		SupportsAutoCreate:     true,
		SupportsAutoAddColumns: false,
		RequiresExistingTarget: false,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_MongoToRedisReportsFullKeyspaceBridge(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "mongodb"},
		connection.ConnectionConfig{Type: "redis"},
	)
	want := MigrationCapability{
		SourceType:             "mongodb",
		TargetType:             "redis",
		SourceModel:            MigrationDataModelDocument,
		TargetModel:            MigrationDataModelKeyValue,
		Planner:                "mongo-redis-keyspace-planner",
		SupportLevel:           MigrationSupportLevelFull,
		CanExecute:             true,
		SupportsAutoCreate:     true,
		SupportsAutoAddColumns: false,
		RequiresExistingTarget: false,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_CustomPostgresUsesResolvedDriverFamily(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "custom", Driver: "pgx"},
		connection.ConnectionConfig{Type: "kingbase"},
	)
	want := MigrationCapability{
		SourceType:             "postgres",
		TargetType:             "kingbase",
		SourceModel:            MigrationDataModelRelational,
		TargetModel:            MigrationDataModelRelational,
		Planner:                "pglike-pglike-planner",
		SupportLevel:           MigrationSupportLevelFull,
		CanExecute:             true,
		SupportsAutoCreate:     true,
		SupportsAutoAddColumns: true,
		RequiresExistingTarget: false,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_KafkaToQdrantIsUnsupported(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "kafka"},
		connection.ConnectionConfig{Type: "qdrant"},
	)
	want := MigrationCapability{
		SourceType:             "kafka",
		TargetType:             "qdrant",
		SourceModel:            MigrationDataModelCustom,
		TargetModel:            MigrationDataModelCustom,
		Planner:                "",
		SupportLevel:           MigrationSupportLevelUnsupported,
		CanExecute:             false,
		SupportsAutoCreate:     false,
		SupportsAutoAddColumns: false,
		RequiresExistingTarget: true,
		SupportsMutations:      true,
	}

	if got != want {
		t.Fatalf("unexpected capability: got %+v want %+v", got, want)
	}
}

func TestResolveMigrationCapability_RedisToNonMongoTargetIsUnsupported(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "redis"},
		connection.ConnectionConfig{Type: "postgres"},
	)

	if got.SupportLevel != MigrationSupportLevelUnsupported || got.CanExecute {
		t.Fatalf("expected Redis to non-Mongo target to be blocked, got %+v", got)
	}
}

func TestResolveMigrationCapability_TimeSeriesTargetsAreAppendOnly(t *testing.T) {
	for _, targetType := range []string{"tdengine", "iotdb"} {
		t.Run(targetType, func(t *testing.T) {
			capability := ResolveMigrationCapability(
				connection.ConnectionConfig{Type: "mysql"},
				connection.ConnectionConfig{Type: targetType},
			)
			if !capability.CanExecute || capability.SupportsMutations {
				t.Fatalf("expected %s target to be executable and append-only, got %+v", targetType, capability)
			}
		})
	}
}

func TestResolveMigrationCapability_GoldenDBUsesMySQLPlannerFamily(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "goldendb"},
		connection.ConnectionConfig{Type: "postgres"},
	)

	if got.SourceType != "mysql" || got.Planner != "mysql-pglike-planner" || !got.CanExecute {
		t.Fatalf("expected GoldenDB to use the MySQL migration family, got %+v", got)
	}
}

func TestResolveMigrationCapability_UsesDirectionalEndpointContract(t *testing.T) {
	tests := []struct {
		name   string
		source connection.ConnectionConfig
		target connection.ConnectionConfig
		level  MigrationSupportLevel
		canRun bool
	}{
		{
			name:   "Trino can be a compatibility source",
			source: connection.ConnectionConfig{Type: "trino"},
			target: connection.ConnectionConfig{Type: "mysql"},
			level:  MigrationSupportLevelPartial,
			canRun: true,
		},
		{
			name:   "Trino is not a writable target",
			source: connection.ConnectionConfig{Type: "mysql"},
			target: connection.ConnectionConfig{Type: "trino"},
			level:  MigrationSupportLevelUnsupported,
		},
		{
			name:   "Sphinx is not a writable target",
			source: connection.ConnectionConfig{Type: "mysql"},
			target: connection.ConnectionConfig{Type: "sphinx"},
			level:  MigrationSupportLevelUnsupported,
		},
		{
			name:   "Elasticsearch is not a table migration source",
			source: connection.ConnectionConfig{Type: "elasticsearch"},
			target: connection.ConnectionConfig{Type: "mysql"},
			level:  MigrationSupportLevelUnsupported,
		},
		{
			name:   "Nacos is not a database target",
			source: connection.ConnectionConfig{Type: "mysql"},
			target: connection.ConnectionConfig{Type: "nacos"},
			level:  MigrationSupportLevelUnsupported,
		},
		{
			name:   "unknown custom SQL driver stays in compatibility mode",
			source: connection.ConnectionConfig{Type: "custom", Driver: "acme-sql"},
			target: connection.ConnectionConfig{Type: "mysql"},
			level:  MigrationSupportLevelPartial,
			canRun: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveMigrationCapability(tt.source, tt.target)
			if got.SupportLevel != tt.level || got.CanExecute != tt.canRun {
				t.Fatalf("unexpected capability: got %+v, want level=%s canRun=%v", got, tt.level, tt.canRun)
			}
		})
	}
}

func TestResolveMigrationCapability_OceanBaseOracleUsesExistingTargetCompatibility(t *testing.T) {
	tests := []struct {
		name   string
		source connection.ConnectionConfig
		target connection.ConnectionConfig
	}{
		{
			name: "Oracle tenant as source",
			source: connection.ConnectionConfig{
				Type:              "oceanbase",
				OceanBaseProtocol: "oracle",
			},
			target: connection.ConnectionConfig{Type: "postgres"},
		},
		{
			name:   "Oracle tenant as target",
			source: connection.ConnectionConfig{Type: "mysql"},
			target: connection.ConnectionConfig{
				Type:             "oceanbase",
				ConnectionParams: "protocol=oracle",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveMigrationCapability(tt.source, tt.target)
			if got.Planner != "oceanbase-oracle-existing-target" ||
				got.SupportLevel != MigrationSupportLevelPartial ||
				!got.CanExecute || got.SupportsAutoCreate || !got.RequiresExistingTarget {
				t.Fatalf("unexpected OceanBase Oracle capability: %+v", got)
			}
		})
	}
}

func TestResolveMigrationCapability_OceanBaseOracleDoesNotBypassEndpointContract(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{
			Type:              "oceanbase",
			OceanBaseProtocol: "oracle",
		},
		connection.ConnectionConfig{Type: "qdrant"},
	)

	if got.SupportLevel != MigrationSupportLevelUnsupported || got.CanExecute {
		t.Fatalf("expected unsupported target to win over OceanBase compatibility mode, got %+v", got)
	}
}

func TestResolveMigrationCapability_PostgresToMySQLReportsPlannerAutoAddColumns(t *testing.T) {
	got := ResolveMigrationCapability(
		connection.ConnectionConfig{Type: "postgres"},
		connection.ConnectionConfig{Type: "mysql"},
	)

	if got.Planner != "pglike-mysql-planner" || !got.SupportsAutoAddColumns {
		t.Fatalf("expected the PostgreSQL to MySQL planner's auto-add support, got %+v", got)
	}
}
