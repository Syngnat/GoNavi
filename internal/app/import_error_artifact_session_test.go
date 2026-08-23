package app

import "testing"

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
}
