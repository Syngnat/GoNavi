package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
)

// loadAgentPolicy accepts the old bare-policy document as a read-only
// migration format, but always returns the versioned projection used by the
// desktop settings API. A bare document therefore has the stable initial
// revision rather than silently bypassing CAS on its first CLI update.
func loadAgentPolicy(path string) (runharness.RunPolicySnapshot, error) {
	snapshot := runharness.DefaultRunPolicySnapshot()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return snapshot, nil
	}
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		if err == nil {
			err = errors.New("run policy must be a JSON object")
		}
		return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
	}
	if raw, wrapped := object["policy"]; wrapped {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return runharness.RunPolicySnapshot{}, errors.New("decode run policy: policy must be an object")
		}
		var wrappedPolicy runharness.RunPolicy
		if err := json.Unmarshal(raw, &wrappedPolicy); err != nil {
			return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
		}
		snapshot.Policy = wrappedPolicy
		if raw, hasSchemaVersion := object["schemaVersion"]; hasSchemaVersion {
			if err := json.Unmarshal(raw, &snapshot.SchemaVersion); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy schema version: %w", err)
			}
		}
		if raw, hasRevision := object["revision"]; hasRevision {
			if err := json.Unmarshal(raw, &snapshot.Revision); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy revision: %w", err)
			}
		}
		if raw, hasRuntime := object["runtime"]; hasRuntime {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				return runharness.RunPolicySnapshot{}, errors.New("decode run policy: runtime must be an object")
			}
			if err := json.Unmarshal(raw, &snapshot.Runtime); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run runtime: %w", err)
			}
		}
	} else if err := json.Unmarshal(data, &snapshot.Policy); err != nil {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
	}
	// A bare policy is also accepted. Looking for the wrapper key explicitly is
	// important because json.Unmarshal would otherwise silently ignore a
	// malformed `policy` field while decoding the outer object.
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	return snapshot, nil
}

func validateAgentPolicy(policy runharness.RunPolicy) (runharness.RunPolicy, error) {
	policy = policy.Normalize()
	if err := policy.Validate(); err != nil {
		return runharness.RunPolicy{}, err
	}
	return policy, nil
}

func saveAgentPolicy(path string, snapshot runharness.RunPolicySnapshot) error {
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agent-policy-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	removeTemporary = false
	return nil
}

// mutateAgentPolicy serializes the load/revision-check/write sequence across
// desktop and CLI processes. Keeping the reload inside the lock is essential:
// an optimistic check before acquiring it would still allow two writers to
// accept the same revision and overwrite each other.
func mutateAgentPolicy(path string, expectedRevision int64, overrides string) (runharness.RunPolicySnapshot, error) {
	if expectedRevision < 1 {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("revision_conflict: %w: expectedRevision must be positive", runharness.ErrRevisionConflict)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	policyLock, err := appdata.AcquireFileLock(path + ".lock")
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	defer policyLock.Close()

	current, err := loadAgentPolicy(path)
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	if current.Revision != expectedRevision {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("revision_conflict: %w: expected %d, got %d", runharness.ErrRevisionConflict, expectedRevision, current.Revision)
	}
	next := current
	if err := applyAgentPolicySnapshotOverrides(&next, overrides); err != nil {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("%w: %v", errAgentPolicyOverride, err)
	}
	next.Revision++
	if err := saveAgentPolicy(path, next); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	return next, nil
}

func applyAgentPolicyOverrides(policy *runharness.RunPolicy, values string) error {
	if policy == nil {
		return errors.New("run policy is nil")
	}
	err := forEachAgentPolicyOverride(values, func(rawKey, value string) error {
		key := normalizeAgentPolicyKey(rawKey)
		if isAgentRuntimePolicyKey(key) {
			return fmt.Errorf("unknown run policy field %q", rawKey)
		}
		return applyAgentRunPolicyField(policy, key, value, rawKey)
	})
	if err != nil {
		return err
	}
	_, validationErr := validateAgentPolicy(*policy)
	return validationErr
}

// applyAgentPolicySnapshotOverrides is used by the persistent config command.
// Runtime coordination values live beside RunPolicy in the shared snapshot,
// so they must be parsed in one pass and validated together (in particular,
// renew interval must remain shorter than the lease duration).
func applyAgentPolicySnapshotOverrides(snapshot *runharness.RunPolicySnapshot, values string) error {
	if snapshot == nil {
		return errors.New("run policy snapshot is nil")
	}
	*snapshot = snapshot.Normalize()
	err := forEachAgentPolicyOverride(values, func(rawKey, value string) error {
		key := normalizeAgentPolicyKey(rawKey)
		switch key {
		case "controlpollinterval":
			return setRuntimeDuration(&snapshot.Runtime.ControlPollInterval, value, rawKey)
		case "workspacesnapshotrenewinterval":
			return setRuntimeDuration(&snapshot.Runtime.WorkspaceSnapshotRenewInterval, value, rawKey)
		case "workspacesnapshotleaseduration":
			return setRuntimeDuration(&snapshot.Runtime.WorkspaceSnapshotLeaseDuration, value, rawKey)
		case "policywatchinterval":
			return setRuntimeDuration(&snapshot.Runtime.PolicyWatchInterval, value, rawKey)
		default:
			return applyAgentRunPolicyField(&snapshot.Policy, key, value, rawKey)
		}
	})
	if err != nil {
		return err
	}
	*snapshot = snapshot.Normalize()
	return snapshot.Validate()
}

func forEachAgentPolicyOverride(values string, apply func(rawKey, value string) error) error {
	if apply == nil {
		return errors.New("policy override handler is nil")
	}
	for _, item := range strings.Split(values, ",") {
		parts := strings.SplitN(strings.TrimSpace(item), "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return fmt.Errorf("policy override must be key=value: %q", item)
		}
		if err := apply(strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])); err != nil {
			return err
		}
	}
	return nil
}

func normalizeAgentPolicyKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.NewReplacer("-", "", "_", "").Replace(key)
	return key
}

func isAgentRuntimePolicyKey(key string) bool {
	switch key {
	case "controlpollinterval", "workspacesnapshotrenewinterval", "workspacesnapshotleaseduration", "policywatchinterval":
		return true
	default:
		return false
	}
}

func setRuntimeDuration(target *time.Duration, value, rawKey string) error {
	if target == nil {
		return errors.New("runtime duration target is nil")
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return fmt.Errorf("%s: %w", rawKey, err)
	}
	*target = duration
	return nil
}

func applyAgentRunPolicyField(policy *runharness.RunPolicy, key, value, rawKey string) error {
	if policy == nil {
		return errors.New("run policy is nil")
	}
	switch key {
	case "defaultdispatchmode", "dispatch":
		mode, err := parseDispatchMode(value)
		if err != nil {
			return err
		}
		policy.DefaultDispatchMode = mode
	case "softtoolroundlimit":
		if err := setPolicyInt(&policy.SoftToolRoundLimit, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtoolrounds":
		if err := setPolicyInt(&policy.MaxToolRounds, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxconsecutivefailedtoolrounds":
		if err := setPolicyInt(&policy.MaxConsecutiveFailedToolRounds, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtoolnudges":
		if err := setPolicyInt(&policy.MaxToolNudges, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxmodelretriesperturn":
		if err := setPolicyInt(&policy.MaxModelRetriesPerTurn, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtotaltokens":
		if err := setPolicyInt(&policy.MaxTotalTokens, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxactiveduration":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.MaxActiveDuration = duration
	case "modelturntimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.ModelTurnTimeout = duration
	case "modelidletimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.ModelIdleTimeout = duration
	case "defaulttooltimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.DefaultToolTimeout = duration
	case "maxtoolresultbytes":
		if err := setPolicyInt64(&policy.MaxToolResultBytes, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	default:
		return fmt.Errorf("unknown run policy field %q", rawKey)
	}
	return nil
}

func setPolicyInt(target *int, value string) error {
	number, err := strconv.Atoi(value)
	if err != nil {
		return err
	}
	*target = number
	return nil
}

func setPolicyInt64(target *int64, value string) error {
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return err
	}
	*target = number
	return nil
}
