package app

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestSavedConnectionRevisionRejectsStaleWrites(t *testing.T) {
	repo := newSavedConnectionRepository(t.TempDir(), newFakeAppSecretStore())
	input := connection.SavedConnectionInput{
		Name:   "primary",
		Config: connection.ConnectionConfig{Type: "postgres", Host: "db.local", Port: 5432},
	}
	first, err := repo.Save(input)
	if err != nil {
		t.Fatalf("first save failed: %v", err)
	}
	if first.Revision != 1 {
		t.Fatalf("first revision = %d, want 1", first.Revision)
	}

	update := input
	update.ID = first.ID
	update.Name = "primary-renamed"
	update.Revision = first.Revision
	second, err := repo.Save(update)
	if err != nil {
		t.Fatalf("second save failed: %v", err)
	}
	if second.Revision != 2 {
		t.Fatalf("second revision = %d, want 2", second.Revision)
	}

	stale := update
	stale.Name = "stale-overwrite"
	stale.Revision = first.Revision
	if _, err := repo.Save(stale); !errors.Is(err, errSavedConnectionRevisionConflict) {
		t.Fatalf("expected stale revision conflict, got %v", err)
	}

	connections, err := repo.load()
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if len(connections) != 1 || connections[0].Name != "primary-renamed" {
		t.Fatalf("stale write must not overwrite the newer record: %+v", connections)
	}
}
