package nativewindow

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
)

const (
	envParentURL = "GONAVI_DETACHED_PARENT_URL"
	envParentPID = "GONAVI_DETACHED_PARENT_PID"
	envToken     = "GONAVI_DETACHED_TOKEN"
	envWindowID  = "GONAVI_DETACHED_WINDOW_ID"
	envKind      = "GONAVI_DETACHED_KIND"
	envTitle     = "GONAVI_DETACHED_TITLE"
	envX         = "GONAVI_DETACHED_X"
	envY         = "GONAVI_DETACHED_Y"
	envWidth     = "GONAVI_DETACHED_WIDTH"
	envHeight    = "GONAVI_DETACHED_HEIGHT"
)

const staleDetachedActionMessage = "stale detached action ignored"

type visibilityCommandPayload struct {
	VisibilityRevision uint64 `json:"visibilityRevision"`
}

func detachedWindowMinimumSize(kind string) (width int, height int) {
	if strings.TrimSpace(kind) == "ai-chat" {
		return 360, 420
	}
	return 480, 320
}

func actionUsesRevision(action string) bool {
	return action == "sync" || action == "attach" || action == "close" || action == "hide" || action == "cancel-close"
}

func operationApplied(value bool) *bool {
	return &value
}

func revisionedActionApplied(action string, revision int64) *bool {
	if !actionUsesRevision(action) || revision <= 0 {
		return nil
	}
	return operationApplied(true)
}

func rollbackActionFromPayload(payload any) string {
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	rollbackAction, _ := record["rollbackAction"].(string)
	return strings.ToLower(strings.TrimSpace(rollbackAction))
}

func positiveVisibilityRevision(payload any) uint64 {
	switch typed := payload.(type) {
	case visibilityCommandPayload:
		return typed.VisibilityRevision
	case *visibilityCommandPayload:
		if typed != nil {
			return typed.VisibilityRevision
		}
	}
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	return positiveUintRevision(record["visibilityRevision"])
}

func positiveUintRevision(value any) uint64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed <= 9_007_199_254_740_991 && math.Trunc(typed) == typed {
			return uint64(typed)
		}
	case json.Number:
		revision, err := typed.Int64()
		if err == nil && revision > 0 {
			return uint64(revision)
		}
	case uint64:
		return typed
	case uint:
		return uint64(typed)
	case int64:
		if typed > 0 {
			return uint64(typed)
		}
	case int:
		if typed > 0 {
			return uint64(typed)
		}
	}
	return 0
}

// withOwnerWindowID stamps a lifecycle event with the window that opened it.
// Detached windows filter broadcasts by owner so a nested result window only
// updates its source workbench.
func withOwnerWindowID(payload any, ownerID string) any {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return payload
	}
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["ownerWindowId"] = ownerID
	return result
}

// openEventPayload keeps the fields the owner window needs to recreate a
// detached child in its own store, with the child's real bounds applied to the
// query-result snapshot.
func openEventPayload(payload any, bounds *WindowBounds) any {
	source, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]any, 2)
	for _, key := range []string{"tab", "resultWindow"} {
		value, exists := source[key]
		if !exists {
			continue
		}
		if key == "resultWindow" && bounds != nil {
			if resultWindow, ok := value.(map[string]any); ok {
				corrected := make(map[string]any, len(resultWindow)+4)
				for field, fieldValue := range resultWindow {
					corrected[field] = fieldValue
				}
				corrected["x"] = bounds.X
				corrected["y"] = bounds.Y
				corrected["width"] = bounds.Width
				corrected["height"] = bounds.Height
				value = corrected
			}
		}
		result[key] = value
	}
	return result
}

func withVisibilityRevision(payload any, visibilityRevision uint64) any {
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["visibilityRevision"] = visibilityRevision
	return result
}

func positiveActionRevision(payload any) int64 {
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	switch value := record["revision"].(type) {
	case float64:
		if value <= 0 || value > 9_007_199_254_740_991 || math.Trunc(value) != value {
			return 0
		}
		return int64(value)
	case json.Number:
		revision, err := value.Int64()
		if err == nil && revision > 0 {
			return revision
		}
	case int64:
		if value > 0 {
			return value
		}
	case int:
		if value > 0 {
			return int64(value)
		}
	}
	return 0
}

func newBridgeToken() (string, error) {
	payload := make([]byte, 32)
	if _, err := rand.Read(payload); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func setEnvironmentValue(environment []string, name string, value string) []string {
	prefix := name + "="
	filtered := environment[:0]
	for _, item := range environment {
		if !strings.HasPrefix(item, prefix) {
			filtered = append(filtered, item)
		}
	}
	return append(filtered, prefix+value)
}
