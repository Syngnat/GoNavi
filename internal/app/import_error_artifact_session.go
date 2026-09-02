package app

import (
	"fmt"
	"strings"
)

type managedImportErrorArtifact struct {
	writer *importErrorArtifactWriter
	err    error
}

func (a *App) beginManagedImportErrorArtifact(jobID string) (*managedImportErrorArtifact, error) {
	store, err := a.ensureImportErrorArtifactStore()
	if err != nil {
		return nil, err
	}
	writer, err := store.Begin(strings.TrimSpace(jobID))
	if err != nil {
		return nil, err
	}
	return &managedImportErrorArtifact{writer: writer}, nil
}

func (artifact *managedImportErrorArtifact) append(row ImportRowError) error {
	if artifact == nil || artifact.writer == nil || artifact.err != nil {
		if artifact == nil || artifact.err == nil {
			return nil
		}
		return artifact.err
	}
	artifact.err = artifact.writer.Append(row)
	return artifact.err
}

func (artifact *managedImportErrorArtifact) finish(result *importExecutionResult) error {
	if artifact == nil || artifact.writer == nil {
		return nil
	}
	if artifact.err != nil {
		artifact.writer.Abort()
		return fmt.Errorf("persist rejected import row: %w", artifact.err)
	}
	if artifact.writer.count == 0 && !artifact.writer.truncated {
		artifact.writer.Abort()
		return nil
	}
	finished, err := artifact.writer.Finish()
	if err != nil {
		return err
	}
	if result != nil {
		result.ErrorArtifactID = finished.ID
		result.ErrorArtifactCount = finished.Count
		result.ErrorArtifactBytes = finished.Bytes
		result.ErrorArtifactOmittedCount = finished.OmittedCount
		result.ErrorArtifactTruncated = finished.Truncated
		result.ErrorArtifactRetryableCount = finished.RetryableCount
		result.ErrorArtifactUnretryableCount = finished.UnretryableCount
		result.ErrorArtifactScopeKnown = true
		result.ErrorArtifactMaxRows = finished.MaxRows
		result.ErrorArtifactMaxBytes = finished.MaxBytes
	}
	return nil
}

func (artifact *managedImportErrorArtifact) abort() {
	if artifact != nil && artifact.writer != nil {
		artifact.writer.Abort()
	}
}
