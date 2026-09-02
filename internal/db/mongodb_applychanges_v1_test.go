//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"errors"
	"io"
	"testing"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type fakeMongoV1ChangeCollection struct {
	calls      int
	deleteFn   func(context.Context, interface{}) (*mongo.DeleteResult, error)
	updateFn   func(context.Context, interface{}, interface{}) (*mongo.UpdateResult, error)
	insertMany func(context.Context, []interface{}) (*mongo.InsertManyResult, error)
}

func (f *fakeMongoV1ChangeCollection) DeleteOne(ctx context.Context, filter interface{}, _ ...*options.DeleteOptions) (*mongo.DeleteResult, error) {
	f.calls++
	if f.deleteFn != nil {
		return f.deleteFn(ctx, filter)
	}
	return &mongo.DeleteResult{DeletedCount: 1}, nil
}

func (f *fakeMongoV1ChangeCollection) UpdateOne(ctx context.Context, filter, update interface{}, _ ...*options.UpdateOptions) (*mongo.UpdateResult, error) {
	f.calls++
	if f.updateFn != nil {
		return f.updateFn(ctx, filter, update)
	}
	return &mongo.UpdateResult{MatchedCount: 1, ModifiedCount: 1}, nil
}

func (f *fakeMongoV1ChangeCollection) InsertMany(ctx context.Context, docs []interface{}, _ ...*options.InsertManyOptions) (*mongo.InsertManyResult, error) {
	f.calls++
	if f.insertMany != nil {
		return f.insertMany(ctx, docs)
	}
	return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, nil
}

func TestApplyMongoV1ChangesContextCancellationBeforeFirstWriteIsKnown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	collection := &fakeMongoV1ChangeCollection{}
	err := applyMongoV1ChangesContext(ctx, collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, context.Canceled) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("preflight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if collection.calls != 0 {
		t.Fatalf("driver calls = %d, want 0", collection.calls)
	}
}

func TestApplyMongoV1ChangesContextCancellationInFlightIsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	collection := &fakeMongoV1ChangeCollection{deleteFn: func(callCtx context.Context, _ interface{}) (*mongo.DeleteResult, error) {
		cancel()
		return nil, callCtx.Err()
	}}
	err := applyMongoV1ChangesContext(ctx, collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("in-flight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoV1ChangesContextFirstSemanticFailureIsKnown(t *testing.T) {
	semanticErr := errors.New("duplicate key")
	collection := &fakeMongoV1ChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
		return nil, semanticErr
	}}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, semanticErr) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("semantic failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoV1ChangesContextFailureAfterSuccessfulWriteIsUnknown(t *testing.T) {
	semanticErr := errors.New("validation failed")
	collection := &fakeMongoV1ChangeCollection{updateFn: func(context.Context, interface{}, interface{}) (*mongo.UpdateResult, error) {
		return nil, semanticErr
	}}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": 1}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": 2}, Values: map[string]interface{}{"name": "new"}}},
	})
	if !errors.Is(err, semanticErr) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("failure after delete = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoV1ChangesContextPartialInsertIsUnknown(t *testing.T) {
	insertErr := errors.New("bulk insert failed")
	collection := &fakeMongoV1ChangeCollection{insertMany: func(context.Context, []interface{}) (*mongo.InsertManyResult, error) {
		return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, insertErr
	}}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{Inserts: []map[string]interface{}{{"_id": 1}, {"_id": 2}}})
	if !errors.Is(err, insertErr) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("partial insert = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoV1ChangesContextLaterInsertBatchFailureIsUnknown(t *testing.T) {
	rows := make([]map[string]interface{}, defaultBatchInsertRows+1)
	for index := range rows {
		rows[index] = map[string]interface{}{"_id": index}
	}
	insertErr := errors.New("second batch failed")
	batch := 0
	collection := &fakeMongoV1ChangeCollection{insertMany: func(context.Context, []interface{}) (*mongo.InsertManyResult, error) {
		batch++
		if batch == 2 {
			return nil, insertErr
		}
		return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, nil
	}}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{Inserts: rows})
	if !errors.Is(err, insertErr) || !IsWriteOutcomeUnknown(err) || batch != 2 {
		t.Fatalf("later batch failure = %v, unknown=%t, batches=%d", err, IsWriteOutcomeUnknown(err), batch)
	}
}

func TestApplyMongoV1ChangesContextAmbiguousDriverErrorsAreUnknown(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "eof", err: io.EOF},
		{name: "write concern", err: mongo.WriteException{WriteConcernError: &mongo.WriteConcernError{Message: "acknowledgement lost"}}},
		{name: "bulk write concern", err: mongo.BulkWriteException{WriteConcernError: &mongo.WriteConcernError{Message: "bulk acknowledgement lost"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			collection := &fakeMongoV1ChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
				return nil, test.err
			}}
			err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
			if !IsWriteOutcomeUnknown(err) {
				t.Fatalf("ambiguous failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
			}
		})
	}
}

func TestApplyMongoV1ChangesContextNilWriteResultIsUnknown(t *testing.T) {
	collection := &fakeMongoV1ChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
		return nil, nil
	}}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("nil write result = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoV1ChangesContextSuccess(t *testing.T) {
	collection := &fakeMongoV1ChangeCollection{}
	err := applyMongoV1ChangesContext(context.Background(), collection, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": 1}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": 2}, Values: map[string]interface{}{"name": "new"}}},
		Inserts: []map[string]interface{}{{"_id": 3}},
	})
	if err != nil || collection.calls != 3 {
		t.Fatalf("successful changes = %v, calls=%d", err, collection.calls)
	}
}
