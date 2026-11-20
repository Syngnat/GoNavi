package scriptlib

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"GoNavi-Wails/internal/appdata"
)

const (
	storeDirName       = "scripts"
	storeFileName      = "library.json"
	storeFormatVersion = 1
)

var (
	ErrNotFound  = errors.New("script library item not found")
	ErrConflict  = errors.New("script library revision conflict")
	ErrForbidden = errors.New("script library operation is not allowed")
	ErrInvalid   = errors.New("script library input is invalid")
)

type diskDocument struct {
	Version int      `json:"version"`
	Scripts []Script `json:"scripts"`
	Folders []Folder `json:"folders"`
}

// Store is safe for concurrent use by goroutines and processes.
type Store struct {
	configDir string
	mu        sync.Mutex
}

func NewStore(configDir string) *Store {
	return &Store{configDir: strings.TrimSpace(configDir)}
}

func (s *Store) path() string {
	root := s.configDir
	if root == "" {
		root = resolveConfigDir()
	}
	return filepath.Join(root, storeDirName, storeFileName)
}

func (s *Store) lockPath() string {
	return s.path() + ".lock"
}

func resolveConfigDir() string {
	root, err := appdata.ResolveActiveRoot()
	if err != nil || strings.TrimSpace(root) == "" {
		return "."
	}
	return root
}

func (s *Store) load() (diskDocument, error) {
	path := s.path()
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return emptyDocument(), nil
		}
		return diskDocument{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return diskDocument{}, fmt.Errorf("script library path must not be a symbolic link")
	}
	if !info.Mode().IsRegular() {
		return diskDocument{}, fmt.Errorf("script library path is not a regular file")
	}
	if info.Size() > MaxDiskBytes {
		return diskDocument{}, fmt.Errorf("script library exceeds %d bytes", MaxDiskBytes)
	}
	file, err := os.Open(path)
	if err != nil {
		return diskDocument{}, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return diskDocument{}, err
	}
	if !openedInfo.Mode().IsRegular() || openedInfo.Size() > MaxDiskBytes {
		return diskDocument{}, fmt.Errorf("script library path changed while it was being opened")
	}
	payload, err := io.ReadAll(io.LimitReader(file, MaxDiskBytes+1))
	if err != nil {
		return diskDocument{}, err
	}
	if len(payload) > MaxDiskBytes {
		return diskDocument{}, fmt.Errorf("script library exceeds %d bytes", MaxDiskBytes)
	}
	var doc diskDocument
	if err := json.Unmarshal(payload, &doc); err != nil {
		return diskDocument{}, fmt.Errorf("decode script library: %w", err)
	}
	if doc.Version == 0 {
		doc.Version = storeFormatVersion
	}
	if doc.Version != storeFormatVersion {
		return diskDocument{}, fmt.Errorf("unsupported script library version %d", doc.Version)
	}
	if err := normalizeDocument(&doc); err != nil {
		return diskDocument{}, err
	}
	return doc, nil
}

func emptyDocument() diskDocument {
	return diskDocument{
		Version: storeFormatVersion,
		Scripts: []Script{},
		Folders: []Folder{},
	}
}

func (s *Store) withWriteLock(ctx context.Context, operation func() error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ensureStoreDir(filepath.Dir(s.path())); err != nil {
		return err
	}
	lock, err := appdata.AcquireFileLockContext(ctx, s.lockPath())
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	if operation == nil {
		return nil
	}
	return operation()
}

func (s *Store) save(doc diskDocument) error {
	if err := normalizeDocument(&doc); err != nil {
		return err
	}
	doc.Version = storeFormatVersion
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if len(payload) > MaxDiskBytes {
		return fmt.Errorf("%w: script library exceeds %d bytes", ErrInvalid, MaxDiskBytes)
	}
	return writeAtomic(s.path(), payload)
}

// Snapshot returns only the entries visible to actor.
func (s *Store) Snapshot(actor Actor) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := s.load()
	if err != nil {
		return Snapshot{}, err
	}
	view := Snapshot{
		Owner:      displayOwner(actor.Owner),
		Scripts:    make([]Script, 0, len(doc.Scripts)),
		Folders:    make([]Folder, 0, len(doc.Folders)),
		CanWrite:   !actor.ReadOnly,
		CanShare:   !actor.ReadOnly,
		SharedOnly: actor.ReadOnly,
		ReadOnly:   actor.ReadOnly,
	}
	for _, script := range doc.Scripts {
		if !canReadScript(script, actor) {
			continue
		}
		view.Scripts = append(view.Scripts, visibleScript(script, actor))
	}
	for _, folder := range doc.Folders {
		if !canReadFolder(folder, actor) {
			continue
		}
		view.Folders = append(view.Folders, visibleFolder(folder, actor))
	}
	sortSnapshots(view.Scripts, view.Folders)
	return view, nil
}

// Get returns one visible script. Shared scripts are always sanitized.
func (s *Store) Get(actor Actor, id string) (Script, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.load()
	if err != nil {
		return Script{}, err
	}
	index := findScript(doc.Scripts, id)
	if index < 0 || !canReadScript(doc.Scripts[index], actor) {
		return Script{}, ErrNotFound
	}
	return visibleScript(doc.Scripts[index], actor), nil
}

func sortSnapshots(scripts []Script, folders []Folder) {
	sort.Slice(scripts, func(i, j int) bool {
		if scripts[i].Visibility != scripts[j].Visibility {
			return scripts[i].Visibility < scripts[j].Visibility
		}
		if scripts[i].FolderID != scripts[j].FolderID {
			return scripts[i].FolderID < scripts[j].FolderID
		}
		left := strings.ToLower(scripts[i].Name)
		right := strings.ToLower(scripts[j].Name)
		if left != right {
			return left < right
		}
		return scripts[i].ID < scripts[j].ID
	})
	sort.Slice(folders, func(i, j int) bool {
		if folders[i].Visibility != folders[j].Visibility {
			return folders[i].Visibility < folders[j].Visibility
		}
		left := strings.ToLower(folders[i].Name)
		right := strings.ToLower(folders[j].Name)
		if left != right {
			return left < right
		}
		return folders[i].ID < folders[j].ID
	})
}

func normalizeDocument(doc *diskDocument) error {
	if doc.Version == 0 {
		doc.Version = storeFormatVersion
	}
	if doc.Scripts == nil {
		doc.Scripts = []Script{}
	}
	if doc.Folders == nil {
		doc.Folders = []Folder{}
	}
	normalizeStoredScript(doc.Scripts)
	normalizeStoredFolder(doc.Folders)
	if err := validateStoredDocument(doc); err != nil {
		return err
	}
	repairFolderRelationships(doc.Folders)
	repairScriptFolders(doc.Scripts, doc.Folders)
	return nil
}

func repairFolderRelationships(folders []Folder) {
	byID := make(map[string]Folder, len(folders))
	for _, folder := range folders {
		byID[folder.ID] = folder
	}
	for index := range folders {
		parentID := strings.TrimSpace(folders[index].ParentID)
		if parentID == "" {
			continue
		}
		parent, exists := byID[parentID]
		if !exists || parent.Visibility != folders[index].Visibility {
			folders[index].ParentID = ""
		}
	}
}

func repairScriptFolders(scripts []Script, folders []Folder) {
	byID := make(map[string]Folder, len(folders))
	for _, folder := range folders {
		byID[folder.ID] = folder
	}
	for index := range scripts {
		folderID := strings.TrimSpace(scripts[index].FolderID)
		if folderID == "" {
			continue
		}
		folder, exists := byID[folderID]
		if !exists || folder.Visibility != scripts[index].Visibility {
			scripts[index].FolderID = ""
			continue
		}
		if scripts[index].Visibility == VisibilityPrivate &&
			normalizeOwner(folder.Owner) != normalizeOwner(scripts[index].Owner) {
			scripts[index].FolderID = ""
		}
	}
}

func writeAtomic(target string, payload []byte) error {
	if err := ensureStoreDir(filepath.Dir(target)); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".script-library-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temp.Write(payload); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := appdata.AtomicReplaceFile(tempPath, target); err != nil {
		return err
	}
	committed = true
	return nil
}

func ensureStoreDir(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	return os.Chmod(directory, 0o700)
}
