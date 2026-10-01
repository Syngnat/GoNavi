package connection

// SessionAction identifies a server-side session workbench action.
type SessionAction string

const (
	SessionActionCancelQuery      SessionAction = "cancelQuery"
	SessionActionTerminateSession SessionAction = "terminateSession"
)

// SessionActionTarget identifies the field a server command consumes.  The
// frontend must use this contract rather than guessing that a query ID can be
// substituted for a session ID (or the other way around).
type SessionActionTarget string

const (
	SessionActionTargetSessionID SessionActionTarget = "sessionId"
	SessionActionTargetQueryID   SessionActionTarget = "queryId"
)

// SessionCapability describes the server-side session operations exposed by a
// data source. Supported refers to listing live server sessions, not to the
// generic ability to execute queries through GoNavi.
type SessionCapability struct {
	Supported                          bool                `json:"supported"`
	CanCancelQuery                     bool                `json:"canCancelQuery"`
	CanTerminateSession                bool                `json:"canTerminateSession"`
	CancelTarget                       SessionActionTarget `json:"cancelTarget,omitempty"`
	TerminateTarget                    SessionActionTarget `json:"terminateTarget,omitempty"`
	TerminateRequiresInstanceAndSerial bool                `json:"terminateRequiresInstanceAndSerial,omitempty"`
	ReasonCode                         string              `json:"reasonCode,omitempty"`
}

// DatabaseSession is the normalized, cross-dialect projection rendered by the
// session workbench. Identifiers remain separate because a query ID must never
// be substituted for a session ID (or vice versa).
type DatabaseSession struct {
	Key              string `json:"key"`
	DatabaseOrTenant string `json:"databaseOrTenant,omitempty"`
	SessionID        string `json:"sessionId,omitempty"`
	QueryID          string `json:"queryId,omitempty"`
	InstanceID       string `json:"instanceId,omitempty"`
	SerialNumber     string `json:"serialNumber,omitempty"`
	Statement        string `json:"statement,omitempty"`
	State            string `json:"state,omitempty"`
	DurationMs       int64  `json:"durationMs,omitempty"`
	User             string `json:"user,omitempty"`
}

// SessionListPayload is returned for both supported and unsupported engines so
// the UI can render an honest capability state without synthesizing rows.
type SessionListPayload struct {
	Engine     string            `json:"engine"`
	Capability SessionCapability `json:"capability"`
	Sessions   []DatabaseSession `json:"sessions"`
	// ScopedDatabase reports the database this listing was read from, because
	// PostgreSQL-lineage servers only expose sessions of the connected
	// database. The UI states it so an empty list is not mistaken for "the
	// server has no sessions". The database catalog is served separately by
	// DBListSessionDatabases, which only the picker needs.
	ScopedDatabase string `json:"scopedDatabase,omitempty"`
}

// SessionActionRequest carries the exact identifiers from one normalized row.
// The driver adapter validates the fields required by the selected action.
type SessionActionRequest struct {
	Action       SessionAction `json:"action"`
	SessionID    string        `json:"sessionId,omitempty"`
	QueryID      string        `json:"queryId,omitempty"`
	InstanceID   string        `json:"instanceId,omitempty"`
	SerialNumber string        `json:"serialNumber,omitempty"`
}
