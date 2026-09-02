package aiservice

// AgentLedgerKeyRef returns the data-root-scoped keyring reference used by the
// desktop Agent Run Harness. CLI hosts must use the same reference when they
// open the Ledger for this data root, otherwise both processes would create
// different encryption keys for the same SQLite file.
func AgentLedgerKeyRef(dataRoot string) (string, error) {
	return agentLedgerKeyRef(dataRoot)
}
