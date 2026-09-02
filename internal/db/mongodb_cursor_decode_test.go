//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"errors"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type fakeMongoDecodeCursor struct {
	documents    []any
	decodeErrors map[int]error
	cursorErr    error
	nextIndex    int
	currentIndex int
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

func TestDecodeMongoFindCursorReturnsDecodeError(t *testing.T) {
	decodeErr := errors.New("malformed document")
	cursor := &fakeMongoDecodeCursor{
		documents:    []any{bson.D{{Key: "_id", Value: 1}}},
		decodeErrors: map[int]error{0: decodeErr},
	}

	rows, columns, err := decodeMongoFindCursor(context.Background(), cursor, false)
	if !errors.Is(err, decodeErr) {
		t.Fatalf("decodeMongoFindCursor error = %v, want %v", err, decodeErr)
	}
	if rows != nil || columns != nil {
		t.Fatalf("decode failure returned partial result rows=%v columns=%v", rows, columns)
	}
}

func TestDecodeMongoIndexCursorPreservesCompoundKeyOrder(t *testing.T) {
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
		t.Fatalf("decodeMongoIndexCursor failed: %v", err)
	}
	if len(indexes) != 3 {
		t.Fatalf("index rows = %d, want 3: %+v", len(indexes), indexes)
	}
	wantColumns := []string{"tenant_id", "slug", "created_at"}
	for i, index := range indexes {
		if index.Name != "tenant_slug_created" || index.ColumnName != wantColumns[i] || index.SeqInIndex != i+1 || index.NonUnique != 0 {
			t.Fatalf("index row %d = %+v", i, index)
		}
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
