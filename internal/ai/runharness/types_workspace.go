package runharness

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// WorkspaceSnapshot is a complete, source-owned view of UI/CLI context.
// Flexible maps preserve forward compatibility while the stable fields remain
// easy for adapters to populate.
type WorkspaceSourceKind string

const (
	WorkspaceDesktop WorkspaceSourceKind = "desktop"
	WorkspaceCLI     WorkspaceSourceKind = "cli"
)

type WorkspaceSnapshot struct {
	SchemaVersion          int                    `json:"schemaVersion"`
	SourceKind             WorkspaceSourceKind    `json:"sourceKind"`
	SourceID               string                 `json:"sourceId"`
	SourceInstanceID       string                 `json:"sourceInstanceId"`
	Revision               int64                  `json:"revision"`
	CapturedAt             time.Time              `json:"capturedAt" ts_type:"string"`
	ContentHash            string                 `json:"contentHash"`
	ActiveContext          map[string]any         `json:"activeContext,omitempty"`
	Tabs                   []WorkspaceTab         `json:"tabs,omitempty"`
	ActiveTabID            string                 `json:"activeTabId,omitempty"`
	SQLActivity            []WorkspaceSQLActivity `json:"sqlActivity,omitempty"`
	SavedQueries           []WorkspaceQuery       `json:"savedQueries,omitempty"`
	Snippets               []WorkspaceQuery       `json:"snippets,omitempty"`
	ExternalSQLDirectories []string               `json:"externalSqlDirectories,omitempty"`
	Shortcuts              map[string]string      `json:"shortcuts,omitempty"`
	TransactionState       map[string]any         `json:"transactionState,omitempty"`
	Diagnostics            map[string]any         `json:"diagnostics,omitempty"`
	CLIContext             *CLIWorkspaceContext   `json:"cliContext,omitempty"`
	Capabilities           map[string]bool        `json:"capabilities,omitempty"`
	Availability           map[string]string      `json:"availability,omitempty"`
}

type WorkspaceTab struct {
	ID           string `json:"id"`
	Title        string `json:"title,omitempty"`
	Kind         string `json:"kind,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Database     string `json:"database,omitempty"`
	Object       string `json:"object,omitempty"`
	Draft        string `json:"draft,omitempty"`
}

type WorkspaceSQLActivity struct {
	ID        string    `json:"id,omitempty"`
	Statement string    `json:"statement,omitempty"`
	Status    string    `json:"status,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty" ts_type:"string"`
}

type WorkspaceQuery struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Content string `json:"content,omitempty"`
}

type CLIWorkspaceContext struct {
	CWD          string   `json:"cwd,omitempty"`
	ContextFiles []string `json:"contextFiles,omitempty"`
	ConnectionID string   `json:"connectionId,omitempty"`
	Database     string   `json:"database,omitempty"`
	Command      string   `json:"command,omitempty"`
}

// Normalize fills deterministic defaults and computes ContentHash. The hash
// excludes itself, so callers can safely invoke Normalize repeatedly.
func (s *WorkspaceSnapshot) Normalize() error {
	if s == nil {
		return errors.New("workspace snapshot is nil")
	}
	if s.SchemaVersion == 0 {
		s.SchemaVersion = CurrentSchemaVersion
	}
	if s.SourceKind != WorkspaceDesktop && s.SourceKind != WorkspaceCLI {
		return fmt.Errorf("invalid workspace source kind %q", s.SourceKind)
	}
	s.SourceID = strings.TrimSpace(s.SourceID)
	s.SourceInstanceID = strings.TrimSpace(s.SourceInstanceID)
	if s.SourceID == "" || s.SourceInstanceID == "" {
		return errors.New("workspace sourceId and sourceInstanceId are required")
	}
	if s.Revision < 1 {
		return errors.New("workspace revision must be positive")
	}
	if s.CapturedAt.IsZero() {
		s.CapturedAt = time.Now().UTC()
	} else {
		s.CapturedAt = s.CapturedAt.UTC()
	}
	previous := s.ContentHash
	s.ContentHash = ""
	hash, err := HashJSON(s)
	if err != nil {
		s.ContentHash = previous
		return err
	}
	s.ContentHash = hash
	return nil
}
