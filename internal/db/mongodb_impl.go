package db

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

type MongoDB struct {
	client      *mongo.Client
	database    string
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
}

func (m *MongoDB) getURI(config connection.ConnectionConfig) string {
	// mongodb://user:password@host:port/database?authSource=admin
	host := config.Host
	port := config.Port
	if port == 0 {
		port = 27017
	}

	uri := fmt.Sprintf("mongodb://%s:%d", host, port)

	if config.User != "" {
		encodedUser := url.QueryEscape(config.User)
		if config.Password != "" {
			encodedPass := url.QueryEscape(config.Password)
			uri = fmt.Sprintf("mongodb://%s:%s@%s:%d", encodedUser, encodedPass, host, port)
		} else {
			uri = fmt.Sprintf("mongodb://%s@%s:%d", encodedUser, host, port)
		}
	}

	// Add connection options
	params := []string{}
	timeout := getConnectTimeoutSeconds(config)
	params = append(params, fmt.Sprintf("connectTimeoutMS=%d", timeout*1000))
	params = append(params, fmt.Sprintf("serverSelectionTimeoutMS=%d", timeout*1000))

	// authSource: 优先使用 config.Database，为空时默认 admin
	authSource := "admin"
	if config.Database != "" {
		authSource = config.Database
	}
	params = append(params, fmt.Sprintf("authSource=%s", authSource))

	if len(params) > 0 {
		uri = uri + "/?" + strings.Join(params, "&")
	}

	return uri
}

func (m *MongoDB) Connect(config connection.ConnectionConfig) error {
	var uri string

	if config.UseSSH {
		logger.Infof("MongoDB 使用 SSH 连接：地址=%s:%d", config.Host, config.Port)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		m.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		uri = m.getURI(localConfig)
		logger.Infof("MongoDB 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		uri = m.getURI(config)
	}

	m.pingTimeout = getConnectTimeout(config)
	m.database = config.Database
	if m.database == "" {
		m.database = "admin"
	}

	clientOpts := options.Client().ApplyURI(uri)
	client, err := mongo.Connect(clientOpts)
	if err != nil {
		return fmt.Errorf("MongoDB 连接失败：%w", err)
	}
	m.client = client

	if err := m.Ping(); err != nil {
		return fmt.Errorf("MongoDB 连接验证失败：%w", err)
	}

	return nil
}

func (m *MongoDB) Close() error {
	if m.forwarder != nil {
		if err := m.forwarder.Close(); err != nil {
			logger.Warnf("关闭 MongoDB SSH 端口转发失败：%v", err)
		}
		m.forwarder = nil
	}

	if m.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return m.client.Disconnect(ctx)
	}
	return nil
}

func (m *MongoDB) Ping() error {
	if m.client == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return m.client.Ping(ctx, readpref.Primary())
}

// Query executes a MongoDB command and returns results
// Supports JSON format commands like: {"find": "collection", "filter": {}}
func (m *MongoDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return m.queryWithContext(ctx, query)
}

// QueryContext executes a MongoDB command with the given context for timeout control
func (m *MongoDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return m.queryWithContext(ctx, query)
}

func (m *MongoDB) queryWithContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.client == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("empty query")
	}

	// Parse JSON command
	var cmd bson.D
	if err := bson.UnmarshalExtJSON([]byte(query), true, &cmd); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON command: %w", err)
	}

	db := m.client.Database(m.database)
	var result bson.M
	if err := db.RunCommand(ctx, cmd).Decode(&result); err != nil {
		return nil, nil, err
	}

	// Convert result to standard format
	data := []map[string]interface{}{{"result": result}}
	columns := []string{"result"}

	// If result contains cursor with documents, extract them
	if cursor, ok := result["cursor"].(bson.M); ok {
		if batch, ok := cursor["firstBatch"].(bson.A); ok {
			data = make([]map[string]interface{}, 0, len(batch))
			columnSet := make(map[string]bool)
			for _, doc := range batch {
				if docMap, ok := doc.(bson.M); ok {
					row := make(map[string]interface{})
					for k, v := range docMap {
						row[k] = v
						columnSet[k] = true
					}
					data = append(data, row)
				}
			}
			columns = make([]string, 0, len(columnSet))
			for k := range columnSet {
				columns = append(columns, k)
			}
		}
	}

	return data, columns, nil
}

func (m *MongoDB) Exec(query string) (int64, error) {
	_, _, err := m.Query(query)
	if err != nil {
		return 0, err
	}
	return 1, nil
}

// ExecContext executes a MongoDB command with the given context for timeout control
func (m *MongoDB) ExecContext(ctx context.Context, query string) (int64, error) {
	_, _, err := m.QueryContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return 1, nil
}

func (m *MongoDB) GetDatabases() ([]string, error) {
	if m.client == nil {
		return nil, fmt.Errorf("connection not open")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dbs, err := m.client.ListDatabaseNames(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	return dbs, nil
}

func (m *MongoDB) GetTables(dbName string) ([]string, error) {
	if m.client == nil {
		return nil, fmt.Errorf("connection not open")
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

func (m *MongoDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("// MongoDB collection: %s.%s\n// MongoDB is schemaless - no CREATE statement available", dbName, tableName), nil
}

// GetColumns returns empty for MongoDB (schemaless)
func (m *MongoDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// MongoDB is schemaless, return empty
	return []connection.ColumnDefinition{}, nil
}

// GetAllColumns returns empty for MongoDB (schemaless)
func (m *MongoDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return []connection.ColumnDefinitionWithTable{}, nil
}

// GetIndexes returns indexes for a MongoDB collection
func (m *MongoDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if m.client == nil {
		return nil, fmt.Errorf("connection not open")
	}

	targetDB := dbName
	if targetDB == "" {
		targetDB = m.database
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	collection := m.client.Database(targetDB).Collection(tableName)
	cursor, err := collection.Indexes().List(ctx)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var indexes []connection.IndexDefinition
	for cursor.Next(ctx) {
		var idx bson.M
		if err := cursor.Decode(&idx); err != nil {
			continue
		}

		name := fmt.Sprintf("%v", idx["name"])
		unique := false
		if u, ok := idx["unique"].(bool); ok {
			unique = u
		}

		// Extract key fields
		if key, ok := idx["key"].(bson.M); ok {
			seq := 1
			for field := range key {
				nonUnique := 1
				if unique {
					nonUnique = 0
				}
				indexes = append(indexes, connection.IndexDefinition{
					Name:       name,
					ColumnName: field,
					NonUnique:  nonUnique,
					SeqInIndex: seq,
					IndexType:  "BTREE",
				})
				seq++
			}
		}
	}

	return indexes, nil
}

func (m *MongoDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// MongoDB doesn't have foreign keys
	return []connection.ForeignKeyDefinition{}, nil
}

func (m *MongoDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	// MongoDB doesn't have triggers in the traditional sense
	return []connection.TriggerDefinition{}, nil
}

// ApplyChanges implements batch changes for MongoDB
func (m *MongoDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if m.client == nil {
		return fmt.Errorf("connection not open")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	collection := m.client.Database(m.database).Collection(tableName)

	// Process deletes
	for _, pk := range changes.Deletes {
		filter := bson.M{}
		for k, v := range pk {
			filter[k] = v
		}
		if len(filter) > 0 {
			if _, err := collection.DeleteOne(ctx, filter); err != nil {
				return fmt.Errorf("delete error: %v", err)
			}
		}
	}

	// Process updates
	for _, update := range changes.Updates {
		filter := bson.M{}
		for k, v := range update.Keys {
			filter[k] = v
		}
		if len(filter) == 0 {
			return fmt.Errorf("update requires keys")
		}

		updateDoc := bson.M{"$set": bson.M{}}
		for k, v := range update.Values {
			updateDoc["$set"].(bson.M)[k] = v
		}

		if _, err := collection.UpdateOne(ctx, filter, updateDoc); err != nil {
			return fmt.Errorf("update error: %v", err)
		}
	}

	// Process inserts
	for _, row := range changes.Inserts {
		doc := bson.M{}
		for k, v := range row {
			doc[k] = v
		}
		if len(doc) > 0 {
			if _, err := collection.InsertOne(ctx, doc); err != nil {
				return fmt.Errorf("insert error: %v", err)
			}
		}
	}

	return nil
}
