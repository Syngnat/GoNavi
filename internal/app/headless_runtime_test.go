package app

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHeadlessRuntimeResolveSavedConnectionRejectsDuplicateNames(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime returned error: %v", err)
	}
	defer runtime.Close()

	for _, id := range []string{"conn-one", "conn-two"} {
		if _, saveErr := runtime.SaveConnection(connection.SavedConnectionInput{
			ID:   id,
			Name: "Production",
			Config: connection.ConnectionConfig{
				ID:   id,
				Type: "mysql",
			},
		}); saveErr != nil {
			t.Fatalf("SaveConnection(%s) returned error: %v", id, saveErr)
		}
	}

	_, err = runtime.ResolveSavedConnection("Production")
	var ambiguous *AmbiguousConnectionNameError
	if !errors.As(err, &ambiguous) {
		t.Fatalf("ResolveSavedConnection returned %v, want AmbiguousConnectionNameError", err)
	}
	if ambiguous.Name != "Production" || len(ambiguous.IDs) != 2 || ambiguous.IDs[0] != "conn-one" || ambiguous.IDs[1] != "conn-two" {
		t.Fatalf("unexpected ambiguity details: %#v", ambiguous)
	}
}

func TestHeadlessRuntimeResolveSavedConnectionPrefersStableIDOverName(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime returned error: %v", err)
	}
	defer runtime.Close()

	for _, input := range []connection.SavedConnectionInput{
		{
			ID:   "stable-id",
			Name: "Production",
			Config: connection.ConnectionConfig{
				ID:   "stable-id",
				Type: "mysql",
			},
		},
		{
			ID:   "another-id",
			Name: "stable-id",
			Config: connection.ConnectionConfig{
				ID:   "another-id",
				Type: "mysql",
			},
		},
	} {
		if _, saveErr := runtime.SaveConnection(input); saveErr != nil {
			t.Fatalf("SaveConnection(%s): %v", input.ID, saveErr)
		}
	}

	resolved, err := runtime.ResolveSavedConnection("stable-id")
	if err != nil {
		t.Fatalf("ResolveSavedConnection returned error: %v", err)
	}
	if resolved.ID != "stable-id" || resolved.Name != "Production" {
		t.Fatalf("ResolveSavedConnection resolved %#v, want stable ID match", resolved)
	}
}
