package scriptlib

import (
	"context"
	"fmt"
	"strings"
)

// SaveFolder creates or updates one script folder.
func (s *Store) SaveFolder(ctx context.Context, actor Actor, input SaveFolderInput) (Folder, error) {
	if actor.ReadOnly {
		return Folder{}, ErrForbidden
	}
	normalized, err := normalizeFolderInput(input)
	if err != nil {
		return Folder{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var result Folder
	err = s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		owner := normalizeOwner(actor.Owner)
		index := findFolder(doc.Folders, normalized.ID)
		if index < 0 {
			if normalized.ID != "" {
				return ErrNotFound
			}
			if normalized.Revision != 0 {
				return ErrConflict
			}
			if len(doc.Folders) >= MaxItems {
				return fmt.Errorf("%w: too many script folders", ErrInvalid)
			}
			if !canCreateVisibility(actor, normalized.Visibility) {
				return ErrForbidden
			}
			if err := validateFolderParent(doc, normalized.ParentID, "", owner, normalized.Visibility, actor); err != nil {
				return err
			}
			now := nowMillis()
			result = Folder{
				ID:         newID(),
				Name:       normalized.Name,
				ParentID:   normalized.ParentID,
				Owner:      owner,
				Visibility: normalized.Visibility,
				Revision:   1,
				CreatedAt:  now,
				UpdatedAt:  now,
			}
			doc.Folders = append(doc.Folders, result)
			return s.save(doc)
		}

		existing := doc.Folders[index]
		if existing.Revision != normalized.Revision {
			return ErrConflict
		}
		if !canEditFolder(existing, actor) {
			return ErrForbidden
		}
		if !canCreateVisibility(actor, normalized.Visibility) {
			return ErrForbidden
		}
		if normalized.Visibility != existing.Visibility {
			if err := ensureFolderVisibilityChangeSafe(doc, existing.ID, normalized.Visibility); err != nil {
				return err
			}
		}
		if err := validateFolderParent(
			doc,
			normalized.ParentID,
			existing.ID,
			existing.Owner,
			normalized.Visibility,
			actor,
		); err != nil {
			return err
		}
		result = existing
		result.Name = normalized.Name
		result.ParentID = normalized.ParentID
		result.Visibility = normalized.Visibility
		result.Revision++
		result.UpdatedAt = nowMillis()
		doc.Folders[index] = result
		return s.save(doc)
	})
	if err != nil {
		return Folder{}, err
	}
	return visibleFolder(result, actor), nil
}

// DeleteFolder removes an empty folder after checking ownership and revision.
func (s *Store) DeleteFolder(ctx context.Context, actor Actor, input DeleteInput) error {
	if actor.ReadOnly {
		return ErrForbidden
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		index := findFolder(doc.Folders, strings.TrimSpace(input.ID))
		if index < 0 {
			return ErrNotFound
		}
		existing := doc.Folders[index]
		if existing.Revision != input.Revision {
			return ErrConflict
		}
		if !canEditFolder(existing, actor) {
			return ErrForbidden
		}
		for _, script := range doc.Scripts {
			if script.FolderID == existing.ID {
				return fmt.Errorf("%w: folder is not empty", ErrInvalid)
			}
		}
		for _, folder := range doc.Folders {
			if folder.ParentID == existing.ID {
				return fmt.Errorf("%w: folder has subfolders", ErrInvalid)
			}
		}
		doc.Folders = append(doc.Folders[:index], doc.Folders[index+1:]...)
		return s.save(doc)
	})
}

// SetFolderVisibility shares or unshares a folder after checking for
// children that would violate the private/shared folder boundary.
func (s *Store) SetFolderVisibility(ctx context.Context, actor Actor, input ShareInput) (Folder, error) {
	if actor.ReadOnly {
		return Folder{}, ErrForbidden
	}
	visibility, err := normalizeVisibility(input.Visibility)
	if err != nil {
		return Folder{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var result Folder
	err = s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		index := findFolder(doc.Folders, strings.TrimSpace(input.ID))
		if index < 0 {
			return ErrNotFound
		}
		existing := doc.Folders[index]
		if existing.Revision != input.Revision {
			return ErrConflict
		}
		if !canEditFolder(existing, actor) {
			return ErrForbidden
		}
		if !canCreateVisibility(actor, visibility) {
			return ErrForbidden
		}
		if existing.Visibility == visibility {
			result = existing
			return nil
		}
		if err := ensureFolderVisibilityChangeSafe(doc, existing.ID, visibility); err != nil {
			return err
		}
		if err := validateFolderParent(
			doc,
			existing.ParentID,
			existing.ID,
			existing.Owner,
			visibility,
			actor,
		); err != nil {
			return err
		}
		existing.Visibility = visibility
		existing.Revision++
		existing.UpdatedAt = nowMillis()
		doc.Folders[index] = existing
		result = existing
		return s.save(doc)
	})
	if err != nil {
		return Folder{}, err
	}
	return visibleFolder(result, actor), nil
}

func validateFolderParent(
	doc diskDocument,
	parentID string,
	selfID string,
	owner string,
	visibility Visibility,
	actor Actor,
) error {
	parentID = strings.TrimSpace(parentID)
	if parentID == "" {
		return nil
	}
	if parentID == selfID {
		return fmt.Errorf("%w: folder cannot contain itself", ErrInvalid)
	}
	index := findFolder(doc.Folders, parentID)
	if index < 0 {
		return fmt.Errorf("%w: parent folder not found", ErrInvalid)
	}
	parent := doc.Folders[index]
	if !canReadFolder(parent, actor) {
		return ErrForbidden
	}
	if parent.Visibility != visibility {
		return fmt.Errorf("%w: parent folder visibility must match", ErrInvalid)
	}
	if visibility == VisibilityPrivate && normalizeOwner(parent.Owner) != normalizeOwner(owner) {
		return ErrForbidden
	}
	seen := map[string]struct{}{selfID: {}}
	for parentID != "" {
		if _, exists := seen[parentID]; exists {
			return fmt.Errorf("%w: folder cycle", ErrInvalid)
		}
		seen[parentID] = struct{}{}
		parentIndex := findFolder(doc.Folders, parentID)
		if parentIndex < 0 {
			break
		}
		parentID = doc.Folders[parentIndex].ParentID
	}
	return nil
}

func ensureFolderVisibilityChangeSafe(doc diskDocument, folderID string, visibility Visibility) error {
	for _, script := range doc.Scripts {
		if script.FolderID == folderID && script.Visibility != visibility {
			return fmt.Errorf("%w: folder contains scripts with a different visibility", ErrInvalid)
		}
	}
	for _, folder := range doc.Folders {
		if folder.ParentID == folderID {
			return fmt.Errorf("%w: folder contains subfolders", ErrInvalid)
		}
	}
	return nil
}

// validateScriptFolder enforces the private/shared folder boundary before a
// script is saved.
func validateScriptFolder(doc diskDocument, folderID string, visibility Visibility, actor Actor) error {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return nil
	}
	index := findFolder(doc.Folders, folderID)
	if index < 0 {
		return fmt.Errorf("%w: folder not found", ErrInvalid)
	}
	folder := doc.Folders[index]
	if folder.Visibility != visibility {
		return fmt.Errorf("%w: script and folder visibility must match", ErrInvalid)
	}
	if visibility == VisibilityPrivate {
		if !canEditFolder(folder, actor) || normalizeOwner(folder.Owner) != normalizeOwner(actor.Owner) {
			return ErrForbidden
		}
	}
	return nil
}

func detachFolderIfIncompatible(folderID string, visibility Visibility, doc diskDocument, actor Actor) string {
	if strings.TrimSpace(folderID) == "" {
		return ""
	}
	if validateScriptFolder(doc, folderID, visibility, actor) == nil {
		return folderID
	}
	return ""
}
