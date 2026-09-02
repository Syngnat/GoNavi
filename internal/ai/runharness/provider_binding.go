package runharness

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrProviderBindingUnbound means a provider-facing run was accepted before
	// a complete provider configuration was frozen. Retrying with the current
	// settings would silently change its execution contract, so callers must
	// fail closed instead.
	ErrProviderBindingUnbound = errors.New("agent provider configuration is unbound")
	// ErrProviderBindingCorrupt means the encrypted provider binding is invalid
	// or disagrees with the indexed provider ID stored on the run.
	ErrProviderBindingCorrupt = errors.New("agent provider configuration binding is corrupt")
)

// ProviderBinding is the immutable, secret-bearing provider configuration
// captured when a run is accepted. Config remains generic JSON so the Harness
// does not depend on a particular provider configuration package.
//
// The Ledger encrypts this value at rest and never exposes it through run
// snapshots or Wails/CLI JSON APIs.
type ProviderBinding struct {
	ProviderID string          `json:"providerId"`
	Config     json.RawMessage `json:"config"`
}

// NewProviderBinding serializes a complete host-resolved provider
// configuration into a defensive, validated binding.
func NewProviderBinding(providerID string, config any) (ProviderBinding, error) {
	encoded, err := json.Marshal(config)
	if err != nil {
		return ProviderBinding{}, fmt.Errorf("encode provider binding: %w", err)
	}
	return (ProviderBinding{ProviderID: providerID, Config: encoded}).Validate()
}

// Validate returns a detached canonical copy. Provider-specific validation is
// deliberately owned by the resolver that unmarshals Config at execution time.
func (b ProviderBinding) Validate() (ProviderBinding, error) {
	b.ProviderID = strings.TrimSpace(b.ProviderID)
	if b.ProviderID == "" {
		return ProviderBinding{}, errors.New("provider binding providerId is required")
	}
	if len(b.Config) == 0 {
		return ProviderBinding{}, errors.New("provider binding config is required")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(b.Config, &object); err != nil {
		return ProviderBinding{}, fmt.Errorf("decode provider binding config: %w", err)
	}
	if object == nil {
		return ProviderBinding{}, errors.New("provider binding config must be a JSON object")
	}
	canonical, err := json.Marshal(object)
	if err != nil {
		return ProviderBinding{}, fmt.Errorf("canonicalize provider binding config: %w", err)
	}
	b.Config = json.RawMessage(canonical)
	return b, nil
}

func cloneProviderBinding(binding *ProviderBinding) *ProviderBinding {
	if binding == nil {
		return nil
	}
	copy := *binding
	copy.Config = bytes.Clone(binding.Config)
	return &copy
}
