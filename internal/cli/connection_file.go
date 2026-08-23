package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const maxConnectionFileBytes = 1 << 20

var cliGOOS = func() string {
	return stdRuntime.GOOS
}

// loadTemporaryConnectionConfig reads one complete ConnectionConfig without
// touching the saved-connection repository.  A connection-file is deliberately
// a raw ConnectionConfig so credentials never need to appear in argv.
func loadTemporaryConnectionConfig(path string) (connection.ConnectionConfig, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return connection.ConnectionConfig{}, errors.New("connection file path is required")
	}

	entry, err := os.Lstat(path)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	if entry.Mode()&os.ModeSymlink != 0 {
		return connection.ConnectionConfig{}, errors.New("connection file must not be a symbolic link")
	}
	if !entry.Mode().IsRegular() {
		return connection.ConnectionConfig{}, errors.New("connection file must be a regular file")
	}
	if entry.Size() > maxConnectionFileBytes {
		return connection.ConnectionConfig{}, fmt.Errorf("connection file exceeds %d bytes", maxConnectionFileBytes)
	}

	file, err := os.Open(path)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	if !os.SameFile(entry, opened) {
		return connection.ConnectionConfig{}, errors.New("connection file changed while opening")
	}
	if err := validateConnectionFilePermissions(file, opened.Mode()); err != nil {
		return connection.ConnectionConfig{}, err
	}

	decoder := json.NewDecoder(io.LimitReader(file, maxConnectionFileBytes+1))
	decoder.DisallowUnknownFields()
	var config connection.ConnectionConfig
	if err := decoder.Decode(&config); err != nil {
		return connection.ConnectionConfig{}, fmt.Errorf("decode connection file: %w", err)
	}
	if err := ensureOnlyOneJSONValue(decoder); err != nil {
		return connection.ConnectionConfig{}, err
	}
	if strings.TrimSpace(config.ID) != "" {
		return connection.ConnectionConfig{}, errors.New("connection file must not contain id")
	}
	if strings.TrimSpace(config.Type) == "" {
		return connection.ConnectionConfig{}, errors.New("connection file requires type")
	}

	// This config must remain entirely transient, even when it contains a
	// password.  An empty ID also keeps runtime secret resolution away from
	// connections.json and the daily-secret store.
	config.ID = ""
	config.SavePassword = false
	return config, nil
}

func ensureOnlyOneJSONValue(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode connection file: %w", err)
	}
	return errors.New("connection file must contain exactly one JSON object")
}
