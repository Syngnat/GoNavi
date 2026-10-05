//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"fmt"
	"time"

	"GoNavi-Wails/internal/connection"

	"go.mongodb.org/mongo-driver/bson"
)

func (m *MongoDBV1) Exec(query string) (int64, error) {
	_, _, err := m.Query(query)
	if err != nil {
		return 0, err
	}
	return 1, nil
}

// ExecContext executes a MongoDB command with the given context for timeout control
func (m *MongoDBV1) ExecContext(ctx context.Context, query string) (int64, error) {
	_, _, err := m.QueryContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return 1, nil
}

func (m *MongoDBV1) GetDatabases() ([]string, error) {
	if m.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dbs, err := m.client.ListDatabaseNames(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	return dbs, nil
}

func (m *MongoDBV1) GetTables(dbName string) ([]string, error) {
	if m.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	targetDB := dbName
	if targetDB == "" {
		targetDB = m.database
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	collections, err := m.client.Database(targetDB).ListCollectionNames(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	return collections, nil
}

func (m *MongoDBV1) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("// MongoDB collection: %s.%s\n// MongoDB is schemaless - no CREATE statement available", dbName, tableName), nil
}

// GetColumns returns empty for MongoDB (schemaless)
func (m *MongoDBV1) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// MongoDB is schemaless, return empty
	return []connection.ColumnDefinition{}, nil
}

// GetAllColumns returns empty for MongoDB (schemaless)
func (m *MongoDBV1) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return []connection.ColumnDefinitionWithTable{}, nil
}

// GetIndexes returns indexes for a MongoDB collection
func (m *MongoDBV1) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if m.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	targetDB := dbName
	if targetDB == "" {
		targetDB = m.database
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	collection := m.client.Database(targetDB).Collection(tableName)
	cursor, err := listMongoCollectionIndexes(ctx, collection)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	return decodeMongoIndexCursor(ctx, cursor)
}

func decodeMongoIndexCursor(ctx context.Context, cursor mongoCursorDecoder) ([]connection.IndexDefinition, error) {
	var indexes []connection.IndexDefinition
	indexNumber := 0
	for cursor.Next(ctx) {
		indexNumber++
		var idx mongoIndexMetadata
		if err := cursor.Decode(&idx); err != nil {
			return nil, fmt.Errorf("decode MongoDB index %d: %w", indexNumber, err)
		}
		indexes = append(indexes, buildMongoIndexDefinitions(idx)...)
	}

	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("iterate MongoDB indexes: %w", err)
	}
	return indexes, nil
}

func buildMongoIndexDefinitions(idx mongoIndexMetadata) []connection.IndexDefinition {
	indexes := make([]connection.IndexDefinition, 0, len(idx.Key))
	nonUnique := 1
	if idx.Unique {
		nonUnique = 0
	}
	name := fmt.Sprintf("%v", idx.Name)
	for position, key := range idx.Key {
		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: key.Key,
			NonUnique:  nonUnique,
			SeqInIndex: position + 1,
			IndexType:  "BTREE",
		})
	}
	return indexes
}

func (m *MongoDBV1) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// MongoDB doesn't have foreign keys
	return []connection.ForeignKeyDefinition{}, nil
}

func (m *MongoDBV1) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	// MongoDB doesn't have triggers in the traditional sense
	return []connection.TriggerDefinition{}, nil
}
