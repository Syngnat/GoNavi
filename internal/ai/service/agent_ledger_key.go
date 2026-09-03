package aiservice

import (
	"fmt"
	"path/filepath"
	"strings"
)

const (
	agentLedgerFileName    = "agent_runs.sqlite"
	agentLedgerKeyFileName = "agent_runs.key"
)

// AgentLedgerKeyFilePath returns the data-root-scoped local encryption-key
// path shared by the desktop and CLI harnesses. The key file is created by the
// harness with 0600 permissions, so opening an Agent ledger never needs an OS
// keychain prompt.
func AgentLedgerKeyFilePath(dataRoot string) (string, error) {
	root, err := resolveAgentLedgerDataRoot(dataRoot)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, agentLedgerKeyFileName), nil
}

// AgentLedgerKeyRef returns the legacy Keychain reference used by releases
// before the local key file. It remains available only to identify a legacy
// encrypted ledger; new desktop and CLI harnesses must use
// AgentLedgerKeyFilePath instead.
func AgentLedgerKeyRef(dataRoot string) (string, error) {
	return agentLedgerKeyRef(dataRoot)
}

func resolveAgentLedgerDataRoot(dataRoot string) (string, error) {
	abs, err := filepath.Abs(strings.TrimSpace(dataRoot))
	if err != nil {
		return "", fmt.Errorf("resolve agent ledger data root: %w", err)
	}
	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		abs = resolved
	}
	return filepath.Clean(abs), nil
}
