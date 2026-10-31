package pluginmarket

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"GoNavi-Wails/internal/logger"
)

type diskState struct {
	Sources  []SourceConfig             `json:"sources"`
	Version  int                        `json:"version"`
	BaseURL  string                     `json:"baseUrl"`
	Installs map[string]installedSource `json:"installs"`
}

type installedSource struct {
	SourceID        string `json:"sourceId"`
	Version         string `json:"version"`
	TransportSHA256 string `json:"transportSha256"`
	ContentDigest   string `json:"contentDigest"`
}

func readState(path string) (*diskState, error) {
	data, err := readBoundedFile(path, maxStateBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read marketplace settings: %w", err)
	}
	var state diskState
	if err = json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode marketplace settings: %w", err)
	}
	normalized, err := normalizeBase(state.BaseURL)
	if err != nil || state.Version != 1 || len(state.Installs) > 4096 {
		return nil, ErrInvalidResponse
	}
	state.BaseURL = normalized
	if state.Installs == nil {
		state.Installs = make(map[string]installedSource)
	}
	for id, record := range state.Installs {
		if !validID(id) || !digestPattern.MatchString(record.SourceID) || !validVersion(record.Version) || !digestPattern.MatchString(record.TransportSHA256) || (record.ContentDigest != "" && !digestPattern.MatchString(record.ContentDigest)) {
			return nil, ErrInvalidResponse
		}
	}
	return &state, nil
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return readBounded(file, limit)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrResponseTooLarge
	}
	return data, nil
}

func atomicJSON(path string, value any, limit int) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode marketplace state: %w", err)
	}
	if len(data) > limit {
		return ErrResponseTooLarge
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".market-state-*")
	if err != nil {
		return fmt.Errorf("create marketplace state: %w", err)
	}
	name := file.Name()
	defer removeTemporary(name)
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return fmt.Errorf("write marketplace state: %w", err)
	}
	if err = file.Sync(); err != nil {
		return fmt.Errorf("sync marketplace state: %w", err)
	}
	if err = file.Close(); err != nil {
		return fmt.Errorf("close marketplace state: %w", err)
	}
	if err = replaceFileAtomic(name, path); err != nil {
		return fmt.Errorf("replace marketplace state: %w", err)
	}
	return nil
}

func removeTemporary(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		logger.Warnf("marketplace temporary file cleanup failed")
	}
}
