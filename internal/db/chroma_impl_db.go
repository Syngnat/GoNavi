package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

func (c *ChromaDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = c.Close()
	defer func() {
		if err != nil {
			_ = c.Close()
		}
	}()

	runConfig := normalizeChromaConfig(config)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		c.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Chroma 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	c.tenant = chromaTenantFromConfig(runConfig)
	c.database = chromaDatabaseFromConfig(runConfig)
	c.baseURL = buildChromaBaseURL(runConfig)
	c.authHeaders = chromaAuthHeaders(runConfig)
	c.client = buildChromaHTTPClient(runConfig)

	if err := c.Ping(); err != nil {
		_ = c.Close()
		return err
	}
	return nil
}

func (c *ChromaDB) Close() error {
	if c.forwarder != nil {
		if err := c.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Chroma SSH 端口转发失败：%v", err)
		}
		c.forwarder = nil
	}
	c.client = nil
	return nil
}

func (c *ChromaDB) Ping() error {
	if c.client == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(c), 10*time.Second)
	defer cancel()

	if err := c.detectVersion(ctx); err != nil {
		return err
	}
	return nil
}

func (c *ChromaDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(metadataContextFor(c), defaultChromaQueryTimeout)
	defer cancel()
	return c.QueryContext(ctx, query)
}

func (c *ChromaDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if c.client == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}

	if strings.HasPrefix(text, "{") {
		return c.queryJSON(ctx, text)
	}

	if parsed, ok := parseChromaSQL(text); ok {
		if parsed.WhereError != nil {
			return nil, nil, fmt.Errorf("Chroma WHERE 解析失败：%w", parsed.WhereError)
		}
		if parsed.Count {
			total, err := c.countCollection(ctx, parsed.Collection, parsed.Where)
			if err != nil {
				return nil, nil, err
			}
			return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
		}
		include := []string{"documents", "metadatas"}
		if parsed.IncludeEmbeddings {
			include = append(include, "embeddings")
		}
		return c.getCollectionRows(ctx, parsed.Collection, parsed.Limit, parsed.Offset, parsed.Where, include)
	}

	return nil, nil, fmt.Errorf("Chroma 查询仅支持 JSON 命令或简单 SELECT 预览")
}

func (c *ChromaDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultChromaQueryTimeout)
	defer cancel()
	return c.ExecContext(ctx, query)
}

func (c *ChromaDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if c.client == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(strings.TrimSpace(query)), &cmd); err != nil {
		return 0, fmt.Errorf("Chroma 写入命令必须是 JSON：%w", err)
	}
	if name := firstStringValue(cmd, "create_collection", "createCollection", "collection"); name != "" && hasAnyKey(cmd, "create_collection", "createCollection") {
		body := map[string]interface{}{"name": name}
		if metadata, ok := cmd["metadata"]; ok {
			body["metadata"] = metadata
		}
		if getOrBool(cmd, "get_or_create", "getOrCreate") {
			body["get_or_create"] = true
		}
		return 1, c.createCollection(ctx, body)
	}
	if name := firstStringValue(cmd, "delete_collection", "deleteCollection"); name != "" {
		return 1, c.deleteCollection(ctx, name)
	}
	if name := firstStringValue(cmd, "upsert", "collection"); name != "" && hasAnyKey(cmd, "upsert") {
		return c.upsertCommand(ctx, name, cmd)
	}
	if name := firstStringValue(cmd, "delete", "collection"); name != "" && hasAnyKey(cmd, "delete") {
		return c.deleteCommand(ctx, name, cmd)
	}
	return 0, fmt.Errorf("Chroma JSON 写入命令仅支持 create_collection/delete_collection/upsert/delete")
}

func (c *ChromaDB) GetDatabases() ([]string, error) {
	if c.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(c), 10*time.Second)
	defer cancel()
	if err := c.ensureVersion(ctx); err != nil {
		return nil, err
	}
	if c.apiVersion != 2 {
		return []string{c.database}, nil
	}

	var raw []map[string]interface{}
	err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v2/tenants/%s/databases", url.PathEscape(c.tenant)), nil, &raw)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(raw))
	for _, item := range raw {
		if name := mapString(item, "name"); name != "" {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		names = append(names, c.database)
	}
	sort.Strings(names)
	return names, nil
}

func (c *ChromaDB) GetTables(dbName string) ([]string, error) {
	collections, err := c.listCollections(metadataContextFor(c), dbName)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(collections))
	for _, item := range collections {
		if strings.TrimSpace(item.Name) != "" {
			names = append(names, item.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (c *ChromaDB) GetCreateStatement(dbName, tableName string) (string, error) {
	coll, err := c.resolveCollection(metadataContextFor(c), dbName, tableName)
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(coll, "", "  ")
	return fmt.Sprintf("// Chroma collection: %s\n%s", coll.Name, string(payload)), nil
}

func (c *ChromaDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// Chroma does not expose a collection-level schema for arbitrary metadata keys.
	// Keep metadata inspection side-effect free: sampling documents would implicitly
	// expose user data and embeddings while opening the fields node.
	if _, err := c.resolveCollection(metadataContextFor(c), dbName, tableName); err != nil {
		return nil, err
	}
	return []connection.ColumnDefinition{
		{Name: "id", Type: "string", Nullable: "NO", Key: "PRI", Comment: "Chroma document id"},
		{Name: "document", Type: "text", Nullable: "YES", Comment: "Document text"},
		{Name: "metadata", Type: "json", Nullable: "YES", Comment: "Full metadata object"},
		{Name: "embedding", Type: "vector<float>", Nullable: "YES", Comment: "Embedding vector"},
	}, nil
}

func (c *ChromaDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := c.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		cols, err := c.GetColumns(dbName, table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
			continue
		}
		for _, col := range cols {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
				Comment:   col.Comment,
			})
		}
	}
	return result, NewPartialMetadataError(failures)
}

func (c *ChromaDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{
		{Name: "PRIMARY", ColumnName: "id", NonUnique: 0, SeqInIndex: 1, IndexType: "PRIMARY"},
		{Name: "HNSW", ColumnName: "embedding", NonUnique: 1, SeqInIndex: 1, IndexType: "VECTOR"},
	}, nil
}

func (c *ChromaDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (c *ChromaDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (c *ChromaDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return c.ApplyChangesContext(context.Background(), tableName, changes)
}

func (c *ChromaDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	ctx, cancel := context.WithTimeout(ctx, defaultChromaQueryTimeout)
	defer cancel()
	writeApplied := false
	writeError := func(err error) error {
		if writeApplied {
			return MarkWriteOutcomeUnknown(err)
		}
		return err
	}

	if len(changes.Deletes) > 0 {
		ids := make([]string, 0, len(changes.Deletes))
		for _, row := range changes.Deletes {
			if id := chromaRowID(row); id != "" {
				ids = append(ids, id)
			}
		}
		if len(ids) != len(changes.Deletes) {
			return fmt.Errorf("Chroma 删除行缺少 id")
		}
		if len(ids) > 0 {
			if _, err := c.deleteCommand(ctx, tableName, map[string]interface{}{"ids": ids}); err != nil {
				return writeError(err)
			}
			writeApplied = true
		}
	}

	if len(changes.Updates) > 0 {
		rows := make([]map[string]interface{}, 0, len(changes.Updates))
		for _, update := range changes.Updates {
			row := make(map[string]interface{}, len(update.Keys)+len(update.Values))
			for k, v := range update.Keys {
				row[k] = v
			}
			for k, v := range update.Values {
				row[k] = v
			}
			rows = append(rows, row)
		}
		if err := c.upsertRows(ctx, tableName, rows); err != nil {
			return writeError(err)
		}
		writeApplied = true
	}
	if len(changes.Inserts) > 0 {
		if err := c.upsertRows(ctx, tableName, changes.Inserts); err != nil {
			return writeError(err)
		}
	}
	return nil
}
