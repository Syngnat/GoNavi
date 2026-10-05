//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
)

func copyMongoChangeDocument(row map[string]interface{}) bson.M {
	doc := bson.M{}
	for k, v := range row {
		doc[k] = decodeMongoExtendedJSONFieldValue(v)
	}
	return doc
}

func buildMongoChangeFilter(row map[string]interface{}) bson.M {
	filter := bson.M{}
	for k, v := range row {
		filter[k] = decodeMongoExtendedJSONFieldValue(v)
	}
	return filter
}

// ApplyChanges implements batch changes for MongoDB
func (m *MongoDBV1) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return m.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext applies batch changes while allowing cancellation to
// reach the MongoDB driver calls already in flight.
func (m *MongoDBV1) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if m.client == nil {
		return fmt.Errorf("连接未打开")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	collection := m.client.Database(m.database).Collection(tableName)
	return applyMongoV1ChangesContext(ctx, collection, changes)
}

func applyMongoV1ChangesContext(ctx context.Context, collection mongoV1ChangeCollection, changes connection.ChangeSet) error {
	writeApplied := false

	// Process deletes
	for _, pk := range changes.Deletes {
		filter := buildMongoChangeFilter(pk)
		if len(filter) > 0 {
			if err := mongoV1WritePreflightError(ctx, writeApplied); err != nil {
				return err
			}
			result, err := collection.DeleteOne(ctx, filter)
			if err != nil {
				return classifyMongoV1WriteError(ctx, fmt.Errorf("删除失败：%w", err), writeApplied)
			}
			if result == nil {
				return MarkWriteOutcomeUnknown(errors.New("删除失败：MongoDB 未返回写入结果"))
			}
			if result.DeletedCount == 0 {
				err := errors.New("删除失败：未匹配到文档")
				if writeApplied {
					return MarkWriteOutcomeUnknown(err)
				}
				return err
			}
			writeApplied = true
		}
	}

	// Process updates
	for _, update := range changes.Updates {
		filter := buildMongoChangeFilter(update.Keys)
		if len(filter) == 0 {
			err := errors.New("更新操作需要主键条件")
			if writeApplied {
				return MarkWriteOutcomeUnknown(err)
			}
			return err
		}

		updateDoc := bson.M{"$set": copyMongoChangeDocument(update.Values)}

		if err := mongoV1WritePreflightError(ctx, writeApplied); err != nil {
			return err
		}
		result, err := collection.UpdateOne(ctx, filter, updateDoc)
		if err != nil {
			return classifyMongoV1WriteError(ctx, fmt.Errorf("更新失败：%w", err), writeApplied)
		}
		if result == nil {
			return MarkWriteOutcomeUnknown(errors.New("更新失败：MongoDB 未返回写入结果"))
		}
		if result.MatchedCount == 0 {
			err := errors.New("更新失败：未匹配到文档")
			if writeApplied {
				return MarkWriteOutcomeUnknown(err)
			}
			return err
		}
		writeApplied = true
	}

	if err := insertMongoV1Documents(ctx, collection, changes.Inserts, &writeApplied); err != nil {
		return err
	}

	return nil
}

func insertMongoV1Documents(ctx context.Context, collection mongoV1ChangeCollection, rows []map[string]interface{}, writeApplied *bool) error {
	if len(rows) == 0 {
		return nil
	}

	docs := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		doc := copyMongoChangeDocument(row)
		if len(doc) > 0 {
			docs = append(docs, doc)
		}
	}
	if len(docs) == 0 {
		return nil
	}

	for start := 0; start < len(docs); start += defaultBatchInsertRows {
		end := start + defaultBatchInsertRows
		if end > len(docs) {
			end = len(docs)
		}
		if err := mongoV1WritePreflightError(ctx, *writeApplied); err != nil {
			return err
		}
		result, err := collection.InsertMany(ctx, docs[start:end])
		if err != nil {
			wrapped := fmt.Errorf("插入失败：%w", err)
			if result != nil && len(result.InsertedIDs) > 0 {
				return MarkWriteOutcomeUnknown(wrapped)
			}
			return classifyMongoV1WriteError(ctx, wrapped, *writeApplied)
		}
		if result == nil {
			return MarkWriteOutcomeUnknown(errors.New("插入失败：MongoDB 未返回写入结果"))
		}
		*writeApplied = true
	}
	return nil
}

func mongoV1WritePreflightError(ctx context.Context, writeApplied bool) error {
	if ctx == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		if writeApplied {
			return MarkWriteOutcomeUnknown(err)
		}
		return err
	}
	return nil
}

func classifyMongoV1WriteError(ctx context.Context, err error, writeApplied bool) error {
	if writeApplied || IsAmbiguousWriteResponse(err) || mongoV1WriteConcernFailed(err) || (ctx != nil && ctx.Err() != nil) {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

func mongoV1WriteConcernFailed(err error) bool {
	var writeException mongo.WriteException
	if errors.As(err, &writeException) && writeException.WriteConcernError != nil {
		return true
	}
	var writeExceptionPointer *mongo.WriteException
	if errors.As(err, &writeExceptionPointer) && writeExceptionPointer.WriteConcernError != nil {
		return true
	}
	var bulkWriteException mongo.BulkWriteException
	if errors.As(err, &bulkWriteException) && bulkWriteException.WriteConcernError != nil {
		return true
	}
	var bulkWriteExceptionPointer *mongo.BulkWriteException
	return errors.As(err, &bulkWriteExceptionPointer) && bulkWriteExceptionPointer.WriteConcernError != nil
}
