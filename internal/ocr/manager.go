package ocr

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	currentDir     = "current"
	stagingPrefix  = "staging-"
	previousPrefix = "previous-"
	manifestName   = "component.json"

	// progressInterval keeps the event stream calm: a few updates a second are
	// plenty for a progress bar.
	progressInterval = 150 * time.Millisecond

	// PhaseDownloading and PhaseDone are the values of Progress.Phase.
	PhaseDownloading = "downloading"
	PhaseDone        = "done"
)

var (
	// ErrInstallInProgress is returned when an installation is already running.
	ErrInstallInProgress = errors.New("ocr: an installation is already running")
	// ErrNotInstalled is returned when the files are needed but not there.
	ErrNotInstalled = errors.New("ocr: the component is not installed")
)

// Status describes the component for the settings page and the first-use prompt.
type Status struct {
	Installed  bool
	Installing bool
	Version    string
	Languages  []string
	// SizeBytes is what the component takes on disk once installed; before that it
	// is what installing downloads (the same number, as the files are not unpacked).
	SizeBytes int64
	Path      string
}

// Progress reports an installation in flight.
type Progress struct {
	Phase      string
	File       string
	Downloaded int64
	Total      int64
}

type installedFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type installedManifest struct {
	Version     string          `json:"version"`
	Languages   []string        `json:"languages"`
	InstalledAt time.Time       `json:"installedAt"`
	Files       []installedFile `json:"files"`
}

// Manager installs, serves and removes the component under one root directory.
type Manager struct {
	root      string
	component Component
	client    *http.Client

	mu         sync.Mutex
	installing bool
	cancel     context.CancelFunc

	serverMu sync.Mutex
	server   *fileServer
}

// NewManager manages the component under root (created on first install). The
// client carries the application's proxy settings; nil means the default client.
func NewManager(root string, component Component, client *http.Client) *Manager {
	if client == nil {
		client = &http.Client{}
	}
	return &Manager{root: root, component: component, client: client}
}

func (m *Manager) currentPath() string { return filepath.Join(m.root, currentDir) }

// Status reports what is installed. A component of another version, or one with a
// missing or short file, counts as not installed: it has to be installed again.
func (m *Manager) Status() Status {
	m.mu.Lock()
	installing := m.installing
	m.mu.Unlock()
	return Status{
		Installed:  m.intact(),
		Installing: installing,
		Version:    m.component.Version,
		Languages:  append([]string(nil), m.component.Languages...),
		SizeBytes:  m.component.TotalSize(),
		Path:       m.currentPath(),
	}
}

func (m *Manager) intact() bool {
	raw, err := os.ReadFile(filepath.Join(m.currentPath(), manifestName))
	if err != nil {
		return false
	}
	var manifest installedManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Version != m.component.Version {
		return false
	}
	for _, file := range m.component.Files {
		info, statErr := os.Stat(filepath.Join(m.currentPath(), filepath.FromSlash(file.Path)))
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != file.Size {
			return false
		}
	}
	return true
}

// Install downloads and verifies every file into a staging directory and only then
// swaps it in, so an interrupted or failed installation leaves nothing half-done.
// Installing what is already installed does nothing. report may be nil.
func (m *Manager) Install(ctx context.Context, report func(Progress)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	m.mu.Lock()
	if m.installing {
		m.mu.Unlock()
		return ErrInstallInProgress
	}
	m.installing, m.cancel = true, cancel
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.installing, m.cancel = false, nil
		m.mu.Unlock()
	}()

	total := m.component.TotalSize()
	if report == nil {
		report = func(Progress) {}
	}
	if m.intact() {
		report(Progress{Phase: PhaseDone, Downloaded: total, Total: total})
		return nil
	}
	if err := os.MkdirAll(m.root, 0o700); err != nil {
		return fmt.Errorf("create component directory: %w", err)
	}
	m.removeLeftovers()
	staging := filepath.Join(m.root, stagingPrefix+randomSuffix())
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return fmt.Errorf("create staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }() // nothing left behind on failure

	if err := m.downloadAll(ctx, staging, total, report); err != nil {
		return err
	}
	if err := m.writeManifest(staging); err != nil {
		return err
	}
	m.closeServer() // an open file would stop the swap on Windows
	if err := m.swapIn(staging); err != nil {
		return err
	}
	report(Progress{Phase: PhaseDone, Downloaded: total, Total: total})
	return nil
}

func (m *Manager) downloadAll(ctx context.Context, staging string, total int64, report func(Progress)) error {
	var done int64
	var lastReport time.Time
	for _, file := range m.component.Files {
		before := done
		onBytes := func(delta int64) {
			done += delta
			if now := time.Now(); delta < 0 || now.Sub(lastReport) >= progressInterval {
				lastReport = now
				report(Progress{Phase: PhaseDownloading, File: file.Path, Downloaded: done, Total: total})
			}
		}
		if err := downloadFile(ctx, m.client, file, staging, onBytes); err != nil {
			return err
		}
		done = before + file.Size
		report(Progress{Phase: PhaseDownloading, File: file.Path, Downloaded: done, Total: total})
	}
	return nil
}

func (m *Manager) writeManifest(dir string) error {
	manifest := installedManifest{Version: m.component.Version, Languages: m.component.Languages, InstalledAt: time.Now().UTC()}
	for _, file := range m.component.Files {
		manifest.Files = append(manifest.Files, installedFile{Path: file.Path, Size: file.Size, SHA256: file.SHA256})
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode component manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, manifestName), raw, 0o600); err != nil {
		return fmt.Errorf("write component manifest: %w", err)
	}
	return nil
}

// swapIn makes the staging directory the installed one. The previous
// installation, if any, is moved aside first and put back if the swap fails.
func (m *Manager) swapIn(staging string) error {
	current := m.currentPath()
	var previous string
	if _, err := os.Stat(current); err == nil {
		previous = filepath.Join(m.root, previousPrefix+randomSuffix())
		if err := os.Rename(current, previous); err != nil {
			return fmt.Errorf("move the old component aside: %w", err)
		}
	}
	if err := os.Rename(staging, current); err != nil {
		if previous != "" {
			_ = os.Rename(previous, current)
		}
		return fmt.Errorf("activate the component: %w", err)
	}
	if previous != "" {
		_ = os.RemoveAll(previous)
	}
	return nil
}

// removeLeftovers clears what an interrupted installation or swap left behind.
func (m *Manager) removeLeftovers() {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() && (strings.HasPrefix(name, stagingPrefix) || strings.HasPrefix(name, previousPrefix)) {
			_ = os.RemoveAll(filepath.Join(m.root, name))
		}
	}
}

// CancelInstall stops a running installation; Install then returns the context error.
func (m *Manager) CancelInstall() {
	m.mu.Lock()
	cancel := m.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Remove deletes the installed component and anything an installation left behind.
// Only the component's own directories are touched, never the root itself.
func (m *Manager) Remove() error {
	m.mu.Lock()
	installing := m.installing
	m.mu.Unlock()
	if installing {
		return ErrInstallInProgress
	}
	m.closeServer()
	m.removeLeftovers()
	if err := os.RemoveAll(m.currentPath()); err != nil {
		return fmt.Errorf("remove the component: %w", err)
	}
	return nil
}

func randomSuffix() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
