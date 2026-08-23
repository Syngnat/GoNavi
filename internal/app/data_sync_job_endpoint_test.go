package app

import (
	"bytes"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/syncjob"
)

func TestDataSyncJobSourceIndexLocationUsesMappingThenEndpointSelection(t *testing.T) {
	endpoint := resolvedDataSyncJobEndpoint{Database: "sales", Schema: "public"}

	schema, table := dataSyncJobSourceIndexLocation(endpoint, syncjob.TableMapping{SourceSchema: " tenant ", SourceTable: " orders "})
	if schema != "tenant" || table != "orders" {
		t.Fatalf("mapping schema must win: schema=%q table=%q", schema, table)
	}
	schema, _ = dataSyncJobSourceIndexLocation(endpoint, syncjob.TableMapping{SourceTable: "orders"})
	if schema != "public" {
		t.Fatalf("endpoint schema must win over database: %q", schema)
	}
	endpoint.Schema = ""
	schema, _ = dataSyncJobSourceIndexLocation(endpoint, syncjob.TableMapping{SourceTable: "orders"})
	if schema != "sales" {
		t.Fatalf("database must be the final fallback: %q", schema)
	}
}

func TestDataSyncJobEndpointFingerprintHMACTracksSecretsAndSelection(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	base := resolvedDataSyncJobEndpoint{
		View:     connection.SavedConnectionView{ID: "conn-1", EnvironmentType: "production"},
		Config:   connection.ConnectionConfig{ID: "conn-1", Type: "postgres", Host: "db.internal", Password: "secret-a"},
		Database: "sales",
		Schema:   "public",
	}
	first, err := dataSyncJobEndpointFingerprint(base, key)
	if err != nil {
		t.Fatalf("fingerprint failed: %v", err)
	}
	base.Config.Password = "secret-b"
	second, err := dataSyncJobEndpointFingerprint(base, key)
	if err != nil {
		t.Fatalf("fingerprint with changed secret failed: %v", err)
	}
	if first == second {
		t.Fatal("credential rotation must invalidate the keyed endpoint fingerprint")
	}
	base.Config.Password = "secret-a"
	base.Schema = "reporting"
	third, err := dataSyncJobEndpointFingerprint(base, key)
	if err != nil {
		t.Fatalf("fingerprint with changed schema failed: %v", err)
	}
	if first == third {
		t.Fatal("schema selection must invalidate the endpoint fingerprint")
	}
}

func TestDataSyncJobFingerprintKeyIsStableAndSecretStoreBacked(t *testing.T) {
	store := newFakeAppSecretStore()
	firstApp := NewAppWithSecretStore(store)
	first, err := firstApp.dataSyncJobFingerprintKeyBytes()
	if err != nil || len(first) != 32 {
		t.Fatalf("create fingerprint key: len=%d err=%v", len(first), err)
	}
	secondApp := NewAppWithSecretStore(store)
	second, err := secondApp.dataSyncJobFingerprintKeyBytes()
	if err != nil {
		t.Fatalf("reload fingerprint key: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("fingerprint key changed across application instances")
	}
}

func TestDataSyncJobEndpointFingerprintHMACTracksOpaqueURIAndDSN(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	endpoint := resolvedDataSyncJobEndpoint{
		View:     connection.SavedConnectionView{ID: "conn-uri", SecretRef: "saved/conn-uri"},
		Config:   connection.ConnectionConfig{ID: "conn-uri", Type: "mongodb", URI: "mongodb://alice:secret-a@mongo.internal:27017/admin?authSource=admin"},
		Database: "sales",
	}
	first, err := dataSyncJobEndpointFingerprint(endpoint, key)
	if err != nil {
		t.Fatalf("fingerprint URI: %v", err)
	}
	endpoint.Config.URI = "mongodb://alice:secret-b@mongo.internal:27017/admin?authSource=other"
	second, err := dataSyncJobEndpointFingerprint(endpoint, key)
	if err != nil {
		t.Fatalf("fingerprint changed URI secret: %v", err)
	}
	if first == second {
		t.Fatal("opaque URI changes must invalidate the keyed fingerprint")
	}
	endpoint.Config.URI = "mongodb://alice:secret-b@mongo.other:27017/admin"
	third, err := dataSyncJobEndpointFingerprint(endpoint, key)
	if err != nil {
		t.Fatalf("fingerprint changed URI host: %v", err)
	}
	if first == third {
		t.Fatal("URI endpoint host change must invalidate the fingerprint")
	}
	endpoint.Config.URI = ""
	endpoint.Config.DSN = "server=db-a;database=sales;password=secret"
	fourth, err := dataSyncJobEndpointFingerprint(endpoint, key)
	if err != nil {
		t.Fatalf("fingerprint DSN endpoint: %v", err)
	}
	endpoint.Config.DSN = "server=db-b;database=sales;password=secret"
	fifth, err := dataSyncJobEndpointFingerprint(endpoint, key)
	if err != nil {
		t.Fatalf("fingerprint changed DSN endpoint: %v", err)
	}
	if fourth == fifth {
		t.Fatal("DSN-only endpoint change must invalidate the keyed fingerprint")
	}
}

func TestDataSyncJobProductionApprovalOnlyAppliesWithoutProtection(t *testing.T) {
	endpoint := resolvedDataSyncJobEndpoint{
		View:   connection.SavedConnectionView{EnvironmentType: "production"},
		Config: connection.ConnectionConfig{},
	}
	if !dataSyncJobNeedsProductionApproval(endpoint) {
		t.Fatal("unprotected production endpoint must require approval")
	}
	endpoint.Config.Protection.RestrictDataImport = true
	if !dataSyncJobNeedsProductionApproval(endpoint) {
		t.Fatal("an unrelated or blocking protection flag must not disable production approval")
	}
	endpoint.Config.ReadOnly = true
	if dataSyncJobNeedsProductionApproval(endpoint) {
		t.Fatal("read-only production endpoint cannot authorize a write approval")
	}
	endpoint.View.EnvironmentType = "test"
	endpoint.Config.ReadOnly = false
	endpoint.Config.Protection = connection.ConnectionProtectionConfig{}
	if dataSyncJobNeedsProductionApproval(endpoint) {
		t.Fatal("non-production endpoint must not require production approval")
	}
}

func TestDataSyncJobProductionApprovalCannotBeBypassedByUnrelatedGuards(t *testing.T) {
	for name, protection := range map[string]connection.ConnectionProtectionConfig{
		"script":    {RestrictScriptExecution: true},
		"structure": {RestrictStructureEdit: true},
	} {
		t.Run(name, func(t *testing.T) {
			endpoint := resolvedDataSyncJobEndpoint{
				View:   connection.SavedConnectionView{EnvironmentType: "production"},
				Config: connection.ConnectionConfig{Protection: protection},
			}
			if !dataSyncJobNeedsProductionApproval(endpoint) {
				t.Fatal("unrelated production guard bypassed data sync approval")
			}
		})
	}
}

func TestDataSyncJobCompareDoesNotRequireMutationApproval(t *testing.T) {
	endpoint := resolvedDataSyncJobEndpoint{
		View:   connection.SavedConnectionView{EnvironmentType: "production"},
		Config: connection.ConnectionConfig{},
	}
	if !dataSyncJobNeedsProductionApproval(endpoint) {
		t.Fatal("test endpoint must represent an unprotected production target")
	}
	if dataSyncJobRequiresExecutionApproval(syncjob.JobDefinition{Kind: syncjob.JobKindCompare}, endpoint) {
		t.Fatal("read-only compare task must not require mutation approval")
	}
	if !dataSyncJobRequiresExecutionApproval(syncjob.JobDefinition{Kind: syncjob.JobKindReconcile}, endpoint) {
		t.Fatal("reconcile task must require production mutation approval")
	}
}
