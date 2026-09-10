//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type fakeMongoDecodeCursor struct {
	documents    []any
	decodeErrors map[int]error
	cursorErr    error
	nextIndex    int
	currentIndex int
	closed       bool
	closeErr     error
}

func (c *fakeMongoDecodeCursor) Next(context.Context) bool {
	if c.nextIndex >= len(c.documents) {
		return false
	}
	c.currentIndex = c.nextIndex
	c.nextIndex++
	return true
}

func (c *fakeMongoDecodeCursor) Decode(target any) error {
	if err := c.decodeErrors[c.currentIndex]; err != nil {
		return err
	}
	raw, err := bson.Marshal(c.documents[c.currentIndex])
	if err != nil {
		return err
	}
	return bson.Unmarshal(raw, target)
}

func (c *fakeMongoDecodeCursor) Err() error {
	return c.cursorErr
}

func (c *fakeMongoDecodeCursor) Close(context.Context) error {
	c.closed = true
	return c.closeErr
}

func TestDecodeMongoIndexCursorPreservesCompoundKeyOrder(t *testing.T) {
	wantColumns := []string{"tenant_id", "slug", "created_at"}
	for run := 0; run < 8; run++ {
		cursor := &fakeMongoDecodeCursor{documents: []any{
			bson.D{
				{Key: "name", Value: "tenant_slug_created"},
				{Key: "unique", Value: true},
				{Key: "key", Value: bson.D{
					{Key: "tenant_id", Value: int32(1)},
					{Key: "slug", Value: int32(-1)},
					{Key: "created_at", Value: int32(1)},
				}},
			},
		}}

		indexes, err := decodeMongoIndexCursor(context.Background(), cursor)
		if err != nil {
			t.Fatalf("run %d: decodeMongoIndexCursor failed: %v", run, err)
		}
		if len(indexes) != 3 {
			t.Fatalf("run %d: index rows = %d, want 3: %+v", run, len(indexes), indexes)
		}
		for i, index := range indexes {
			if index.Name != "tenant_slug_created" || index.ColumnName != wantColumns[i] || index.SeqInIndex != i+1 || index.NonUnique != 0 || index.IndexType != "BTREE" {
				t.Fatalf("run %d: index row %d = %+v", run, i, index)
			}
		}
	}
}

func TestDecodeMongoIndexCursorKeepsSingleColumnAndNonUnique(t *testing.T) {
	cursor := &fakeMongoDecodeCursor{documents: []any{
		bson.D{
			{Key: "name", Value: "email_1"},
			{Key: "key", Value: bson.D{{Key: "email", Value: int32(1)}}},
		},
		bson.D{
			{Key: "name", Value: "empty_keys"},
			{Key: "key", Value: bson.D{}},
		},
	}}

	indexes, err := decodeMongoIndexCursor(context.Background(), cursor)
	if err != nil {
		t.Fatalf("decodeMongoIndexCursor failed: %v", err)
	}
	if len(indexes) != 1 {
		t.Fatalf("index rows = %d, want 1: %+v", len(indexes), indexes)
	}
	got := indexes[0]
	if got.Name != "email_1" || got.ColumnName != "email" || got.SeqInIndex != 1 || got.NonUnique != 1 || got.IndexType != "BTREE" {
		t.Fatalf("single-column index = %+v", got)
	}
}

func TestBuildMongoIndexDefinitionsUsesUniqueAndKeyOrder(t *testing.T) {
	uniqueRows := buildMongoIndexDefinitions(mongoIndexMetadata{
		Name:   "uq_tenant_email",
		Unique: true,
		Key: bson.D{
			{Key: "tenant", Value: int32(1)},
			{Key: "email", Value: int32(1)},
		},
	})
	if len(uniqueRows) != 2 {
		t.Fatalf("unique rows = %d, want 2", len(uniqueRows))
	}
	if uniqueRows[0].ColumnName != "tenant" || uniqueRows[0].SeqInIndex != 1 || uniqueRows[0].NonUnique != 0 {
		t.Fatalf("unique first column = %+v", uniqueRows[0])
	}
	if uniqueRows[1].ColumnName != "email" || uniqueRows[1].SeqInIndex != 2 || uniqueRows[1].NonUnique != 0 {
		t.Fatalf("unique second column = %+v", uniqueRows[1])
	}

	emptyRows := buildMongoIndexDefinitions(mongoIndexMetadata{Name: "unused"})
	if len(emptyRows) != 0 {
		t.Fatalf("empty key rows = %+v, want none", emptyRows)
	}
}

func TestDecodeMongoIndexCursorReturnsDecodeAndCursorErrors(t *testing.T) {
	t.Run("decode error", func(t *testing.T) {
		decodeErr := errors.New("malformed index")
		cursor := &fakeMongoDecodeCursor{
			documents:    []any{bson.D{{Key: "name", Value: "broken"}}},
			decodeErrors: map[int]error{0: decodeErr},
		}

		indexes, err := decodeMongoIndexCursor(context.Background(), cursor)
		if !errors.Is(err, decodeErr) {
			t.Fatalf("decodeMongoIndexCursor error = %v, want %v", err, decodeErr)
		}
		if indexes != nil {
			t.Fatalf("decode failure returned partial indexes: %+v", indexes)
		}
	})

	t.Run("cursor error", func(t *testing.T) {
		cursorErr := errors.New("cursor terminated")
		cursor := &fakeMongoDecodeCursor{cursorErr: cursorErr}

		indexes, err := decodeMongoIndexCursor(context.Background(), cursor)
		if !errors.Is(err, cursorErr) {
			t.Fatalf("decodeMongoIndexCursor error = %v, want %v", err, cursorErr)
		}
		if indexes != nil {
			t.Fatalf("cursor failure returned partial indexes: %+v", indexes)
		}
	})
}

func TestMongoV1GetIndexesRequiresOpenConnection(t *testing.T) {
	indexes, err := (&MongoDBV1{}).GetIndexes("db", "coll")
	if err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetIndexes = %#v, %v", indexes, err)
	}
	if indexes != nil {
		t.Fatalf("closed connection returned indexes: %+v", indexes)
	}
}

func TestMongoV1GetIndexesPropagatesListError(t *testing.T) {
	client, err := mongo.NewClient(options.Client().ApplyURI("mongodb://127.0.0.1:1").
		SetConnectTimeout(50 * time.Millisecond).
		SetServerSelectionTimeout(50 * time.Millisecond))
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}

	indexes, err := (&MongoDBV1{client: client, database: "app"}).GetIndexes("", "users")
	if err == nil {
		t.Fatal("GetIndexes succeeded against unreachable server")
	}
	if indexes != nil {
		t.Fatalf("list failure returned indexes: %+v", indexes)
	}
}

func TestMongoV1GetIndexesPreservesCompoundKeyOrderAndUnique(t *testing.T) {
	original := listMongoCollectionIndexes
	t.Cleanup(func() { listMongoCollectionIndexes = original })

	cursor := &fakeMongoDecodeCursor{documents: []any{
		bson.D{
			{Key: "name", Value: "tenant_slug_created"},
			{Key: "unique", Value: true},
			{Key: "key", Value: bson.D{
				{Key: "tenant_id", Value: int32(1)},
				{Key: "slug", Value: int32(-1)},
				{Key: "created_at", Value: int32(1)},
			}},
		},
		bson.D{
			{Key: "name", Value: "email_1"},
			{Key: "key", Value: bson.D{{Key: "email", Value: int32(1)}}},
		},
	}}
	listMongoCollectionIndexes = func(ctx context.Context, collection *mongo.Collection) (mongoIndexCursor, error) {
		if collection.Database().Name() != "app" || collection.Name() != "users" {
			t.Fatalf("listed %s.%s, want app.users", collection.Database().Name(), collection.Name())
		}
		return cursor, nil
	}

	client, err := mongo.NewClient(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}
	indexes, err := (&MongoDBV1{client: client, database: "app"}).GetIndexes("", "users")
	if err != nil {
		t.Fatalf("GetIndexes failed: %v", err)
	}
	if !cursor.closed {
		t.Fatal("index cursor was not closed")
	}
	if len(indexes) != 4 {
		t.Fatalf("index rows = %d, want 4: %+v", len(indexes), indexes)
	}

	want := []connection.IndexDefinition{
		{Name: "tenant_slug_created", ColumnName: "tenant_id", NonUnique: 0, SeqInIndex: 1, IndexType: "BTREE"},
		{Name: "tenant_slug_created", ColumnName: "slug", NonUnique: 0, SeqInIndex: 2, IndexType: "BTREE"},
		{Name: "tenant_slug_created", ColumnName: "created_at", NonUnique: 0, SeqInIndex: 3, IndexType: "BTREE"},
		{Name: "email_1", ColumnName: "email", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
	}
	for i, index := range indexes {
		if index != want[i] {
			t.Fatalf("index row %d = %+v, want %+v", i, index, want[i])
		}
	}
}

func TestMongoV1GetIndexesReturnsStubbedListError(t *testing.T) {
	original := listMongoCollectionIndexes
	t.Cleanup(func() { listMongoCollectionIndexes = original })

	listErr := errors.New("list indexes failed")
	listMongoCollectionIndexes = func(context.Context, *mongo.Collection) (mongoIndexCursor, error) {
		return nil, listErr
	}

	client, err := mongo.NewClient(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}
	indexes, err := (&MongoDBV1{client: client, database: "app"}).GetIndexes("crm", "accounts")
	if !errors.Is(err, listErr) {
		t.Fatalf("GetIndexes error = %v, want %v", err, listErr)
	}
	if indexes != nil {
		t.Fatalf("list failure returned indexes: %+v", indexes)
	}
}
