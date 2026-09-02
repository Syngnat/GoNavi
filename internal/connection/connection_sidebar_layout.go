package connection

// ConnectionTag describes one user-managed host group in the connection
// sidebar. ConnectionIDs contains direct hosts only; ChildOrder may mix
// connection:<id> and tag:<id> tokens for direct children.
type ConnectionTag struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	CreatedAt          int64    `json:"createdAt,omitempty"`
	ParentTagID        string   `json:"parentTagId,omitempty"`
	ConnectionIDs      []string `json:"connectionIds"`
	ChildOrder         []string `json:"childOrder,omitempty"`
	SortMode           string   `json:"sortMode,omitempty"`
	ConnectionSortMode string   `json:"connectionSortMode,omitempty"`
}

// ConnectionSidebarLayoutInput is the client-owned layout snapshot used for
// first-run bootstrap candidates and complete authoritative replacements.
type ConnectionSidebarLayoutInput struct {
	ConnectionTags         []ConnectionTag `json:"connectionTags"`
	SidebarRootOrder       []string        `json:"sidebarRootOrder"`
	RootSortMode           string          `json:"rootSortMode,omitempty"`
	RootConnectionSortMode string          `json:"rootConnectionSortMode,omitempty"`
}

// ConnectionSidebarLayout is the authoritative shared layout returned to a
// client. Initialized distinguishes a missing file from an intentionally saved
// empty layout.
type ConnectionSidebarLayout struct {
	Initialized            bool            `json:"initialized"`
	Revision               uint64          `json:"revision"`
	ConnectionTags         []ConnectionTag `json:"connectionTags"`
	SidebarRootOrder       []string        `json:"sidebarRootOrder"`
	RootSortMode           string          `json:"rootSortMode,omitempty"`
	RootConnectionSortMode string          `json:"rootConnectionSortMode,omitempty"`
}

// SaveConnectionSidebarLayoutInput replaces the complete shared layout when
// ExpectedRevision still matches the authoritative file.
type SaveConnectionSidebarLayoutInput struct {
	ExpectedRevision uint64                       `json:"expectedRevision"`
	Layout           ConnectionSidebarLayoutInput `json:"layout"`
}

// SaveConnectionSidebarLayoutResult returns the authoritative layout for both
// successful writes and optimistic-concurrency conflicts.
type SaveConnectionSidebarLayoutResult struct {
	Conflict bool                    `json:"conflict"`
	Layout   ConnectionSidebarLayout `json:"layout"`
}

// DeleteConnectionGroupInput requests an atomic recursive group deletion.
// ExpectedRevision protects against deleting connections after another window
// has changed the authoritative group layout.
type DeleteConnectionGroupInput struct {
	TagID            string `json:"tagId"`
	ExpectedRevision uint64 `json:"expectedRevision"`
}
