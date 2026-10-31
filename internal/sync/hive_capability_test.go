package sync

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveStaticMutationFlagMeansCandidateNotEveryTable(t *testing.T) {
	for _, test := range []struct {
		name, family string
		candidate    bool
	}{
		{"default Apache Hive", "", true}, {"Apache Hive", "hive", true},
		{"Impala native table dependent", "impala", true}, {"Spark read append only", "spark", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := connection.ConnectionConfig{Type: "hive"}
			if test.family != "" {
				target.ConnectionParams = "hiveFamily=" + test.family
			}
			capability := ResolveMigrationCapability(connection.ConnectionConfig{Type: "hive"}, target)
			if !capability.CanExecute || !capability.SupportsAutoCreate || !capability.SupportsAutoAddColumns || capability.SupportsMutations != test.candidate {
				t.Fatalf("static capability = %+v", capability)
			}
		})
	}
	config := hiveTestConfig("insert_update")
	ordinary := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}, nil)
	if err := ValidateHiveSyncTargetContext(context.Background(), config, ordinary, "dst.events", true, TableOptions{Insert: true, Update: true}); err == nil {
		t.Fatal("candidate type flag incorrectly promised mutations on an ordinary table")
	}
	ordinary.capabilities.Update = true
	if err := ValidateHiveSyncTargetContext(context.Background(), config, ordinary, "dst.events", true, TableOptions{Insert: true, Update: true}); err != nil {
		t.Fatalf("verified ACID target rejected: %v", err)
	}
}
