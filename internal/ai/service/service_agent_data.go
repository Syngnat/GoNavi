package aiservice

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type AgentDataDirectoryInfo struct {
	Directory        string                        `json:"directory"`
	DefaultDirectory string                        `json:"defaultDirectory"`
	Source           string                        `json:"source"`
	RestartRequired  bool                          `json:"restartRequired"`
	Stats            runharness.LedgerStorageStats `json:"stats"`
}

type AgentDataMaintenanceResult struct {
	Info        AgentDataDirectoryInfo             `json:"info"`
	Maintenance runharness.LedgerMaintenanceResult `json:"maintenance"`
}

// AIGetAgentDataDirectoryInfo returns paths and aggregate counts only. It does
// not open a missing ledger or expose encrypted assistant content.
func (s *Service) AIGetAgentDataDirectoryInfo() (AgentDataDirectoryInfo, error) {
	if s == nil {
		return AgentDataDirectoryInfo{}, errors.New("AI Service is nil")
	}
	return s.agentDataDirectoryInfo(s.agentLifecycleContext())
}

func (s *Service) agentDataDirectoryInfo(ctx context.Context) (AgentDataDirectoryInfo, error) {
	root := strings.TrimSpace(s.configDir)
	if root == "" {
		root = resolveConfigDir()
	}
	directory, err := appdata.ResolveAgentDataDirectory(root)
	if err != nil {
		return AgentDataDirectoryInfo{}, err
	}
	defaultDirectory := appdata.DefaultAgentDataDirectory(root)
	configured, err := appdata.ResolveConfiguredAgentDataDirectory()
	if err != nil {
		return AgentDataDirectoryInfo{}, err
	}
	info := AgentDataDirectoryInfo{
		Directory: directory, DefaultDirectory: defaultDirectory, Source: "default",
	}
	if configured != "" {
		info.Source = "custom"
	}

	s.agentMu.RLock()
	ledger := s.agentLedger
	initialized := s.agentHarnessInitialized && s.agentHarnessInitialization == nil
	s.agentMu.RUnlock()
	if ledger != nil && sameCleanPath(ledger.Path(), filepath.Join(directory, agentLedgerFileName)) {
		info.Stats, err = ledger.StorageStats(ctx)
		return info, err
	}
	info.RestartRequired = initialized && ledger != nil
	info.Stats, err = inspectClosedAgentLedger(filepath.Join(directory, agentLedgerFileName))
	return info, err
}

func (s *Service) AISelectAgentDataDirectory(current string) (string, error) {
	if s == nil || s.ctx == nil {
		return "", errors.New("agent data directory selection is only available in the desktop app")
	}
	current = strings.TrimSpace(current)
	if current == "" {
		info, err := s.AIGetAgentDataDirectoryInfo()
		if err != nil {
			return "", err
		}
		current = info.Directory
	}
	selection, err := runtime.OpenDirectoryDialog(s.ctx, runtime.OpenDialogOptions{
		Title:                s.serviceText("ai_service.agent_data.dialog.select_directory", nil),
		DefaultDirectory:     current,
		CanCreateDirectories: true,
	})
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(selection) == "" {
		return "", nil
	}
	abs, err := filepath.Abs(selection)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// AIApplyAgentDataDirectory changes where future desktop and CLI Agent
// ledgers live. Migration creates a consistent compact copy and switches the
// bootstrap setting only after the copy is fully installed. The source is
// retained as a rollback copy.
func (s *Service) AIApplyAgentDataDirectory(directory string, migrate bool) (AgentDataDirectoryInfo, error) {
	if s == nil {
		return AgentDataDirectoryInfo{}, errors.New("AI Service is nil")
	}
	s.agentDataMaintenanceMu.Lock()
	defer s.agentDataMaintenanceMu.Unlock()

	root := strings.TrimSpace(s.configDir)
	if root == "" {
		root = resolveConfigDir()
	}
	current, err := appdata.ResolveAgentDataDirectory(root)
	if err != nil {
		return AgentDataDirectoryInfo{}, err
	}
	target, err := filepath.Abs(strings.TrimSpace(directory))
	if err != nil || strings.TrimSpace(directory) == "" {
		if err == nil {
			err = errors.New("agent data directory is empty")
		}
		return AgentDataDirectoryInfo{}, err
	}
	target = filepath.Clean(target)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return AgentDataDirectoryInfo{}, err
	}
	migrated := !sameCleanPath(current, target) && migrate
	if migrated {
		if err := s.migrateAgentDataDirectory(s.agentLifecycleContext(), current, target); err != nil {
			return AgentDataDirectoryInfo{}, err
		}
	}

	configuredTarget := target
	if sameCleanPath(target, appdata.DefaultAgentDataDirectory(root)) {
		configuredTarget = ""
	}
	if _, err := appdata.SetConfiguredAgentDataDirectory(configuredTarget); err != nil {
		if migrated {
			_ = os.Remove(filepath.Join(target, agentLedgerFileName))
			_ = os.Remove(filepath.Join(target, agentLedgerKeyFileName))
		}
		return AgentDataDirectoryInfo{}, err
	}
	info, err := s.agentDataDirectoryInfo(s.agentLifecycleContext())
	if err != nil {
		return AgentDataDirectoryInfo{}, err
	}
	s.agentMu.RLock()
	activeLedger := s.agentLedger
	s.agentMu.RUnlock()
	info.RestartRequired = activeLedger != nil && !sameCleanPath(activeLedger.Path(), filepath.Join(info.Directory, agentLedgerFileName))
	return info, nil
}

func (s *Service) AIOpenAgentDataDirectory() error {
	info, err := s.AIGetAgentDataDirectoryInfo()
	if err != nil {
		return err
	}
	if stat, statErr := os.Stat(info.Directory); statErr != nil || !stat.IsDir() {
		return errors.New("agent data directory is unavailable")
	}
	var command *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		command = exec.Command("open", info.Directory)
	case "windows":
		command = exec.Command("explorer", info.Directory)
	case "linux":
		command = exec.Command("xdg-open", info.Directory)
	default:
		return fmt.Errorf("opening agent data directory is unsupported on %s", stdRuntime.GOOS)
	}
	return command.Start()
}

func (s *Service) AIOptimizeAgentData() (AgentDataMaintenanceResult, error) {
	return s.maintainAgentData(false)
}

func (s *Service) AIClearAgentData() (AgentDataMaintenanceResult, error) {
	return s.maintainAgentData(true)
}

func (s *Service) maintainAgentData(clear bool) (AgentDataMaintenanceResult, error) {
	if s == nil {
		return AgentDataMaintenanceResult{}, errors.New("AI Service is nil")
	}
	s.agentDataMaintenanceMu.Lock()
	defer s.agentDataMaintenanceMu.Unlock()
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return AgentDataMaintenanceResult{}, err
	}
	_ = harness
	s.agentMu.RLock()
	ledger := s.agentLedger
	s.agentMu.RUnlock()
	if ledger == nil {
		return AgentDataMaintenanceResult{}, errors.New("agent ledger is unavailable")
	}
	var maintenance runharness.LedgerMaintenanceResult
	if clear {
		maintenance, err = ledger.ClearStorage(ctx)
	} else {
		maintenance, err = ledger.OptimizeStorage(ctx)
	}
	if err != nil {
		return AgentDataMaintenanceResult{}, err
	}
	info, err := s.agentDataDirectoryInfo(ctx)
	if err != nil {
		return AgentDataMaintenanceResult{}, err
	}
	return AgentDataMaintenanceResult{Info: info, Maintenance: maintenance}, nil
}

func (s *Service) migrateAgentDataDirectory(ctx context.Context, source, target string) error {
	stage, err := os.MkdirTemp(target, ".gonavi-agent-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.Chmod(stage, 0o700); err != nil {
		return err
	}

	sourceLedger := filepath.Join(source, agentLedgerFileName)
	stageLedger := filepath.Join(stage, agentLedgerFileName)
	if _, err := os.Stat(sourceLedger); err == nil {
		s.agentMu.RLock()
		liveLedger := s.agentLedger
		s.agentMu.RUnlock()
		if liveLedger != nil && sameCleanPath(liveLedger.Path(), sourceLedger) {
			stats, statsErr := liveLedger.StorageStats(ctx)
			if statsErr != nil {
				return statsErr
			}
			if stats.ActiveRunCount > 0 {
				return fmt.Errorf("migrating agent data requires all runs to finish; %d run(s) are active", stats.ActiveRunCount)
			}
			err = liveLedger.BackupTo(ctx, stageLedger)
		} else {
			keyPath := filepath.Join(source, agentLedgerKeyFileName)
			temporaryLedger, openErr := runharness.Open(sourceLedger, runharness.WithKeyFile(keyPath))
			if openErr != nil {
				return openErr
			}
			stats, statsErr := temporaryLedger.StorageStats(ctx)
			if statsErr != nil {
				err = statsErr
			} else if stats.ActiveRunCount > 0 {
				err = fmt.Errorf("migrating agent data requires all runs to finish; %d run(s) are active", stats.ActiveRunCount)
			} else {
				err = temporaryLedger.BackupTo(ctx, stageLedger)
			}
			err = errors.Join(err, temporaryLedger.Close())
		}
		if err != nil {
			return fmt.Errorf("copy agent ledger: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	for _, name := range []string{agentLedgerKeyFileName} {
		sourcePath := filepath.Join(source, name)
		info, statErr := os.Stat(sourcePath)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return statErr
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("agent data source %s is not a regular file", sourcePath)
		}
		if err := copyAgentDataFile(sourcePath, filepath.Join(stage, name), info.Mode()); err != nil {
			return err
		}
	}

	return installStagedAgentData(stage, target)
}

func installStagedAgentData(stage, target string) (result error) {
	names := []string{agentLedgerFileName, agentLedgerKeyFileName}
	installed := make([]string, 0, len(names))
	rollback := func(cause error) error {
		var rollbackErr error
		for _, name := range installed {
			rollbackErr = errors.Join(rollbackErr, os.Remove(filepath.Join(target, name)))
		}
		return errors.Join(cause, rollbackErr)
	}
	for _, name := range names {
		targetPath := filepath.Join(target, name)
		if _, err := os.Lstat(targetPath); err == nil {
			return fmt.Errorf("target agent data already exists: %s", targetPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, name := range names {
		stagePath := filepath.Join(stage, name)
		if _, err := os.Lstat(stagePath); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return rollback(err)
		}
		if err := os.Rename(stagePath, filepath.Join(target, name)); err != nil {
			return rollback(err)
		}
		installed = append(installed, name)
	}
	return nil
}

func copyAgentDataFile(source, target string, mode os.FileMode) (result error) {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, input.Close()) }()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm())
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, output.Close()) }()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	return output.Sync()
}

func inspectClosedAgentLedger(path string) (runharness.LedgerStorageStats, error) {
	stats := runharness.LedgerStorageStats{FileBytes: fileSize(path), WALBytes: fileSize(path + "-wal")}
	if stats.FileBytes == 0 {
		return stats, nil
	}
	uri := &url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := uri.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(1000)")
	uri.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return stats, err
	}
	defer database.Close()
	var pageSize, pageCount, freePages int64
	for _, item := range []struct {
		query string
		value *int64
	}{
		{`PRAGMA page_size`, &pageSize}, {`PRAGMA page_count`, &pageCount}, {`PRAGMA freelist_count`, &freePages},
		{`SELECT COUNT(*) FROM sessions`, &stats.SessionCount}, {`SELECT COUNT(*) FROM runs`, &stats.RunCount},
		{`SELECT COUNT(*) FROM workspace_snapshots`, &stats.SnapshotCount},
		{`SELECT COUNT(*) FROM runs WHERE state NOT IN ('completed','failed','canceled','exhausted')`, &stats.ActiveRunCount},
	} {
		if err := database.QueryRow(item.query).Scan(item.value); err != nil {
			return stats, err
		}
	}
	stats.AllocatedBytes = pageSize * pageCount
	stats.FreeBytes = pageSize * freePages
	return stats, nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.Size()
}

func sameCleanPath(left, right string) bool {
	leftAbs, leftErr := filepath.Abs(strings.TrimSpace(left))
	rightAbs, rightErr := filepath.Abs(strings.TrimSpace(right))
	if leftErr != nil || rightErr != nil {
		return false
	}
	if stdRuntime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(leftAbs), filepath.Clean(rightAbs))
	}
	return filepath.Clean(leftAbs) == filepath.Clean(rightAbs)
}
