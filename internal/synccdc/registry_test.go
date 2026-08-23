package synccdc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type testAdapter struct {
	name    string
	sources []string
}

func (a testAdapter) Name() string          { return a.name }
func (a testAdapter) SourceTypes() []string { return a.sources }
func (a testAdapter) Probe(context.Context, connection.ConnectionConfig) (Capability, error) {
	return Capability{Adapter: a.name, Supported: true, Ready: true}, nil
}
func (a testAdapter) BeginSnapshot(context.Context, Request) (Barrier, error) {
	return Barrier{}, nil
}
func (a testAdapter) Open(context.Context, Request, Position) (Stream, error) { return nil, nil }

func TestRegistryNormalizesSourceFamiliesAndRejectsDuplicates(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(testAdapter{name: "postgres-logical", sources: []string{"postgres"}}); err != nil {
		t.Fatalf("register adapter: %v", err)
	}
	adapter, err := registry.ResolveSource("openGauss")
	if err != nil {
		t.Fatalf("resolve postgres family: %v", err)
	}
	if adapter.Name() != "postgres-logical" {
		t.Fatalf("resolved adapter = %q", adapter.Name())
	}
	if err := registry.Register(testAdapter{name: "other", sources: []string{"postgresql"}}); err == nil {
		t.Fatal("duplicate normalized source type must be rejected")
	}
	if _, err := registry.ResolveSource("oracle"); !errors.Is(err, ErrAdapterNotRegistered) {
		t.Fatalf("missing adapter error = %v", err)
	}
}

func TestRegistryIncludesBuiltInMongoDBChangeStreamAdapter(t *testing.T) {
	registry := NewRegistry()
	for _, sourceType := range []string{"mongodb", "mongodb-v1", "mongo"} {
		adapter, err := registry.ResolveSource(sourceType)
		if err != nil {
			t.Fatalf("resolve %s: %v", sourceType, err)
		}
		if adapter.Name() != mongoDBAdapterName {
			t.Fatalf("resolve %s = %q", sourceType, adapter.Name())
		}
	}
}

func TestValidatePositionBindsOpaqueOffsetToAdapter(t *testing.T) {
	valid := Position{Adapter: "mysql-binlog", Opaque: json.RawMessage(`{"file":"mysql.000001","position":4}`)}
	if err := ValidatePosition(valid, "mysql-binlog"); err != nil {
		t.Fatalf("valid position rejected: %v", err)
	}
	if err := ValidatePosition(valid, "postgres-logical"); err == nil {
		t.Fatal("cross-adapter position must be rejected")
	}
	valid.Opaque = json.RawMessage(`not-json`)
	if err := ValidatePosition(valid, "mysql-binlog"); err == nil {
		t.Fatal("invalid opaque position must be rejected")
	}
}
