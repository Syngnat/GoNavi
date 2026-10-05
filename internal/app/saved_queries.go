package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
)

const (
	savedQueriesFileName      = "saved_queries.json"
	savedQueriesFormatVersion = 4
)

const (
	savedQueryGroupTokenPrefix = "group:"
	savedQueryTokenPrefix      = "query:"
)

var savedQueriesMu sync.Mutex

var writeSavedQueriesMetadataAtomic = writeSavedQueriesFileAtomic

type savedQueriesFile struct {
	Queries   []connection.SavedQuery
	Groups    []connection.SavedQueryGroup
	FileNames map[string]string
}

// savedQueryDiskRecord deliberately excludes SQL from the current on-disk
// format. LegacySQL is read only so older saved_queries.json files can be
// migrated without losing content.
type savedQueryDiskRecord struct {
	ID                    string                       `json:"id"`
	Name                  string                       `json:"name"`
	FileName              string                       `json:"fileName,omitempty"`
	LegacySQL             string                       `json:"sql,omitempty"`
	ConnectionID          string                       `json:"connectionId"`
	DBName                string                       `json:"dbName"`
	CreatedAt             int64                        `json:"createdAt"`
	ConnectionFingerprint string                       `json:"connectionFingerprint,omitempty"`
	FingerprintVersion    string                       `json:"fingerprintVersion,omitempty"`
	BindingStatus         string                       `json:"bindingStatus,omitempty"`
	OriginalConnectionID  string                       `json:"originalConnectionId,omitempty"`
	Parameters            []connection.SavedQueryParam `json:"parameters,omitempty"`
}

type savedQueriesDiskFile struct {
	Version int                          `json:"version,omitempty"`
	Queries []savedQueryDiskRecord       `json:"queries"`
	Groups  []connection.SavedQueryGroup `json:"groups,omitempty"`
}

type savedQueryRepository struct {
	configDir string
}

func newSavedQueryRepository(configDir string) *savedQueryRepository {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	return &savedQueryRepository{configDir: configDir}
}

func (r *savedQueryRepository) queriesPath() string {
	return filepath.Join(r.configDir, savedQueriesFileName)
}

func (r *savedQueryRepository) sqlDirectory() (string, error) {
	return appdata.ResolveSavedQueryDirectory(r.configDir)
}

func (r *savedQueryRepository) loadFile() (savedQueriesFile, error) {
	data, err := os.ReadFile(r.queriesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return emptySavedQueriesFile(), nil
		}
		return savedQueriesFile{}, err
	}

	var diskFile savedQueriesDiskFile
	if err := json.Unmarshal(data, &diskFile); err != nil {
		return savedQueriesFile{}, err
	}
	return r.hydrateDiskFile(diskFile)
}

func (r *savedQueryRepository) load() ([]connection.SavedQuery, error) {
	file, err := r.loadFile()
	if err != nil {
		return nil, err
	}
	return file.Queries, nil
}

func (r *savedQueryRepository) loadGroups() ([]connection.SavedQueryGroup, error) {
	file, err := r.loadFile()
	if err != nil {
		return nil, err
	}
	return file.Groups, nil
}

func (r *savedQueryRepository) findSQLPath(id string) (string, bool, error) {
	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return "", false, nil
	}
	payload, err := os.ReadFile(r.queriesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	var diskFile savedQueriesDiskFile
	if err := json.Unmarshal(payload, &diskFile); err != nil {
		return "", false, err
	}

	fileName := ""
	for _, record := range diskFile.Queries {
		if strings.TrimSpace(record.ID) != targetID {
			continue
		}
		fileName = strings.TrimSpace(record.FileName)
		if diskFile.Version < savedQueriesFormatVersion || fileName == "" || record.LegacySQL != "" {
			hydrated, err := r.hydrateDiskFile(diskFile)
			if err != nil {
				return "", false, err
			}
			fileName = hydrated.FileNames[targetID]
		}
		break
	}
	if fileName == "" {
		return "", false, nil
	}
	fileName, err = normalizeSavedQueryDiskFileName(fileName)
	if err != nil {
		return "", false, err
	}
	directory, err := r.sqlDirectory()
	if err != nil {
		return "", false, err
	}
	return filepath.Join(directory, fileName), true, nil
}
