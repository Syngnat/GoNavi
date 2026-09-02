//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"errors"
	"io"
	"testing"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type fakeMongoChangeCollection struct {
	calls      int
	deleteFn   func(context.Context, interface{}) (*mongo.DeleteResult, error)
	updateFn   func(context.Context, interface{}, interface{}) (*mongo.UpdateResult, error)
	insertMany func(context.Context, []interface{}) (*mongo.InsertManyResult, error)
}

func (f *fakeMongoChangeCollection) DeleteOne(ctx context.Context, filter interface{}, _ ...options.Lister[options.DeleteOneOptions]) (*mongo.DeleteResult, error) {
	f.calls++
	if f.deleteFn != nil {
		return f.deleteFn(ctx, filter)
	}
	return &mongo.DeleteResult{DeletedCount: 1}, nil
}

func (f *fakeMongoChangeCollection) UpdateOne(ctx context.Context, filter, update interface{}, _ ...options.Lister[options.UpdateOneOptions]) (*mongo.UpdateResult, error) {
	f.calls++
	if f.updateFn != nil {
		return f.updateFn(ctx, filter, update)
	}
	return &mongo.UpdateResult{MatchedCount: 1, ModifiedCount: 1}, nil
}

func (f *fakeMongoChangeCollection) InsertMany(ctx context.Context, documents interface{}, _ ...options.Lister[options.InsertManyOptions]) (*mongo.InsertManyResult, error) {
	f.calls++
	docs, ok := documents.([]interface{})
	if !ok {
		return nil, errors.New("unexpected InsertMany documents type")
	}
	if f.insertMany != nil {
		return f.insertMany(ctx, docs)
	}
	return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, nil
}

func TestApplyMongoChangesContextCancellationBeforeFirstWriteIsKnown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	collection := &fakeMongoChangeCollection{}
	err := applyMongoChangesContext(ctx, collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, context.Canceled) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("preflight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if collection.calls != 0 {
		t.Fatalf("driver calls = %d, want 0", collection.calls)
	}
}

func TestApplyMongoChangesContextCancellationInFlightIsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	collection := &fakeMongoChangeCollection{deleteFn: func(callCtx context.Context, _ interface{}) (*mongo.DeleteResult, error) {
		cancel()
		return nil, callCtx.Err()
	}}
	err := applyMongoChangesContext(ctx, collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("in-flight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoChangesContextFirstSemanticFailureIsKnown(t *testing.T) {
	semanticErr := errors.New("duplicate key")
	collection := &fakeMongoChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
		return nil, semanticErr
	}}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !errors.Is(err, semanticErr) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("semantic failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoChangesContextFailureAfterSuccessfulWriteIsUnknown(t *testing.T) {
	semanticErr := errors.New("validation failed")
	collection := &fakeMongoChangeCollection{updateFn: func(context.Context, interface{}, interface{}) (*mongo.UpdateResult, error) {
		return nil, semanticErr
	}}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": 1}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": 2}, Values: map[string]interface{}{"name": "new"}}},
	})
	if !errors.Is(err, semanticErr) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("failure after delete = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoChangesContextPartialInsertIsUnknown(t *testing.T) {
	insertErr := errors.New("bulk insert failed")
	collection := &fakeMongoChangeCollection{insertMany: func(context.Context, []interface{}) (*mongo.InsertManyResult, error) {
		return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, insertErr
	}}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{Inserts: []map[string]interface{}{{"_id": 1}, {"_id": 2}}})
	if !errors.Is(err, insertErr) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("partial insert = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoChangesContextLaterInsertBatchFailureIsUnknown(t *testing.T) {
	rows := make([]map[string]interface{}, defaultBatchInsertRows+1)
	for index := range rows {
		rows[index] = map[string]interface{}{"_id": index}
	}
	insertErr := errors.New("second batch failed")
	batch := 0
	collection := &fakeMongoChangeCollection{insertMany: func(context.Context, []interface{}) (*mongo.InsertManyResult, error) {
		batch++
		if batch == 2 {
			return nil, insertErr
		}
		return &mongo.InsertManyResult{InsertedIDs: []interface{}{1}}, nil
	}}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{Inserts: rows})
	if !errors.Is(err, insertErr) || !IsWriteOutcomeUnknown(err) || batch != 2 {
		t.Fatalf("later batch failure = %v, unknown=%t, batches=%d", err, IsWriteOutcomeUnknown(err), batch)
	}
}

func TestApplyMongoChangesContextAmbiguousDriverErrorsAreUnknown(t *testing.T) {
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
			collection := &fakeMongoChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
				return nil, test.err
			}}
			err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
			if !IsWriteOutcomeUnknown(err) {
				t.Fatalf("ambiguous failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
			}
		})
	}
}

func TestApplyMongoChangesContextNilWriteResultIsUnknown(t *testing.T) {
	collection := &fakeMongoChangeCollection{deleteFn: func(context.Context, interface{}) (*mongo.DeleteResult, error) {
		return nil, nil
	}}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": 1}}})
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("nil write result = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyMongoChangesContextSuccess(t *testing.T) {
	collection := &fakeMongoChangeCollection{}
	err := applyMongoChangesContext(context.Background(), collection, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": 1}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": 2}, Values: map[string]interface{}{"name": "new"}}},
		Inserts: []map[string]interface{}{{"_id": 3}},
	})
	if err != nil || collection.calls != 3 {
		t.Fatalf("successful changes = %v, calls=%d", err, collection.calls)
	}
}
