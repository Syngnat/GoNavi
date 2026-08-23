package importjob

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound            = errors.New("import job not found")
	ErrRevisionConflict    = errors.New("import job revision conflict")
	ErrRecoveryUnavailable = errors.New("import job recovery is unavailable")
	errCorruptMetadata     = errors.New("import job metadata is corrupt")
	validJobIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

// CorruptJobFilesWarning reports that list/recovery skipped unreadable job
// metadata. It deliberately exposes only a count: persisted metadata may
// contain sensitive source or target details, and paths are machine-specific.
type CorruptJobFilesWarning struct {
	Count int
}

func (w *CorruptJobFilesWarning) Error() string {
	return fmt.Sprintf("skipped %d corrupt import job metadata file(s)", w.Count)
}

type Store struct {
	root string
	mu   sync.Mutex
}

func Open(root string) (*Store, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("import job directory is empty")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absRoot, 0o700); err != nil {
		return nil, err
	}
	return &Store{root: absRoot}, nil
}

func (s *Store) Put(job Job) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.putLocked(job)
}

func (s *Store) putLocked(job Job) (Job, error) {
	job.ID = strings.TrimSpace(job.ID)
	if !validJobIDPattern.MatchString(job.ID) {
		return Job{}, errors.New("invalid import job id")
	}
	if job.Kind != KindTable && job.Kind != KindSQL {
		return Job{}, fmt.Errorf("invalid import job kind %q", job.Kind)
	}
	path := s.jobPath(job.ID)
	now := time.Now().UnixMilli()
	existing, err := readJob(path)
	switch {
	case err == nil:
		if job.Revision != existing.Revision {
			return Job{}, ErrRevisionConflict
		}
		job.Revision++
		job.CreatedAt = existing.CreatedAt
	case errors.Is(err, os.ErrNotExist):
		if job.Revision != 0 {
			return Job{}, ErrNotFound
		}
		job.Revision = 1
		job.CreatedAt = now
	case err != nil:
		return Job{}, err
	}
	job.UpdatedAt = now
	if err := writeJobAtomic(path, job); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (s *Store) Get(id string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validJobIDPattern.MatchString(strings.TrimSpace(id)) {
		return Job{}, ErrNotFound
	}
	job, err := readJob(s.jobPath(strings.TrimSpace(id)))
	if errors.Is(err, os.ErrNotExist) {
		return Job{}, ErrNotFound
	}
	return job, err
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id = strings.TrimSpace(id)
	if !validJobIDPattern.MatchString(id) {
		return ErrNotFound
	}
	if err := os.Remove(s.jobPath(id)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (s *Store) List() ([]Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}

func (s *Store) listLocked() ([]Job, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	jobs := make([]Job, 0, len(entries))
	corruptCount := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		job, err := readJob(filepath.Join(s.root, entry.Name()))
		if err != nil {
			if errors.Is(err, errCorruptMetadata) {
				corruptCount++
				continue
			}
			return nil, err
		}
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool {
		if jobs[i].UpdatedAt == jobs[j].UpdatedAt {
			return jobs[i].ID < jobs[j].ID
		}
		return jobs[i].UpdatedAt > jobs[j].UpdatedAt
	})
	if corruptCount > 0 {
		return jobs, &CorruptJobFilesWarning{Count: corruptCount}
	}
	return jobs, nil
}

func (s *Store) RecoverInterrupted() ([]Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs, listErr := s.listLocked()
	if listErr != nil {
		var warning *CorruptJobFilesWarning
		if !errors.As(listErr, &warning) {
			return nil, listErr
		}
	}
	recovered := make([]Job, 0)
	for _, job := range jobs {
		if job.Status != StatusPreparing && job.Status != StatusRunning && job.Status != StatusStopping {
			continue
		}
		job.Status = StatusInterrupted
		job.Resumable = canResume(job)
		updated, err := s.putLocked(job)
		if err != nil {
			return nil, err
		}
		recovered = append(recovered, updated)
	}
	return recovered, listErr
}

// ClaimResume atomically validates and consumes an interrupted task's resume
// checkpoint. A second click cannot start another replay from the same
// checkpoint while the first recovery is being initialized.
func (s *Store) ClaimResume(id, sourceIdentityToken, targetFingerprint, optionsHash string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, err := s.getLocked(id)
	if err != nil {
		return Job{}, err
	}
	if !canResume(job) || ValidateResume(job, sourceIdentityToken, targetFingerprint, optionsHash) != nil {
		return Job{}, ErrRecoveryUnavailable
	}
	job.Resumable = false
	updated, err := s.putLocked(job)
	if err != nil {
		return Job{}, err
	}
	return updated, nil
}

// ReleaseResumeClaim restores an interrupted task's action when recovery
// setup failed before a replacement task was persisted.
func (s *Store) ReleaseResumeClaim(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, err := s.getLocked(id)
	if err != nil {
		return err
	}
	if job.Status != StatusInterrupted || job.Resumable {
		return nil
	}
	if !canResume(job) {
		return ErrRecoveryUnavailable
	}
	job.Resumable = true
	_, err = s.putLocked(job)
	return err
}

func (s *Store) getLocked(id string) (Job, error) {
	id = strings.TrimSpace(id)
	if !validJobIDPattern.MatchString(id) {
		return Job{}, ErrNotFound
	}
	job, err := readJob(s.jobPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return Job{}, ErrNotFound
	}
	return job, err
}

func canResume(job Job) bool {
	return job.Kind == KindTable && job.TableImportOptions != nil &&
		job.RecoveryAction != "retry_failed_rows" &&
		job.Checkpoint.Safe && !job.OutcomeUnknown &&
		strings.TrimSpace(job.SourcePath) != "" &&
		strings.TrimSpace(job.ConnectionID) != "" &&
		strings.TrimSpace(job.SourceIdentityToken) != "" &&
		strings.TrimSpace(job.TargetFingerprint) != "" &&
		strings.TrimSpace(job.OptionsHash) != ""
}

func (s *Store) jobPath(id string) string {
	return filepath.Join(s.root, id+".json")
}

func readJob(path string) (Job, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Job{}, err
	}
	var job Job
	if err := json.Unmarshal(data, &job); err != nil {
		return Job{}, fmt.Errorf("%w: %v", errCorruptMetadata, err)
	}
	return job, nil
}

func writeJobAtomic(path string, job Job) error {
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	tempPath := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+uuid.NewString()+".tmp")
	f, err := os.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(tempPath)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	ok = true
	return nil
}
