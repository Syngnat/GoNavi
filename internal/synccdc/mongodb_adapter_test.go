package synccdc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type fakeMongoConnector struct {
	connection *fakeMongoConnection
	err        error
}

func (f *fakeMongoConnector) Connect(context.Context, connection.ConnectionConfig) (mongoConnection, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.connection, nil
}

type fakeMongoConnection struct {
	mu             sync.Mutex
	topology       mongoTopology
	inspectErr     error
	operationTime  bson.Timestamp
	operationErr   error
	probeErr       error
	cursor         mongoCursor
	openErr        error
	openNamespaces []mongoNamespace
	openStart      mongoWatchStart
	disconnects    int
}

func (f *fakeMongoConnection) Inspect(context.Context) (mongoTopology, error) {
	return f.topology, f.inspectErr
}

func (f *fakeMongoConnection) SnapshotOperationTime(context.Context, mongoNamespace) (bson.Timestamp, error) {
	return f.operationTime, f.operationErr
}

func (f *fakeMongoConnection) ProbeChangeStream(context.Context, string, bson.Timestamp) error {
	return f.probeErr
}

func (f *fakeMongoConnection) OpenChangeStream(_ context.Context, namespaces []mongoNamespace, start mongoWatchStart) (mongoCursor, error) {
	f.mu.Lock()
	f.openNamespaces = append([]mongoNamespace(nil), namespaces...)
	f.openStart = start
	f.mu.Unlock()
	if f.openErr != nil {
		return nil, f.openErr
	}
	return f.cursor, nil
}

func (f *fakeMongoConnection) Disconnect(context.Context) error {
	f.mu.Lock()
	f.disconnects++
	f.mu.Unlock()
	return nil
}

type fakeMongoCursor struct {
	mu          sync.Mutex
	events      []bson.Raw
	tokens      []bson.Raw
	index       int
	err         error
	closed      int
	nextStarted chan struct{}
	block       bool
}

func (f *fakeMongoCursor) Next(ctx context.Context) bool {
	if f.block {
		if f.nextStarted != nil {
			select {
			case f.nextStarted <- struct{}{}:
			default:
			}
		}
		<-ctx.Done()
		f.mu.Lock()
		f.err = ctx.Err()
		f.mu.Unlock()
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.index < len(f.events)
}

func (f *fakeMongoCursor) Decode(value any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.index >= len(f.events) {
		return errors.New("no fake MongoDB event")
	}
	err := bson.Unmarshal(f.events[f.index], value)
	f.index++
	return err
}

func (f *fakeMongoCursor) ResumeToken() bson.Raw {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.index == 0 || f.index > len(f.tokens) {
		return nil
	}
	return f.tokens[f.index-1]
}

func (f *fakeMongoCursor) Err() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

func (f *fakeMongoCursor) Close(context.Context) error {
	f.mu.Lock()
	f.closed++
	f.mu.Unlock()
	return nil
}

func TestMongoPositionRoundTripPreservesRawResumeToken(t *testing.T) {
	token := mustMongoRaw(t, bson.D{{Key: "_data", Value: "8268AABB"}, {Key: "nested", Value: bson.D{{Key: "n", Value: int64(42)}}}})
	position, err := mongoResumeTokenPosition("scope-1", token)
	if err != nil {
		t.Fatalf("encode position: %v", err)
	}
	payload, decodedToken, operationTime, err := decodeMongoPosition(position)
	if err != nil {
		t.Fatalf("decode position: %v", err)
	}
	if payload.ScopeHash != "scope-1" || operationTime != nil {
		t.Fatalf("unexpected decoded payload: %+v, operationTime=%v", payload, operationTime)
	}
	if !bytes.Equal(decodedToken, token) {
		t.Fatalf("resume token changed: got %v want %v", decodedToken, token)
	}

	position.Opaque = json.RawMessage(`{"version":1,"scopeHash":"scope-1","resumeFormat":"bson-base64-v1","resumeTokenBson":"not@base64"}`)
	if _, _, _, err := decodeMongoPosition(position); err == nil {
		t.Fatal("malformed base64 resume token must be rejected")
	}
	validPosition, err := mongoResumeTokenPosition("scope-1", token)
	if err != nil {
		t.Fatalf("re-encode position: %v", err)
	}
	validPosition.Opaque = append(validPosition.Opaque, []byte(` {}`)...)
	if _, _, _, err := decodeMongoPosition(validPosition); err == nil {
		t.Fatal("trailing JSON must be rejected")
	}
}

func TestMongoBeginSnapshotUsesOperationTimeBarrier(t *testing.T) {
	fakeConnection := &fakeMongoConnection{
		topology:      mongoTopology{ReplicaSet: "rs0", MaxWireVersion: 17},
		operationTime: bson.Timestamp{T: 1_725_000_000, I: 7},
	}
	adapter := newMongoDBAdapterWithConnector(&fakeMongoConnector{connection: fakeConnection})
	request := mongoTestRequest()
	barrier, err := adapter.BeginSnapshot(context.Background(), request)
	if err != nil {
		t.Fatalf("begin snapshot: %v", err)
	}
	payload, token, operationTime, err := decodeMongoPosition(barrier.Position)
	if err != nil {
		t.Fatalf("decode barrier position: %v", err)
	}
	if len(token) != 0 || operationTime == nil || *operationTime != fakeConnection.operationTime {
		t.Fatalf("unexpected barrier: payload=%+v token=%v operationTime=%v", payload, token, operationTime)
	}
	var snapshot mongoSnapshotToken
	if err := json.Unmarshal(barrier.SnapshotToken, &snapshot); err != nil {
		t.Fatalf("decode snapshot token: %v", err)
	}
	if snapshot.Strategy != "startAtOperationTime" || !strings.Contains(snapshot.Semantics, "at-least-once") {
		t.Fatalf("snapshot semantics not explicit: %+v", snapshot)
	}
}

func TestMongoOpenUsesResumeTokenAndSelectedNamespaces(t *testing.T) {
	resumeToken := mustMongoRaw(t, bson.D{{Key: "_data", Value: "resume-1"}})
	fakeConnection := &fakeMongoConnection{
		topology: mongoTopology{ReplicaSet: "rs0", MaxWireVersion: 17},
		cursor:   &fakeMongoCursor{},
	}
	adapter := newMongoDBAdapterWithConnector(&fakeMongoConnector{connection: fakeConnection})
	request := mongoTestRequest()
	namespaces, scopeHash, err := validateMongoRequest(request)
	if err != nil {
		t.Fatalf("validate request: %v", err)
	}
	position, err := mongoResumeTokenPosition(scopeHash, resumeToken)
	if err != nil {
		t.Fatalf("encode resume position: %v", err)
	}
	stream, err := adapter.Open(context.Background(), request, position)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer stream.Close()
	if len(fakeConnection.openStart.ResumeToken) == 0 || fakeConnection.openStart.OperationTime != nil {
		t.Fatalf("resume start was not used: %+v", fakeConnection.openStart)
	}
	if len(fakeConnection.openNamespaces) != len(namespaces) {
		t.Fatalf("namespaces = %+v, want %+v", fakeConnection.openNamespaces, namespaces)
	}
}

func TestMongoProbeClassifiesTopologyPrivilegeAndReadyState(t *testing.T) {
	tests := []struct {
		name       string
		connection *fakeMongoConnection
		ready      bool
		reason     string
	}{
		{
			name:       "standalone",
			connection: &fakeMongoConnection{topology: mongoTopology{MaxWireVersion: 17}},
			reason:     "standalone",
		},
		{
			name: "not authorized",
			connection: &fakeMongoConnection{
				topology:      mongoTopology{ReplicaSet: "rs0", MaxWireVersion: 17},
				operationTime: bson.Timestamp{T: 100, I: 1},
				probeErr:      mongo.CommandError{Code: 13, Message: "not authorized"},
			},
			reason: "changeStream and find",
		},
		{
			name: "ready",
			connection: &fakeMongoConnection{
				topology:      mongoTopology{ReplicaSet: "rs0", MaxWireVersion: 17},
				operationTime: bson.Timestamp{T: 100, I: 1},
			},
			ready:  true,
			reason: "at-least-once",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := newMongoDBAdapterWithConnector(&fakeMongoConnector{connection: test.connection})
			capability, err := adapter.Probe(context.Background(), mongoTestRequest().Config)
			if err != nil {
				t.Fatalf("probe: %v", err)
			}
			if capability.Ready != test.ready {
				t.Fatalf("ready=%v, want %v; reason=%q", capability.Ready, test.ready, capability.Reason)
			}
			if !strings.Contains(capability.Reason, test.reason) {
				t.Fatalf("reason %q does not contain %q", capability.Reason, test.reason)
			}
			if capability.PreservesSourceTransactions {
				t.Fatal("adapter must not claim transaction grouping")
			}
			if !capability.RequiresCausalSnapshotReads || !strings.Contains(capability.SnapshotSemantics, "cannot enforce") {
				t.Fatalf("snapshot consistency condition is not explicit: %+v", capability)
			}
			if !strings.Contains(capability.AcknowledgementSemantics, "no server-side") {
				t.Fatalf("acknowledgement semantics are misleading: %q", capability.AcknowledgementSemantics)
			}
		})
	}
}

func TestMongoRequestRejectsEmptyObjectsAndUnresolvedRoutes(t *testing.T) {
	request := mongoTestRequest()
	request.Objects = nil
	if _, _, err := validateMongoRequest(request); err == nil {
		t.Fatal("empty object selection must be rejected")
	}
	request = mongoTestRequest()
	request.Config.UseSSH = true
	if _, _, err := validateMongoRequest(request); err == nil || !strings.Contains(err.Error(), "resolved direct endpoint") {
		t.Fatalf("unresolved SSH route error = %v", err)
	}
	request = mongoTestRequest()
	request.Config.UseProxy = true
	if _, _, err := validateMongoRequest(request); err == nil || !strings.Contains(err.Error(), "resolved direct endpoint") {
		t.Fatalf("unresolved proxy route error = %v", err)
	}
}

func TestMongoConnectionURIAndScopeNeverPersistCredentials(t *testing.T) {
	config := connection.ConnectionConfig{
		Type:       "mongodb",
		URI:        "mongodb://secret-user:secret-password@mongo.example:27017/app?replicaSet=rs0",
		Database:   "app",
		ReplicaSet: "rs0",
	}
	uri, err := mongoConnectionURI(config)
	if err != nil {
		t.Fatalf("build URI: %v", err)
	}
	if !strings.Contains(uri, "secret-password") {
		t.Fatal("driver URI unexpectedly discarded runtime credentials")
	}
	safeEndpoint := mongoSafeEndpoint(config)
	if strings.Contains(safeEndpoint, "secret-user") || strings.Contains(safeEndpoint, "secret-password") {
		t.Fatalf("safe endpoint leaked credentials: %q", safeEndpoint)
	}
	request := mongoTestRequest()
	request.Config = config
	_, scopeHash, err := validateMongoRequest(request)
	if err != nil {
		t.Fatalf("validate request: %v", err)
	}
	if strings.Contains(scopeHash, "secret") || len(scopeHash) != 64 {
		t.Fatalf("scope hash is not an opaque SHA-256 value: %q", scopeHash)
	}
}

func TestMongoAuthAttemptsPreferPrimaryThenReplicaCredentials(t *testing.T) {
	config := connection.ConnectionConfig{
		User:                 "primary-user",
		Password:             "primary-password",
		MongoReplicaUser:     "cdc-user",
		MongoReplicaPassword: "cdc-password",
	}
	attempts := mongoAuthAttempts(config)
	if len(attempts) != 2 || attempts[0].User != "primary-user" || attempts[1].User != "cdc-user" {
		t.Fatalf("unexpected auth attempts: %+v", attempts)
	}
	if attempts[1].MongoReplicaPassword != "" {
		t.Fatal("replica attempt must not recursively retain alternate credentials")
	}
}

func mongoTestRequest() Request {
	return Request{
		Config: connection.ConnectionConfig{
			ID:         "source-1",
			Type:       "mongodb-v1",
			Host:       "mongo.internal",
			Port:       27017,
			Database:   "app",
			ReplicaSet: "rs0",
		},
		Objects: []ObjectRef{
			{Database: "app", Name: "orders"},
			{Database: "app", Name: "customers"},
		},
	}
}

func mustMongoRaw(t *testing.T, value any) bson.Raw {
	t.Helper()
	raw, err := bson.Marshal(value)
	if err != nil {
		t.Fatalf("marshal BSON: %v", err)
	}
	return raw
}
