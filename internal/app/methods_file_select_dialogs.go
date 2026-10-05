package app

import (
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// sshKeyFileDialogFilters intentionally returns nil. The macOS Wails adapter
// treats filters as filename extensions, which excludes extensionless OpenSSH
// keys such as ~/.ssh/id_ed25519. A nil filter list means all files.
func sshKeyFileDialogFilters() []runtime.FileFilter {
	return nil
}

func (a *App) SelectSSHKeyFile(currentPath string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = filepath.Join(home, ".ssh")
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	// OpenSSH private keys are commonly extensionless (id_ed25519, id_ecdsa,
	// custom names). Wails/macOS interprets filters as filename extensions, so
	// even an "all files" glob can hide extensionless keys. Omitting filters
	// lets the native dialog accept every file while still showing ~/.ssh items.
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_ssh_key_file", nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  true,
		Filters:          sshKeyFileDialogFilters(),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

// SelectSSHKnownHostsFile opens a local file dialog for a known_hosts file.
// It deliberately only selects an existing user-managed file: SSH host keys
// are never fetched, accepted, or written automatically by this application.
func (a *App) SelectSSHKnownHostsFile(currentPath string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = filepath.Join(home, ".ssh")
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_ssh_known_hosts_file", nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  true,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*.*",
			},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectCertificateFile(currentPath string, certKind string) connection.QueryResult {
	fallbackDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallbackDir = home
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallbackDir)

	kind := strings.ToLower(strings.TrimSpace(certKind))
	titleKey := "file.backend.dialog.select_tls_certificate_file"
	displayNameKey := "file.backend.filter.certificate_files"
	// Certificate material usually has extensions. Client private keys are often
	// extensionless, so that dialog intentionally omits filters below.
	filterPattern := "*.pem;*.crt;*.cer;*.cert;*.key"
	var filters []runtime.FileFilter
	switch kind {
	case "ca":
		titleKey = "file.backend.dialog.select_ca_server_certificate_file"
	case "client-cert":
		titleKey = "file.backend.dialog.select_client_certificate_file"
	case "client-key":
		titleKey = "file.backend.dialog.select_client_private_key_file"
		displayNameKey = "file.backend.filter.private_key_files"
	}
	if kind != "client-key" {
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText(displayNameKey, nil),
				Pattern:     filterPattern,
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*.*",
			},
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText(titleKey, nil),
		DefaultDirectory: defaultDir,
		ShowHiddenFiles:  kind == "client-key",
		Filters:          filters,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectDatabaseFile(currentPath string, driverType string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	normalizedType := strings.ToLower(strings.TrimSpace(driverType))
	filters := []runtime.FileFilter{
		{
			DisplayName: a.appText("file.backend.filter.database_files", nil),
			Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3;*.duckdb;*.ddb",
		},
		{
			DisplayName: a.appText("file.backend.filter.all_files", nil),
			Pattern:     "*",
		},
	}
	titleKey := "file.backend.dialog.select_database_file"
	switch normalizedType {
	case "sqlite":
		titleKey = "file.backend.dialog.select_sqlite_file"
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sqlite_files", nil),
				Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		}
	case "duckdb":
		titleKey = "file.backend.dialog.select_duckdb_file"
		filters = []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.duckdb_files", nil),
				Pattern:     "*.duckdb;*.ddb;*.db",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText(titleKey, nil),
		DefaultDirectory: defaultDir,
		Filters:          filters,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}
