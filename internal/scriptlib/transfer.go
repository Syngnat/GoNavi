package scriptlib

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const transferFormatVersion = 1

// TransferDocument is the portable, sanitized representation used by script
// library import and export. Connection IDs, local paths, and upload tokens
// are never included.
type TransferDocument struct {
	Version    int      `json:"version"`
	ExportedAt int64    `json:"exportedAt"`
	Scripts    []Script `json:"scripts"`
	Folders    []Folder `json:"folders"`
}

// Export returns every item visible to actor with sensitive bindings removed.
func (s *Store) Export(actor Actor) (TransferDocument, error) {
	snapshot, err := s.Snapshot(actor)
	if err != nil {
		return TransferDocument{}, err
	}
	scripts := make([]Script, 0, len(snapshot.Scripts))
	for _, script := range snapshot.Scripts {
		script.Connections = sanitizeConnections(script.Connections)
		script.Inputs = sanitizeInputs(script.Inputs)
		scripts = append(scripts, script)
	}
	folders := append([]Folder(nil), snapshot.Folders...)
	sortSnapshots(scripts, folders)
	return TransferDocument{
		Version:    transferFormatVersion,
		ExportedAt: nowMillis(),
		Scripts:    scripts,
		Folders:    folders,
	}, nil
}

func (s *Store) ExportJSON(actor Actor) ([]byte, error) {
	document, err := s.Export(actor)
	if err != nil {
		return nil, err
	}
	payload, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(payload, '\n'), nil
}

// ImportJSON decodes and imports a bounded transfer document.
func (s *Store) ImportJSON(ctx context.Context, actor Actor, payload []byte) (Snapshot, error) {
	if len(payload) == 0 {
		return Snapshot{}, fmt.Errorf("%w: import payload is empty", ErrInvalid)
	}
	if len(payload) > MaxDiskBytes {
		return Snapshot{}, fmt.Errorf("%w: import payload exceeds %d bytes", ErrInvalid, MaxDiskBytes)
	}
	var document TransferDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		return Snapshot{}, fmt.Errorf("%w: decode import payload: %v", ErrInvalid, err)
	}
	return s.Import(ctx, actor, document)
}

// Import appends a transfer document to the actor's library. IDs and revisions
// are regenerated so an import can never overwrite another user's scripts.
func (s *Store) Import(ctx context.Context, actor Actor, document TransferDocument) (Snapshot, error) {
	if actor.ReadOnly {
		return Snapshot{}, ErrForbidden
	}
	if document.Version != 0 && document.Version != transferFormatVersion {
		return Snapshot{}, fmt.Errorf("%w: unsupported import version %d", ErrInvalid, document.Version)
	}
	if len(document.Scripts)+len(document.Folders) > MaxItems {
		return Snapshot{}, fmt.Errorf("%w: too many import items", ErrInvalid)
	}
	s.mu.Lock()
	err := s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		folderMap, err := importFolders(&doc, actor, document.Folders)
		if err != nil {
			return err
		}
		if err := importScripts(&doc, actor, document.Scripts, folderMap); err != nil {
			return err
		}
		if len(doc.Scripts)+len(doc.Folders) > MaxItems {
			return fmt.Errorf("%w: script library would exceed %d items", ErrInvalid, MaxItems)
		}
		return s.save(doc)
	})
	s.mu.Unlock()
	if err != nil {
		return Snapshot{}, err
	}
	return s.Snapshot(actor)
}

func importFolders(doc *diskDocument, actor Actor, items []Folder) (map[string]string, error) {
	sourceByID := make(map[string]Folder, len(items))
	folderMap := make(map[string]string, len(items))
	normalizedByID := make(map[string]SaveFolderInput, len(items))
	for _, item := range items {
		sourceID := strings.TrimSpace(item.ID)
		if sourceID == "" {
			return nil, fmt.Errorf("%w: imported folder id is required", ErrInvalid)
		}
		if _, duplicate := sourceByID[sourceID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate folder id %q", ErrInvalid, sourceID)
		}
		sourceByID[sourceID] = item
		folderMap[sourceID] = uuid.NewString()
		normalized, err := normalizeFolderInput(SaveFolderInput{
			Name:       item.Name,
			Visibility: item.Visibility,
		})
		if err != nil {
			return nil, err
		}
		if !canCreateVisibility(actor, normalized.Visibility) {
			return nil, ErrForbidden
		}
		normalizedByID[sourceID] = normalized
	}
	state := make(map[string]uint8, len(sourceByID))
	ordered := make([]string, 0, len(sourceByID))
	var visit func(string) error
	visit = func(id string) error {
		switch state[id] {
		case 1:
			return fmt.Errorf("%w: imported folder cycle", ErrInvalid)
		case 2:
			return nil
		}
		state[id] = 1
		parentID := strings.TrimSpace(sourceByID[id].ParentID)
		if parentID != "" {
			if _, exists := sourceByID[parentID]; !exists {
				return fmt.Errorf("%w: imported parent folder not found", ErrInvalid)
			}
			if err := visit(parentID); err != nil {
				return err
			}
		}
		state[id] = 2
		ordered = append(ordered, id)
		return nil
	}
	for id := range sourceByID {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	now := nowMillis()
	for _, sourceID := range ordered {
		normalized := normalizedByID[sourceID]
		parentSourceID := strings.TrimSpace(sourceByID[sourceID].ParentID)
		parentID := ""
		if parentSourceID != "" {
			parentID = folderMap[parentSourceID]
			if parentID == "" {
				return nil, fmt.Errorf("%w: imported parent folder not found", ErrInvalid)
			}
			parentIndex := findFolder(doc.Folders, parentID)
			if parentIndex < 0 || doc.Folders[parentIndex].Visibility != normalized.Visibility {
				return nil, fmt.Errorf("%w: imported folder visibility must match its parent", ErrInvalid)
			}
		}
		doc.Folders = append(doc.Folders, Folder{
			ID:         folderMap[sourceID],
			Name:       normalized.Name,
			ParentID:   parentID,
			Owner:      normalizeOwner(actor.Owner),
			Visibility: normalized.Visibility,
			Revision:   1,
			CreatedAt:  now,
			UpdatedAt:  now,
		})
	}
	return folderMap, nil
}

func importScripts(doc *diskDocument, actor Actor, items []Script, folderMap map[string]string) error {
	now := nowMillis()
	for _, item := range items {
		normalized, err := normalizeScriptInput(SaveScriptInput{
			Name:        item.Name,
			Description: item.Description,
			Code:        item.Code,
			Visibility:  item.Visibility,
			FolderID:    folderMap[strings.TrimSpace(item.FolderID)],
			Connections: item.Connections,
			Inputs:      item.Inputs,
			AllowWrite:  item.AllowWrite,
			BatchSize:   item.BatchSize,
			INListLimit: item.INListLimit,
			RunLimits:   item.RunLimits,
		})
		if err != nil {
			return err
		}
		if !canCreateVisibility(actor, normalized.Visibility) {
			return ErrForbidden
		}
		folderID := normalized.FolderID
		if folderID != "" {
			index := findFolder(doc.Folders, folderID)
			if index < 0 || doc.Folders[index].Visibility != normalized.Visibility {
				folderID = ""
			}
		}
		connections := cloneConnections(normalized.Connections)
		inputs := cloneInputs(normalized.Inputs)
		// Imported documents are transport artifacts. They never carry an
		// authorization grant for local files or saved connections, even when
		// the imported script itself is private.
		connections = sanitizeConnections(connections)
		inputs = sanitizeInputs(inputs)
		doc.Scripts = append(doc.Scripts, Script{
			ID:          uuid.NewString(),
			Name:        normalized.Name,
			Description: normalized.Description,
			Code:        normalized.Code,
			Owner:       normalizeOwner(actor.Owner),
			Visibility:  normalized.Visibility,
			FolderID:    folderID,
			Connections: connections,
			Inputs:      inputs,
			AllowWrite:  normalized.AllowWrite,
			BatchSize:   normalized.BatchSize,
			INListLimit: normalized.INListLimit,
			RunLimits:   normalized.RunLimits,
			Revision:    1,
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	return nil
}

func newID() string {
	return uuid.NewString()
}
