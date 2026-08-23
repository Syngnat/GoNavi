package sync

import (
	"GoNavi-Wails/internal/connection"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCompileProjectionProjectsRenamesDefaultsAndStringTransforms(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{
		ID: "users-to-people",
		Columns: []SyncColumnMapping{
			{Source: "id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}}},
			{Source: "name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
			{
				Target:  "status",
				Default: &SyncDefaultValue{ValueType: "string", Value: "active"},
			},
			{
				Source:  "nickname",
				Target:  "nickname",
				Default: &SyncDefaultValue{When: []string{"null", "empty"}, ValueType: "string", Value: "unknown"},
			},
		},
	})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}

	input := map[string]interface{}{
		"id":       json.Number("9007199254740993"),
		"name":     "  alice  ",
		"nickname": "",
	}
	got, err := projection.Project(input)
	if err != nil {
		t.Fatalf("Project() error = %v", err)
	}
	want := map[string]interface{}{
		"user_id":      int64(9007199254740993),
		"display_name": "ALICE",
		"status":       "active",
		"nickname":     "unknown",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Project() = %#v, want %#v", got, want)
	}
	if input["name"] != "  alice  " {
		t.Fatalf("Project() mutated input row: %#v", input)
	}

	if target, ok := projection.TargetColumn("id"); !ok || target != "user_id" {
		t.Fatalf("TargetColumn(id) = %q, %v; want user_id, true", target, ok)
	}
}

func TestCompileProjectionIdentityClonesInput(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	input := map[string]interface{}{"id": int64(1), "name": "alice"}
	got, err := projection.Project(input)
	if err != nil {
		t.Fatalf("Project() error = %v", err)
	}
	if !reflect.DeepEqual(got, input) {
		t.Fatalf("identity Project() = %#v, want %#v", got, input)
	}
	got["name"] = "changed"
	if input["name"] != "alice" {
		t.Fatalf("identity Project() returned input map instead of a clone")
	}
}

func TestProjectionConversionsPreserveDecimalAndTypedValues(t *testing.T) {
	timestamp := time.Date(2026, time.August, 8, 9, 10, 11, 123000000, time.UTC)
	tests := []struct {
		name      string
		transform SyncValueTransform
		input     interface{}
		want      interface{}
	}{
		{name: "string", transform: SyncValueTransform{Type: "string"}, input: []byte("hello"), want: "hello"},
		{name: "int64", transform: SyncValueTransform{Type: "int64"}, input: "9223372036854775807", want: int64(9223372036854775807)},
		{name: "decimal-safe", transform: SyncValueTransform{Type: "decimal-safe"}, input: "12345678901234567890.123456789", want: json.Number("12345678901234567890.123456789")},
		{name: "bool", transform: SyncValueTransform{Type: "bool"}, input: "yes", want: true},
		{name: "date", transform: SyncValueTransform{Type: "date"}, input: "2026-08-08", want: time.Date(2026, time.August, 8, 0, 0, 0, 0, time.UTC)},
		{name: "timestamp", transform: SyncValueTransform{Type: "timestamp"}, input: "2026-08-08T09:10:11.123Z", want: timestamp},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projection, err := CompileProjection(SyncObjectMapping{
				Columns: []SyncColumnMapping{{Source: "value", Target: "value", Transforms: []SyncValueTransform{tt.transform}}},
			})
			if err != nil {
				t.Fatalf("CompileProjection() error = %v", err)
			}
			got, err := projection.Project(map[string]interface{}{"value": tt.input})
			if err != nil {
				t.Fatalf("Project() error = %v", err)
			}
			if !reflect.DeepEqual(got["value"], tt.want) {
				t.Fatalf("Project(value) = %#v (%T), want %#v (%T)", got["value"], got["value"], tt.want, tt.want)
			}
		})
	}
}

func TestProjectionJSONUsesNumberWithoutFloatPrecisionLoss(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{
		Columns: []SyncColumnMapping{{Source: "payload", Target: "payload", Transforms: []SyncValueTransform{{Type: "json"}}}},
	})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	got, err := projection.Project(map[string]interface{}{"payload": `{"id":9007199254740993}`})
	if err != nil {
		t.Fatalf("Project() error = %v", err)
	}
	payload, ok := got["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("payload type = %T, want map[string]interface{}", got["payload"])
	}
	if payload["id"] != json.Number("9007199254740993") {
		t.Fatalf("payload id = %#v (%T), want exact json.Number", payload["id"], payload["id"])
	}
}

func TestProjectionReturnsStructuredErrorWithoutRawValue(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{
		ID:      "users",
		Columns: []SyncColumnMapping{{Source: "age", Target: "age_years", Transforms: []SyncValueTransform{{Type: "int64"}}}},
	})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	_, err = projection.Project(map[string]interface{}{"age": "private-invalid-age"})
	if err == nil {
		t.Fatal("Project() expected an error")
	}
	var projectionErr *ProjectionError
	if !errors.As(err, &projectionErr) {
		t.Fatalf("Project() error type = %T, want *ProjectionError", err)
	}
	if projectionErr.MappingID != "users" || projectionErr.SourceColumn != "age" || projectionErr.TargetColumn != "age_years" || projectionErr.Transform != "int64" {
		t.Fatalf("unexpected ProjectionError: %#v", projectionErr)
	}
	if projectionErr.Kind != ProjectionErrorKindTransform {
		t.Fatalf("ProjectionError.Kind = %q, want %q", projectionErr.Kind, ProjectionErrorKindTransform)
	}
	if got := projectionErr.Error(); got == "" || containsFold(got, "private-invalid-age") {
		t.Fatalf("ProjectionError leaked raw value or returned empty message: %q", got)
	}
}

func TestCompileProjectionRejectsAmbiguousTargetsAndUnknownTransform(t *testing.T) {
	tests := []struct {
		name    string
		mapping SyncObjectMapping
	}{
		{
			name: "duplicate target",
			mapping: SyncObjectMapping{Columns: []SyncColumnMapping{
				{Source: "id", Target: "ID"},
				{Source: "legacy_id", Target: "id"},
			}},
		},
		{
			name: "unknown transform",
			mapping: SyncObjectMapping{Columns: []SyncColumnMapping{
				{Source: "id", Target: "id", Transforms: []SyncValueTransform{{Type: "eval"}}},
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := CompileProjection(tt.mapping); err == nil {
				t.Fatal("CompileProjection() expected an error")
			}
		})
	}
}

func TestProjectionMetadataValidationHonorsDefaultConditions(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{Columns: []SyncColumnMapping{{
		Source:  "nickname",
		Target:  "nickname",
		Default: &SyncDefaultValue{When: []string{"null"}, Value: "unknown"},
	}}})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	err = projection.ValidateSourceColumns([]connection.ColumnDefinition{{Name: "id"}})
	var projectionErr *ProjectionError
	if !errors.As(err, &projectionErr) || projectionErr.Kind != ProjectionErrorKindSourceMissing {
		t.Fatalf("ValidateSourceColumns() error = %#v, want structured source-missing error", err)
	}

	projection, err = CompileProjection(SyncObjectMapping{Columns: []SyncColumnMapping{{
		Source:  "nickname",
		Target:  "nickname",
		Default: &SyncDefaultValue{When: []string{"missing"}, Value: "unknown"},
	}}})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	if err := projection.ValidateSourceColumns([]connection.ColumnDefinition{{Name: "id"}}); err != nil {
		t.Fatalf("ValidateSourceColumns() rejected missing default: %v", err)
	}
}

func TestProjectionTargetColumnRejectsOneSourceMappedToMultipleTargets(t *testing.T) {
	projection, err := CompileProjection(SyncObjectMapping{Columns: []SyncColumnMapping{
		{Source: "id", Target: "primary_id"},
		{Source: "id", Target: "legacy_id"},
	}})
	if err != nil {
		t.Fatalf("CompileProjection() error = %v", err)
	}
	if target, ok := projection.TargetColumn("id"); ok || target != "" {
		t.Fatalf("TargetColumn(id) = %q, %v; want ambiguous mapping", target, ok)
	}
	row, err := projection.Project(map[string]interface{}{"id": int64(7)})
	if err != nil || row["primary_id"] != int64(7) || row["legacy_id"] != int64(7) {
		t.Fatalf("Project() = %#v, %v; source fan-out should remain valid for inserts", row, err)
	}
}

func containsFold(text, part string) bool {
	return strings.Contains(strings.ToLower(text), strings.ToLower(part))
}
