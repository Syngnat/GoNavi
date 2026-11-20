package scriptlib

import (
	"context"
	"fmt"
	"strings"
)

// SaveScript creates or updates one script with an optimistic revision check.
func (s *Store) SaveScript(ctx context.Context, actor Actor, input SaveScriptInput) (Script, error) {
	if actor.ReadOnly {
		return Script{}, ErrForbidden
	}
	normalized, err := normalizeScriptInput(input)
	if err != nil {
		return Script{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var result Script
	err = s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		owner := normalizeOwner(actor.Owner)
		index := findScript(doc.Scripts, normalized.ID)
		if index < 0 {
			if normalized.ID != "" {
				return ErrNotFound
			}
			if normalized.Revision != 0 {
				return ErrConflict
			}
			if len(doc.Scripts) >= MaxItems {
				return fmt.Errorf("%w: too many scripts", ErrInvalid)
			}
			if !canCreateVisibility(actor, normalized.Visibility) {
				return ErrForbidden
			}
			if err := validateScriptFolder(doc, normalized.FolderID, normalized.Visibility, actor); err != nil {
				return err
			}
			result = scriptFromInput(normalized, owner, normalized.FolderID)
			doc.Scripts = append(doc.Scripts, result)
			return s.save(doc)
		}

		existing := doc.Scripts[index]
		if existing.Revision != normalized.Revision {
			return ErrConflict
		}
		if !canEditScript(existing, actor) {
			return ErrForbidden
		}
		if !canCreateVisibility(actor, normalized.Visibility) {
			return ErrForbidden
		}
		if err := validateScriptFolder(doc, normalized.FolderID, normalized.Visibility, actor); err != nil {
			return err
		}
		result = scriptFromInput(normalized, existing.Owner, normalized.FolderID)
		result.ID = existing.ID
		result.Revision = existing.Revision + 1
		result.CreatedAt = existing.CreatedAt
		doc.Scripts[index] = result
		return s.save(doc)
	})
	if err != nil {
		return Script{}, err
	}
	return visibleScript(result, actor), nil
}

func scriptFromInput(input SaveScriptInput, owner string, folderID string) Script {
	now := nowMillis()
	connections := cloneConnections(input.Connections)
	inputs := cloneInputs(input.Inputs)
	if input.Visibility == VisibilityShared {
		connections = sanitizeConnections(connections)
		inputs = sanitizeInputs(inputs)
	}
	return Script{
		ID:          newID(),
		Name:        input.Name,
		Description: input.Description,
		Code:        input.Code,
		Owner:       normalizeOwner(owner),
		Visibility:  input.Visibility,
		FolderID:    strings.TrimSpace(folderID),
		Connections: connections,
		Inputs:      inputs,
		AllowWrite:  input.AllowWrite,
		BatchSize:   input.BatchSize,
		INListLimit: input.INListLimit,
		RunLimits:   input.RunLimits,
		Revision:    1,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

// DeleteScript removes a script after checking ownership and revision.
func (s *Store) DeleteScript(ctx context.Context, actor Actor, input DeleteInput) error {
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
		index := findScript(doc.Scripts, strings.TrimSpace(input.ID))
		if index < 0 {
			return ErrNotFound
		}
		existing := doc.Scripts[index]
		if existing.Revision != input.Revision {
			return ErrConflict
		}
		if !canEditScript(existing, actor) {
			return ErrForbidden
		}
		doc.Scripts = append(doc.Scripts[:index], doc.Scripts[index+1:]...)
		return s.save(doc)
	})
}

// SetScriptVisibility shares or unshares a script. Sharing strips connection
// IDs and file locations before they are persisted.
func (s *Store) SetScriptVisibility(ctx context.Context, actor Actor, input ShareInput) (Script, error) {
	if actor.ReadOnly {
		return Script{}, ErrForbidden
	}
	visibility, err := normalizeVisibility(input.Visibility)
	if err != nil {
		return Script{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var result Script
	err = s.withWriteLock(ctx, func() error {
		doc, err := s.load()
		if err != nil {
			return err
		}
		index := findScript(doc.Scripts, strings.TrimSpace(input.ID))
		if index < 0 {
			return ErrNotFound
		}
		existing := doc.Scripts[index]
		if existing.Revision != input.Revision {
			return ErrConflict
		}
		if !canEditScript(existing, actor) {
			return ErrForbidden
		}
		if !canCreateVisibility(actor, visibility) {
			return ErrForbidden
		}
		if existing.Visibility == visibility {
			result = visibleScript(existing, actor)
			return nil
		}
		existing.FolderID = detachFolderIfIncompatible(existing.FolderID, visibility, doc, actor)
		existing.Visibility = visibility
		existing.Revision++
		existing.UpdatedAt = nowMillis()
		if visibility == VisibilityShared {
			existing.Connections = sanitizeConnections(existing.Connections)
			existing.Inputs = sanitizeInputs(existing.Inputs)
		}
		doc.Scripts[index] = existing
		result = existing
		return s.save(doc)
	})
	if err != nil {
		return Script{}, err
	}
	return visibleScript(result, actor), nil
}
