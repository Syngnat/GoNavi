package app

import (
	"strings"
	"testing"
)

func TestManagedImportErrorArtifactPublishesOnlyNonEmptyArtifacts(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()

	empty, err := app.beginManagedImportErrorArtifact("import-empty")
	if err != nil {
		t.Fatal(err)
	}
	emptyResult := importExecutionResult{}
	if err := empty.finish(&emptyResult); err != nil {
		t.Fatal(err)
	}
	if emptyResult.ErrorArtifactID != "" {
		t.Fatalf("empty artifact was published: %#v", emptyResult)
	}

	failed, err := app.beginManagedImportErrorArtifact("import-failed")
	if err != nil {
		t.Fatal(err)
	}
	failed.append(ImportRowError{SourceRow: 2, Category: "database", Message: "duplicate key"})
	failedResult := importExecutionResult{Failed: 1}
	if err := failed.finish(&failedResult); err != nil {
		t.Fatal(err)
	}
	if failedResult.ErrorArtifactID == "" || failedResult.ErrorArtifactCount != 1 {
		t.Fatalf("rejected row artifact missing: %#v", failedResult)
	}
	if failedResult.ErrorArtifactBytes <= 0 || failedResult.ErrorArtifactOmittedCount != 0 ||
		failedResult.ErrorArtifactTruncated || failedResult.ErrorArtifactRetryableCount != 0 ||
		failedResult.ErrorArtifactUnretryableCount != 1 || !failedResult.ErrorArtifactScopeKnown {
		t.Fatalf("rejected artifact scope missing: %#v", failedResult)
	}
}

func TestManagedImportErrorArtifactPublishesTruncationWithoutRetainedRows(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	artifact, err := app.beginManagedImportErrorArtifact("import-truncated")
	if err != nil {
		t.Fatal(err)
	}
	if err := artifact.append(ImportRowError{
		Category: "database",
		Values:   map[string]interface{}{"value": strings.Repeat("x", int(maxImportErrorArtifactBytes))},
	}); err != nil {
		t.Fatal(err)
	}
	result := importExecutionResult{Failed: 1}
	if err := artifact.finish(&result); err != nil {
		t.Fatal(err)
	}
	if result.ErrorArtifactID == "" || result.ErrorArtifactCount != 0 ||
		!result.ErrorArtifactTruncated || result.ErrorArtifactOmittedCount != 1 ||
		!result.ErrorArtifactScopeKnown {
		t.Fatalf("truncated artifact metadata was not published: %#v", result)
	}
}
