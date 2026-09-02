package runharness

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// UnmarshalJSON accepts both the legacy encoding/json representation of a
// time.Duration (an integer number of nanoseconds) and the human-readable
// duration strings commonly used in configuration files (for example,
// "375ms" or "2s"). MarshalJSON remains the standard numeric representation
// so existing Wails bindings and stored policy files remain wire-compatible.
func (c *RunRuntimeConfig) UnmarshalJSON(data []byte) error {
	if c == nil {
		return fmt.Errorf("decode run runtime: nil receiver")
	}
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return fmt.Errorf("decode run runtime: %w", err)
	}
	if fields == nil {
		return fmt.Errorf("decode run runtime: expected an object")
	}
	for key, target := range map[string]*time.Duration{
		"controlPollInterval":            &c.ControlPollInterval,
		"workspaceSnapshotRenewInterval": &c.WorkspaceSnapshotRenewInterval,
		"workspaceSnapshotLeaseDuration": &c.WorkspaceSnapshotLeaseDuration,
		"policyWatchInterval":            &c.PolicyWatchInterval,
	} {
		raw, ok := fields[key]
		if !ok {
			continue
		}
		value, err := decodeJSONDuration(raw)
		if err != nil {
			return fmt.Errorf("decode run runtime %s: %w", key, err)
		}
		*target = value
	}
	return nil
}

func decodeJSONDuration(raw json.RawMessage) (time.Duration, error) {
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return 0, nil
	}
	if len(trimmed) == 0 {
		return 0, fmt.Errorf("duration is empty")
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return 0, err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return 0, fmt.Errorf("duration string is empty")
		}
		value, err := time.ParseDuration(text)
		if err != nil {
			return 0, err
		}
		return value, nil
	}
	// Keep the numeric form deliberately strict: encoding/json accepts only an
	// integer for time.Duration, so decimal or exponent values should not be
	// silently rounded when a user edits the policy file.
	value, err := strconv.ParseInt(string(trimmed), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("expected nanoseconds integer or duration string: %w", err)
	}
	return time.Duration(value), nil
}
