package connection

// LongTransactionPayload lists the sessions with an open transaction, oldest
// first. Each row is a DatabaseSession whose DurationMs is the transaction's
// age (not its current statement's), so the session actions apply unchanged.
type LongTransactionPayload struct {
	Engine       string             `json:"engine"`
	Capability   LockWaitCapability `json:"capability"`
	Transactions []DatabaseSession  `json:"transactions"`
}

// SessionMonitorCapabilities tells the alert settings which checks a data
// source supports, without opening a connection.
type SessionMonitorCapabilities struct {
	Engine           string             `json:"engine"`
	LockWaits        LockWaitCapability `json:"lockWaits"`
	LongTransactions LockWaitCapability `json:"longTransactions"`
}
