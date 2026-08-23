package synccdc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type bufferedFakeMongoCursor struct {
	*fakeMongoCursor
}

func (cursor *bufferedFakeMongoCursor) TryNext(ctx context.Context) bool {
	return cursor.fakeMongoCursor.Next(ctx)
}

func (cursor *bufferedFakeMongoCursor) RemainingBatchLength() int {
	cursor.mu.Lock()
	defer cursor.mu.Unlock()
	return len(cursor.events) - cursor.index
}

func TestMongoStreamMapsInsertReplaceUpdateAndDelete(t *testing.T) {
	objectID := bson.NewObjectID()
	sessionID := mustMongoRaw(t, bson.D{{Key: "id", Value: bson.Binary{Subtype: 4, Data: []byte("0123456789abcdef")}}})
	txnNumber := int64(9)
	operations := []string{"insert", "replace", "update", "delete"}
	events := make([]bson.Raw, 0, len(operations))
	tokens := make([]bson.Raw, 0, len(operations))
	for index, operation := range operations {
		document := bson.D{
			{Key: "_id", Value: bson.D{{Key: "_data", Value: operation}}},
			{Key: "operationType", Value: operation},
			{Key: "ns", Value: bson.D{{Key: "db", Value: "app"}, {Key: "coll", Value: "orders"}}},
			{Key: "documentKey", Value: bson.D{{Key: "_id", Value: objectID}}},
			{Key: "clusterTime", Value: bson.Timestamp{T: uint32(1_725_000_000 + index), I: 1}},
			{Key: "lsid", Value: sessionID},
			{Key: "txnNumber", Value: txnNumber},
		}
		if operation != "delete" {
			document = append(document, bson.E{Key: "fullDocument", Value: bson.D{
				{Key: "_id", Value: objectID},
				{Key: "amount", Value: int64(9_007_199_254_740_993)},
				{Key: "ratio", Value: 1.25},
			}})
		}
		events = append(events, mustMongoRaw(t, document))
		tokens = append(tokens, mustMongoRaw(t, bson.D{{Key: "_data", Value: "token-" + operation}}))
	}
	cursor := &fakeMongoCursor{events: events, tokens: tokens}
	connection := &fakeMongoConnection{cursor: cursor}
	stream := newMongoDBStream(connection, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
	defer stream.Close()

	var previousPosition Position
	for _, expectedOperation := range operations {
		transaction, err := stream.Next(context.Background())
		if err != nil {
			t.Fatalf("next %s: %v", expectedOperation, err)
		}
		if len(transaction.Events) != 1 || transaction.Events[0].Operation != expectedOperation {
			t.Fatalf("unexpected transaction: %+v", transaction)
		}
		event := transaction.Events[0]
		if event.Object.Database != "app" || event.Object.Name != "orders" {
			t.Fatalf("unexpected namespace: %+v", event.Object)
		}
		if event.Key["_id"] == nil {
			t.Fatalf("document key was not preserved: %+v", event.Key)
		}
		objectIDJSON, ok := event.Key["_id"].(map[string]interface{})
		if !ok || objectIDJSON["$oid"] != objectID.Hex() {
			t.Fatalf("ObjectID was not preserved as canonical Extended JSON: %+v", event.Key["_id"])
		}
		if expectedOperation == "delete" {
			if event.After != nil {
				t.Fatalf("delete after image = %+v", event.After)
			}
		} else {
			amountJSON, ok := event.After["amount"].(map[string]interface{})
			if !ok || amountJSON["$numberLong"] != "9007199254740993" {
				t.Fatalf("64-bit integer was not preserved as canonical Extended JSON: %+v", event.After)
			}
			if event.After["ratio"] != float64(1.25) {
				t.Fatalf("ordinary double must match snapshot conversion semantics: %+v", event.After)
			}
		}
		if !strings.HasPrefix(event.SourceTxID, "mongo-tx-") {
			t.Fatalf("source transaction identity missing: %q", event.SourceTxID)
		}
		if previousPosition.Adapter != "" {
			if err := stream.Acknowledge(context.Background(), previousPosition); err == nil {
				t.Fatalf("stale acknowledgement before %s must be rejected", expectedOperation)
			}
		}
		if err := stream.Acknowledge(context.Background(), transaction.Position); err != nil {
			t.Fatalf("acknowledge %s: %v", expectedOperation, err)
		}
		if err := stream.Acknowledge(context.Background(), transaction.Position); err != nil {
			t.Fatalf("idempotent acknowledge %s: %v", expectedOperation, err)
		}
		previousPosition = transaction.Position
	}
}

func TestMongoStreamDrainsBufferedEventsAndAcknowledgesFinalPosition(t *testing.T) {
	events := make([]bson.Raw, 0, 3)
	tokens := make([]bson.Raw, 0, 3)
	for index := 1; index <= 3; index++ {
		events = append(events, mustMongoRaw(t, bson.D{
			{Key: "operationType", Value: "insert"},
			{Key: "ns", Value: bson.D{{Key: "db", Value: "app"}, {Key: "coll", Value: "orders"}}},
			{Key: "documentKey", Value: bson.D{{Key: "_id", Value: index}}},
			{Key: "fullDocument", Value: bson.D{{Key: "_id", Value: index}, {Key: "value", Value: index}}},
			{Key: "clusterTime", Value: bson.Timestamp{T: uint32(100 + index), I: 1}},
		}))
		tokens = append(tokens, mustMongoRaw(t, bson.D{{Key: "_data", Value: fmt.Sprintf("token-%d", index)}}))
	}
	cursor := &bufferedFakeMongoCursor{fakeMongoCursor: &fakeMongoCursor{events: events, tokens: tokens}}
	stream := newMongoDBStream(&fakeMongoConnection{cursor: cursor}, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
	defer stream.Close()

	transaction, err := stream.Next(context.Background())
	if err != nil {
		t.Fatalf("next buffered transaction: %v", err)
	}
	if len(transaction.Events) != 3 {
		t.Fatalf("buffered events = %d, want 3", len(transaction.Events))
	}
	for index, event := range transaction.Events {
		encodedID, ok := event.Key["_id"].(map[string]interface{})
		if !ok || encodedID["$numberInt"] != fmt.Sprint(index+1) {
			t.Fatalf("event %d key = %#v", index, event.Key)
		}
	}
	intermediate, err := mongoResumeTokenPosition("scope-1", tokens[0])
	if err != nil {
		t.Fatalf("build intermediate position: %v", err)
	}
	if err := stream.Acknowledge(context.Background(), intermediate); err == nil {
		t.Fatal("buffered delivery accepted a non-final position")
	}
	if err := stream.Acknowledge(context.Background(), transaction.Position); err != nil {
		t.Fatalf("acknowledge final buffered position: %v", err)
	}
	expectedPosition, err := mongoResumeTokenPosition("scope-1", tokens[2])
	if err != nil {
		t.Fatalf("build final position: %v", err)
	}
	expectedIdentity, _ := mongoPositionIdentity(expectedPosition)
	actualIdentity, _ := mongoPositionIdentity(transaction.Position)
	if actualIdentity != expectedIdentity {
		t.Fatalf("transaction position = %s, want final %s", actualIdentity, expectedIdentity)
	}
}

func TestMongoStreamRejectsOutOfScopeEvent(t *testing.T) {
	tests := []struct {
		name  string
		raw   bson.Raw
		error string
	}{
		{
			name: "out of scope",
			raw: mustMongoRaw(t, bson.D{
				{Key: "operationType", Value: "delete"},
				{Key: "ns", Value: bson.D{{Key: "db", Value: "other"}, {Key: "coll", Value: "orders"}}},
				{Key: "documentKey", Value: bson.D{{Key: "_id", Value: 1}}},
				{Key: "clusterTime", Value: bson.Timestamp{T: 100, I: 1}},
			}),
			error: "out-of-scope",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cursor := &fakeMongoCursor{
				events: []bson.Raw{test.raw},
				tokens: []bson.Raw{mustMongoRaw(t, bson.D{{Key: "_data", Value: "token"}})},
			}
			stream := newMongoDBStream(&fakeMongoConnection{}, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
			defer stream.Close()
			if _, err := stream.Next(context.Background()); err == nil || !strings.Contains(err.Error(), test.error) {
				t.Fatalf("error = %v, want substring %q", err, test.error)
			}
		})
	}
}

func TestMongoStreamDeliversUpdateLookupNullWithCheckpoint(t *testing.T) {
	cursor := &fakeMongoCursor{
		events: []bson.Raw{mustMongoRaw(t, bson.D{
			{Key: "operationType", Value: "update"},
			{Key: "ns", Value: bson.D{{Key: "db", Value: "app"}, {Key: "coll", Value: "orders"}}},
			{Key: "documentKey", Value: bson.D{{Key: "_id", Value: 1}}},
			{Key: "clusterTime", Value: bson.Timestamp{T: 100, I: 1}},
		})},
		tokens: []bson.Raw{mustMongoRaw(t, bson.D{{Key: "_data", Value: "update-without-full-document"}})},
	}
	stream := newMongoDBStream(&fakeMongoConnection{}, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
	defer stream.Close()
	transaction, err := stream.Next(context.Background())
	if err != nil {
		t.Fatalf("deliver updateLookup-null event: %v", err)
	}
	if len(transaction.Events) != 1 || transaction.Events[0].Operation != "update" || transaction.Events[0].After != nil {
		t.Fatalf("unexpected tombstone event: %+v", transaction)
	}
	if transaction.Position.Adapter == "" {
		t.Fatal("updateLookup-null event must carry a resumable checkpoint")
	}
	if err := stream.Acknowledge(context.Background(), transaction.Position); err != nil {
		t.Fatalf("acknowledge updateLookup-null checkpoint: %v", err)
	}
}

func TestMongoStreamNextIsCancelableAndCloseIsIdempotent(t *testing.T) {
	cursor := &fakeMongoCursor{block: true, nextStarted: make(chan struct{}, 1)}
	connection := &fakeMongoConnection{}
	stream := newMongoDBStream(connection, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
	result := make(chan error, 1)
	go func() {
		_, err := stream.Next(context.Background())
		result <- err
	}()
	select {
	case <-cursor.nextStarted:
	case <-time.After(time.Second):
		t.Fatal("Next did not reach the change-stream cursor")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("close stream: %v", err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrMongoDBStreamClosed) {
			t.Fatalf("Next error after Close = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel blocked Next")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	cursor.mu.Lock()
	closeCount := cursor.closed
	cursor.mu.Unlock()
	connection.mu.Lock()
	disconnectCount := connection.disconnects
	connection.mu.Unlock()
	if closeCount != 1 || disconnectCount != 1 {
		t.Fatalf("close count=%d disconnect count=%d", closeCount, disconnectCount)
	}
}

func TestMongoStreamCallerCancellationAndAcknowledgementValidation(t *testing.T) {
	cursor := &fakeMongoCursor{block: true}
	stream := newMongoDBStream(&fakeMongoConnection{}, cursor, []mongoNamespace{{Database: "app", Collection: "orders"}}, "scope-1")
	defer stream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := stream.Next(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled Next error = %v", err)
	}
	foreign, err := mongoOperationTimePosition("other-scope", bson.Timestamp{T: 1, I: 1})
	if err != nil {
		t.Fatalf("build foreign position: %v", err)
	}
	if err := stream.Acknowledge(context.Background(), foreign); err == nil || !strings.Contains(err.Error(), "different source") {
		t.Fatalf("foreign acknowledgement error = %v", err)
	}
}
