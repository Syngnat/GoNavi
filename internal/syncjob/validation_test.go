package syncjob

import (
	"strings"
	"testing"
	"time"
)

func validValidationTestDefinition() JobDefinition {
	return JobDefinition{
		Name:            "orders sync",
		Lifecycle:       JobLifecycleReady,
		Kind:            JobKindReconcile,
		IncrementalMode: IncrementalSnapshot,
		Source:          EndpointRef{ConnectionID: "source"},
		Target:          EndpointRef{ConnectionID: "target"},
		Mappings: []TableMapping{{
			SourceTable: "orders",
			TargetTable: "orders_archive",
			Enabled:     true,
		}},
	}
}

func TestValidateDefinitionRejectsUnsupportedPerMappingTargetStrategy(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Mappings[0].TargetTableStrategy = "drop_and_replace"
	err := ValidateDefinition(definition)
	if err == nil || !strings.Contains(err.Error(), "targetTableStrategy") {
		t.Fatalf("ValidateDefinition error = %v, want targetTableStrategy error", err)
	}
}

func TestNormalizeDefinitionPreservesDisabledMapping(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Mappings[0].Enabled = false
	normalized := NormalizeDefinition(definition)
	if normalized.Mappings[0].Enabled {
		t.Fatal("normalization must not re-enable an explicitly disabled mapping")
	}
}

func TestValidateDefinitionIgnoresIncompleteDisabledMapping(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Mappings = append(definition.Mappings, TableMapping{Enabled: false})

	if err := ValidateDefinition(definition); err != nil {
		t.Fatalf("disabled draft mapping was rejected: %v", err)
	}
}

func TestValidateDefinitionAllowsQuerySinkWithoutSyntheticSourceTable(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Kind = JobKindQuerySink
	definition.SourceQuery = "SELECT id, total FROM orders WHERE exported = false"
	definition.Mappings[0].SourceTable = ""
	if err := ValidateDefinition(definition); err != nil {
		t.Fatalf("query sink definition was rejected: %v", err)
	}
}

func TestValidateDefinitionRejectsIncrementalCompare(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Kind = JobKindCompare
	definition.IncrementalMode = IncrementalWatermark
	definition.Mappings[0].Watermark = &WatermarkSpec{Column: "updated_at", TieBreakerColumns: []string{"id"}}
	err := ValidateDefinition(definition)
	if err == nil || !strings.Contains(err.Error(), "only support snapshot") {
		t.Fatalf("ValidateDefinition error = %v, want compare snapshot-only error", err)
	}
}

func TestContinuousCDCJobsAreScheduledAndForbidOverlap(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.Lifecycle = JobLifecycleEnabled
	definition.IncrementalMode = IncrementalCDC
	definition.CDC = &CDCSpec{Adapter: "mongodb-change-stream", StartPosition: "checkpoint"}
	definition.Mappings[0].KeyColumns = []string{"id"}
	definition.Schedule = ScheduleSpec{Kind: ScheduleContinuous}
	definition.ConcurrencyPolicy = "forbid"

	if err := ValidateDefinition(definition); err != nil {
		t.Fatalf("continuous CDC definition was rejected: %v", err)
	}
	after := time.UnixMilli(1_700_000_000_000)
	if got, want := NextRunAt(definition, after), after.Add(continuousRunPoll).UnixMilli(); got != want {
		t.Fatalf("NextRunAt() = %d, want %d", got, want)
	}

	definition.ConcurrencyPolicy = "queue"
	err := ValidateDefinition(definition)
	if err == nil || !strings.Contains(err.Error(), "forbid concurrency") {
		t.Fatalf("ValidateDefinition error = %v, want continuous overlap error", err)
	}
}

func TestValidateDefinitionRejectsCDCWithoutStableKeys(t *testing.T) {
	definition := validValidationTestDefinition()
	definition.IncrementalMode = IncrementalCDC
	definition.CDC = &CDCSpec{Adapter: "mongodb-change-stream", StartPosition: "latest"}
	err := ValidateDefinition(definition)
	if err == nil || !strings.Contains(err.Error(), "stable keyColumns") {
		t.Fatalf("ValidateDefinition error = %v, want CDC key error", err)
	}
}
