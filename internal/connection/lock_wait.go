package connection

// LockWaitCapability describes whether a data source can report which server
// sessions are waiting for a lock and which sessions hold it.
type LockWaitCapability struct {
	Supported  bool   `json:"supported"`
	ReasonCode string `json:"reasonCode,omitempty"`
}

// DatabaseLockWait is one waiter→blocker edge. A session blocked by several
// holders produces several edges, and a blocker that is itself waiting appears
// as the waiting side of another edge, so the UI can rebuild blocking chains.
//
// The blocking identifiers mirror DatabaseSession so the existing session
// actions can terminate the blocker without a second lookup.
type DatabaseLockWait struct {
	Key string `json:"key"`

	WaitingSessionID    string `json:"waitingSessionId"`
	WaitingInstanceID   string `json:"waitingInstanceId,omitempty"`
	WaitingSerialNumber string `json:"waitingSerialNumber,omitempty"`
	WaitingUser         string `json:"waitingUser,omitempty"`
	WaitingStatement    string `json:"waitingStatement,omitempty"`
	WaitDurationMs      int64  `json:"waitDurationMs,omitempty"`

	BlockingSessionID    string `json:"blockingSessionId"`
	BlockingInstanceID   string `json:"blockingInstanceId,omitempty"`
	BlockingSerialNumber string `json:"blockingSerialNumber,omitempty"`
	BlockingUser         string `json:"blockingUser,omitempty"`
	BlockingState        string `json:"blockingState,omitempty"`
	// BlockingStatement is the blocker's running statement, or the last one it
	// ran when the engine can report it for an idle-in-transaction blocker.
	BlockingStatement string `json:"blockingStatement,omitempty"`
	// BlockingDurationMs is how long the blocker's transaction (or, when the
	// engine has no transaction start, its current call) has been open.
	BlockingDurationMs int64 `json:"blockingDurationMs,omitempty"`

	DatabaseOrTenant string `json:"databaseOrTenant,omitempty"`
	ObjectName       string `json:"objectName,omitempty"`
	IndexName        string `json:"indexName,omitempty"`
	LockType         string `json:"lockType,omitempty"`
	LockMode         string `json:"lockMode,omitempty"`
	BlockingLockMode string `json:"blockingLockMode,omitempty"`
}

// LockWaitPayload is returned for supported and unsupported engines alike so
// the UI can state the capability instead of showing an empty list.
type LockWaitPayload struct {
	Engine     string             `json:"engine"`
	Capability LockWaitCapability `json:"capability"`
	Waits      []DatabaseLockWait `json:"waits"`
	// ScopedDatabase is the database the rows were read from. PostgreSQL-lineage
	// servers only resolve relation names inside the connected database.
	ScopedDatabase string `json:"scopedDatabase,omitempty"`
}
