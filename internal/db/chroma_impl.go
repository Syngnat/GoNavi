package db

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultChromaPort         = 8000
	defaultChromaTenant       = "default_tenant"
	defaultChromaDatabase     = "default_database"
	defaultChromaQueryTimeout = 30 * time.Second
)

type ChromaDB struct {
	client      *http.Client
	baseURL     string
	tenant      string
	database    string
	apiVersion  int
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
}

type chromaCollection struct {
	ID        string                 `json:"id"`
	Name      string                 `json:"name"`
	Metadata  map[string]interface{} `json:"metadata"`
	Dimension int                    `json:"dimension"`
	Tenant    string                 `json:"tenant"`
	Database  string                 `json:"database"`
}

type chromaGetResponse struct {
	IDs        []string                 `json:"ids"`
	Documents  []interface{}            `json:"documents"`
	Metadatas  []map[string]interface{} `json:"metadatas"`
	Embeddings []interface{}            `json:"embeddings"`
	Included   []string                 `json:"included"`
}

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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := c.detectVersion(ctx); err != nil {
		return err
	}
	return nil
}

func (c *ChromaDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultChromaQueryTimeout)
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
		return []string{c.database}, nil
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
	collections, err := c.listCollections(context.Background(), dbName)
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
	coll, err := c.resolveCollection(context.Background(), dbName, tableName)
	if err != nil {
		return "", err
	}
	payload, _ := json.MarshalIndent(coll, "", "  ")
	return fmt.Sprintf("// Chroma collection: %s\n%s", coll.Name, string(payload)), nil
}

func (c *ChromaDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	rows, _, err := c.getCollectionRows(context.Background(), tableNameOrDB(dbName, tableName), 20, 0, nil, []string{"documents", "metadatas", "embeddings"})
	if err != nil {
		return nil, err
	}
	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "string", Nullable: "NO", Key: "PRI", Comment: "Chroma document id"},
		{Name: "document", Type: "text", Nullable: "YES", Comment: "Document text"},
		{Name: "metadata", Type: "json", Nullable: "YES", Comment: "Full metadata object"},
		{Name: "embedding", Type: "vector<float>", Nullable: "YES", Comment: "Embedding vector"},
	}
	seen := map[string]struct{}{"id": {}, "document": {}, "metadata": {}, "embedding": {}}
	for _, row := range rows {
		for key, value := range row {
			if _, exists := seen[key]; exists || !strings.HasPrefix(key, "metadata.") {
				continue
			}
			seen[key] = struct{}{}
			cols = append(cols, connection.ColumnDefinition{
				Name:     key,
				Type:     inferChromaValueType(value),
				Nullable: "YES",
				Comment:  "Metadata field",
			})
		}
	}
	return cols, nil
}

func (c *ChromaDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := c.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		cols, err := c.GetColumns(dbName, table)
		if err != nil {
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
	return result, nil
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
	ctx, cancel := context.WithTimeout(context.Background(), defaultChromaQueryTimeout)
	defer cancel()

	if len(changes.Deletes) > 0 {
		ids := make([]string, 0, len(changes.Deletes))
		for _, row := range changes.Deletes {
			if id := chromaRowID(row); id != "" {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			if _, err := c.deleteCommand(ctx, tableName, map[string]interface{}{"ids": ids}); err != nil {
				return err
			}
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
			return err
		}
	}
	if len(changes.Inserts) > 0 {
		if err := c.upsertRows(ctx, tableName, changes.Inserts); err != nil {
			return err
		}
	}
	return nil
}

func normalizeChromaConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyChromaURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultChromaPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyChromaURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "http" && scheme != "https" && scheme != "chroma" {
		return config
	}
	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if h, port, ok := parseHostPortWithDefault(host, defaultChromaPort); ok {
			config.Host = h
			config.Port = port
		}
	}
	if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && !strings.HasPrefix(dbName, "api/") && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	return config
}

func buildChromaBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, strings.TrimSpace(config.Host), config.Port)
}

func chromaTenantFromConfig(config connection.ConnectionConfig) string {
	params := chromaConnectionParams(config)
	if tenant := strings.TrimSpace(params.Get("tenant")); tenant != "" {
		return tenant
	}
	return defaultChromaTenant
}

func chromaDatabaseFromConfig(config connection.ConnectionConfig) string {
	if dbName := strings.TrimSpace(config.Database); dbName != "" {
		return dbName
	}
	params := chromaConnectionParams(config)
	if dbName := strings.TrimSpace(params.Get("database")); dbName != "" {
		return dbName
	}
	return defaultChromaDatabase
}

func chromaConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "http", "https", "chroma"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func chromaAuthHeaders(config connection.ConnectionConfig) map[string]string {
	headers := make(map[string]string)
	params := chromaConnectionParams(config)
	token := firstNonEmpty(params.Get("apiKey"), params.Get("apikey"), params.Get("token"), params.Get("authToken"))
	if token == "" && strings.TrimSpace(config.User) == "" {
		token = strings.TrimSpace(config.Password)
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	} else if user := strings.TrimSpace(config.User); user != "" {
		raw := user + ":" + config.Password
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
	}
	if headerName := strings.TrimSpace(params.Get("authHeader")); headerName != "" {
		if headerValue := strings.TrimSpace(params.Get("authHeaderValue")); headerValue != "" && isSafeConnectionParamKey(headerName) {
			headers[headerName] = headerValue
		}
	}
	return headers
}

func buildChromaHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyCfg := config.Proxy
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxyCfg, network, addr)
		}
	}
	return &http.Client{Transport: transport, Timeout: getConnectTimeout(config)}
}

func (c *ChromaDB) detectVersion(ctx context.Context) error {
	if c.client == nil {
		return fmt.Errorf("连接未打开")
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v2/heartbeat", nil, nil); err == nil {
		c.apiVersion = 2
		return nil
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/heartbeat", nil, nil); err == nil {
		c.apiVersion = 1
		return nil
	}
	return fmt.Errorf("Chroma 连接失败：无法访问 /api/v2/heartbeat 或 /api/v1/heartbeat")
}

func (c *ChromaDB) ensureVersion(ctx context.Context) error {
	if c.apiVersion == 1 || c.apiVersion == 2 {
		return nil
	}
	return c.detectVersion(ctx)
}

func (c *ChromaDB) doJSON(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if c.client == nil {
		return fmt.Errorf("连接未打开")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if strings.TrimSpace(c.authHeaders["Authorization"]) == "" && strings.TrimSpace(req.Header.Get("Authorization")) == "" {
		// Basic Auth remains useful for gateways even when Chroma itself uses token auth.
	}
	for key, value := range c.authHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}
	res, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message := strings.TrimSpace(string(resBody))
		if message == "" {
			message = res.Status
		}
		return fmt.Errorf("Chroma API %s %s 失败：%s", method, path, message)
	}
	if out == nil || len(bytes.TrimSpace(resBody)) == 0 {
		return nil
	}
	if err := decodeJSONWithUseNumber(resBody, out); err != nil {
		return fmt.Errorf("解析 Chroma 响应失败：%w", err)
	}
	return nil
}

func (c *ChromaDB) v2Path(dbName string, suffix string) string {
	database := strings.TrimSpace(dbName)
	if database == "" {
		database = c.database
	}
	base := fmt.Sprintf("/api/v2/tenants/%s/databases/%s", url.PathEscape(c.tenant), url.PathEscape(database))
	if suffix == "" {
		return base
	}
	return base + suffix
}

func (c *ChromaDB) listCollections(ctx context.Context, dbName string) ([]chromaCollection, error) {
	if c.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if err := c.ensureVersion(ctx); err != nil {
		return nil, err
	}
	var collections []chromaCollection
	path := "/api/v1/collections"
	if c.apiVersion == 2 {
		path = c.v2Path(dbName, "/collections")
	}
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &collections); err != nil {
		return nil, err
	}
	return collections, nil
}

func (c *ChromaDB) resolveCollection(ctx context.Context, dbName, tableName string) (chromaCollection, error) {
	name := tableNameOrDB(dbName, tableName)
	if name == "" {
		return chromaCollection{}, fmt.Errorf("collection 名称不能为空")
	}
	collections, err := c.listCollections(ctx, dbName)
	if err != nil {
		return chromaCollection{}, err
	}
	for _, item := range collections {
		if strings.EqualFold(item.Name, name) || strings.EqualFold(item.ID, name) {
			return item, nil
		}
	}
	return chromaCollection{}, fmt.Errorf("未找到 Chroma collection：%s", name)
}

func (c *ChromaDB) collectionActionPath(ctx context.Context, collectionName, action string) (string, error) {
	if err := c.ensureVersion(ctx); err != nil {
		return "", err
	}
	coll, err := c.resolveCollection(ctx, "", collectionName)
	if err != nil {
		return "", err
	}
	ident := coll.ID
	if strings.TrimSpace(ident) == "" {
		ident = coll.Name
	}
	if ident == "" {
		return "", fmt.Errorf("collection 标识为空")
	}
	if c.apiVersion == 2 {
		return c.v2Path(coll.Database, fmt.Sprintf("/collections/%s/%s", url.PathEscape(ident), action)), nil
	}
	return fmt.Sprintf("/api/v1/collections/%s/%s", url.PathEscape(ident), action), nil
}

func (c *ChromaDB) getCollectionRows(ctx context.Context, collection string, limit int, offset int, where interface{}, include []string) ([]map[string]interface{}, []string, error) {
	if limit <= 0 {
		limit = 200
	}
	path, err := c.collectionActionPath(ctx, collection, "get")
	if err != nil {
		return nil, nil, err
	}
	body := map[string]interface{}{
		"limit":   limit,
		"offset":  offset,
		"include": include,
	}
	if where != nil {
		body["where"] = where
	}
	var resp chromaGetResponse
	if err := c.doJSON(ctx, http.MethodPost, path, body, &resp); err != nil {
		return nil, nil, err
	}
	rows, columns := chromaGetResponseRows(resp)
	return rows, columns, nil
}

func (c *ChromaDB) countCollection(ctx context.Context, collection string, where interface{}) (int64, error) {
	path, err := c.collectionActionPath(ctx, collection, "count")
	if err != nil {
		return 0, err
	}
	if where == nil {
		var raw interface{}
		if err := c.doJSON(ctx, http.MethodGet, path, nil, &raw); err == nil {
			return chromaCountValue(raw), nil
		}
	}
	rows, _, err := c.getCollectionRows(ctx, collection, 1_000_000, 0, where, []string{"documents"})
	if err != nil {
		return 0, err
	}
	return int64(len(rows)), nil
}

func (c *ChromaDB) queryJSON(ctx context.Context, text string) ([]map[string]interface{}, []string, error) {
	var cmd map[string]interface{}
	if err := decodeJSONWithUseNumber([]byte(text), &cmd); err != nil {
		return nil, nil, fmt.Errorf("Chroma JSON 命令解析失败：%w", err)
	}
	if hasAnyKey(cmd, "list_collections", "listCollections") {
		cols, err := c.listCollections(ctx, "")
		if err != nil {
			return nil, nil, err
		}
		rows := make([]map[string]interface{}, 0, len(cols))
		for _, col := range cols {
			rows = append(rows, chromaStructRow(col))
		}
		return rows, collectColumns(rows), nil
	}
	if name := firstStringValue(cmd, "get", "collection"); name != "" && (hasAnyKey(cmd, "get") || !hasAnyKey(cmd, "query", "query_embeddings", "query_texts")) {
		limit := intFromAny(cmd["limit"], 200)
		offset := intFromAny(cmd["offset"], 0)
		include := stringSliceFromAny(cmd["include"], []string{"documents", "metadatas"})
		return c.getCollectionRows(ctx, name, limit, offset, cmd["where"], include)
	}
	if name := firstStringValue(cmd, "query", "collection"); name != "" {
		return c.queryCollection(ctx, name, cmd)
	}
	return nil, nil, fmt.Errorf("Chroma JSON 查询命令仅支持 list_collections/get/query")
}

func (c *ChromaDB) queryCollection(ctx context.Context, collection string, cmd map[string]interface{}) ([]map[string]interface{}, []string, error) {
	path, err := c.collectionActionPath(ctx, collection, "query")
	if err != nil {
		return nil, nil, err
	}
	body := make(map[string]interface{})
	for _, key := range []string{"query_embeddings", "query_texts", "where", "where_document", "include"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	body["n_results"] = intFromAny(firstExisting(cmd, "n_results", "limit"), 10)
	if _, ok := body["include"]; !ok {
		body["include"] = []string{"documents", "metadatas", "distances"}
	}
	var raw map[string]interface{}
	if err := c.doJSON(ctx, http.MethodPost, path, body, &raw); err != nil {
		return nil, nil, err
	}
	rows := chromaQueryResponseRows(raw)
	return rows, collectColumns(rows), nil
}

func (c *ChromaDB) createCollection(ctx context.Context, body map[string]interface{}) error {
	if err := c.ensureVersion(ctx); err != nil {
		return err
	}
	path := "/api/v1/collections"
	if c.apiVersion == 2 {
		path = c.v2Path("", "/collections")
	}
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) deleteCollection(ctx context.Context, name string) error {
	if err := c.ensureVersion(ctx); err != nil {
		return err
	}
	path := fmt.Sprintf("/api/v1/collections/%s", url.PathEscape(name))
	if c.apiVersion == 2 {
		coll, err := c.resolveCollection(ctx, "", name)
		if err != nil {
			return err
		}
		ident := coll.ID
		if ident == "" {
			ident = coll.Name
		}
		path = c.v2Path(coll.Database, fmt.Sprintf("/collections/%s", url.PathEscape(ident)))
	}
	return c.doJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (c *ChromaDB) upsertCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	if rowsValue, ok := cmd["rows"].([]interface{}); ok {
		rows := make([]map[string]interface{}, 0, len(rowsValue))
		for _, raw := range rowsValue {
			if row, ok := raw.(map[string]interface{}); ok {
				rows = append(rows, row)
			}
		}
		return int64(len(rows)), c.upsertRows(ctx, collection, rows)
	}
	body := make(map[string]interface{})
	for _, key := range []string{"ids", "documents", "metadatas", "embeddings", "uris"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	if _, ok := body["ids"]; !ok {
		return 0, fmt.Errorf("Chroma upsert 命令缺少 ids")
	}
	path, err := c.collectionActionPath(ctx, collection, "upsert")
	if err != nil {
		return 0, err
	}
	return int64(len(anySlice(body["ids"]))), c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) deleteCommand(ctx context.Context, collection string, cmd map[string]interface{}) (int64, error) {
	body := make(map[string]interface{})
	for _, key := range []string{"ids", "where", "where_document"} {
		if value, ok := cmd[key]; ok {
			body[key] = value
		}
	}
	if len(body) == 0 {
		return 0, fmt.Errorf("Chroma delete 命令缺少 ids/where/where_document")
	}
	path, err := c.collectionActionPath(ctx, collection, "delete")
	if err != nil {
		return 0, err
	}
	return int64(len(anySlice(body["ids"]))), c.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (c *ChromaDB) upsertRows(ctx context.Context, collection string, rows []map[string]interface{}) error {
	if len(rows) == 0 {
		return nil
	}
	ids := make([]string, 0, len(rows))
	docs := make([]interface{}, 0, len(rows))
	metadatas := make([]map[string]interface{}, 0, len(rows))
	embeddings := make([]interface{}, 0, len(rows))
	hasEmbedding := false
	for _, row := range rows {
		id := chromaRowID(row)
		if id == "" {
			return fmt.Errorf("Chroma 写入行缺少 id")
		}
		ids = append(ids, id)
		docs = append(docs, firstExisting(row, "document", "_document", "documents"))
		meta := make(map[string]interface{})
		if raw, ok := row["metadata"].(map[string]interface{}); ok {
			for k, v := range raw {
				meta[k] = v
			}
		}
		for k, v := range row {
			if isChromaReservedRowField(k) {
				continue
			}
			if strings.HasPrefix(k, "metadata.") {
				meta[strings.TrimPrefix(k, "metadata.")] = v
				continue
			}
			meta[k] = v
		}
		metadatas = append(metadatas, meta)
		if embedding := firstExisting(row, "embedding", "_embedding", "embeddings"); embedding != nil {
			embeddings = append(embeddings, normalizeChromaEmbedding(embedding))
			hasEmbedding = true
		}
	}
	body := map[string]interface{}{
		"ids":       ids,
		"documents": docs,
		"metadatas": metadatas,
	}
	if hasEmbedding {
		body["embeddings"] = embeddings
	}
	path, err := c.collectionActionPath(ctx, collection, "upsert")
	if err != nil {
		return err
	}
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}

type chromaParsedSQL struct {
	Collection        string
	Limit             int
	Offset            int
	Where             interface{}
	Count             bool
	IncludeEmbeddings bool
}

var chromaSQLFromRE = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"|` + "`" + `([^` + "`" + `]+)` + "`" + `|([a-zA-Z0-9_.\-]+))`)
var chromaSQLLimitRE = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)`)
var chromaSQLOffsetRE = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)

func parseChromaSQL(sqlText string) (chromaParsedSQL, bool) {
	text := strings.TrimSpace(sqlText)
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return chromaParsedSQL{}, false
	}
	matches := chromaSQLFromRE.FindStringSubmatch(text)
	if len(matches) == 0 {
		return chromaParsedSQL{}, false
	}
	table := firstNonEmpty(matches[1], matches[2], matches[3])
	if table == "" {
		return chromaParsedSQL{}, false
	}
	parsed := chromaParsedSQL{Collection: table, Limit: 200}
	lower := strings.ToLower(text)
	parsed.Count = strings.Contains(lower, "count(")
	parsed.IncludeEmbeddings = strings.Contains(lower, "embedding")
	if m := chromaSQLLimitRE.FindStringSubmatch(text); len(m) > 1 {
		parsed.Limit, _ = strconv.Atoi(m[1])
	}
	if m := chromaSQLOffsetRE.FindStringSubmatch(text); len(m) > 1 {
		parsed.Offset, _ = strconv.Atoi(m[1])
	}
	return parsed, true
}

func chromaGetResponseRows(resp chromaGetResponse) ([]map[string]interface{}, []string) {
	rows := make([]map[string]interface{}, 0, len(resp.IDs))
	for index, id := range resp.IDs {
		row := map[string]interface{}{"id": id}
		if value := sliceValue(resp.Documents, index); value != nil {
			row["document"] = value
		}
		if meta := sliceValueMap(resp.Metadatas, index); meta != nil {
			row["metadata"] = meta
			for k, v := range meta {
				row["metadata."+k] = v
			}
		}
		if value := sliceValue(resp.Embeddings, index); value != nil {
			row["embedding"] = normalizeJSONLikeValue(value)
		}
		rows = append(rows, row)
	}
	return rows, collectColumns(rows)
}

func chromaQueryResponseRows(raw map[string]interface{}) []map[string]interface{} {
	idGroups := nestedAnySlice(raw["ids"])
	docGroups := nestedAnySlice(raw["documents"])
	metaGroups := nestedAnySlice(raw["metadatas"])
	distanceGroups := nestedAnySlice(raw["distances"])
	var rows []map[string]interface{}
	for groupIndex, group := range idGroups {
		for itemIndex, id := range group {
			row := map[string]interface{}{
				"query_index": groupIndex,
				"id":          fmt.Sprintf("%v", id),
			}
			if doc := nestedValue(docGroups, groupIndex, itemIndex); doc != nil {
				row["document"] = doc
			}
			if dist := nestedValue(distanceGroups, groupIndex, itemIndex); dist != nil {
				row["distance"] = dist
			}
			if meta, ok := nestedValue(metaGroups, groupIndex, itemIndex).(map[string]interface{}); ok {
				row["metadata"] = meta
				for k, v := range meta {
					row["metadata."+k] = v
				}
			}
			rows = append(rows, row)
		}
	}
	return rows
}

func collectColumns(rows []map[string]interface{}) []string {
	set := make(map[string]struct{})
	for _, row := range rows {
		for key := range row {
			set[key] = struct{}{}
		}
	}
	cols := make([]string, 0, len(set))
	for key := range set {
		cols = append(cols, key)
	}
	sort.Strings(cols)
	for _, priority := range []string{"id", "query_index", "document", "distance", "metadata", "embedding"} {
		for i, col := range cols {
			if col == priority && i > 0 {
				cols = append(cols[:i], cols[i+1:]...)
				cols = append([]string{priority}, cols...)
				break
			}
		}
	}
	return cols
}

func tableNameOrDB(dbName, tableName string) string {
	if name := strings.TrimSpace(tableName); name != "" {
		return name
	}
	return strings.TrimSpace(dbName)
}

func chromaStructRow(col chromaCollection) map[string]interface{} {
	row := map[string]interface{}{
		"id":       col.ID,
		"name":     col.Name,
		"tenant":   col.Tenant,
		"database": col.Database,
	}
	if col.Dimension > 0 {
		row["dimension"] = col.Dimension
	}
	if len(col.Metadata) > 0 {
		row["metadata"] = col.Metadata
	}
	return row
}

func chromaCountValue(raw interface{}) int64 {
	switch v := raw.(type) {
	case json.Number:
		n, _ := v.Int64()
		return n
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case int64:
		return v
	case map[string]interface{}:
		return chromaCountValue(firstExisting(v, "count", "total", "value"))
	default:
		return 0
	}
}

func chromaRowID(row map[string]interface{}) string {
	return strings.TrimSpace(fmt.Sprintf("%v", firstExisting(row, "id", "_id")))
}

func isChromaReservedRowField(key string) bool {
	switch key {
	case "id", "_id", "document", "_document", "documents", "metadata", "embedding", "_embedding", "embeddings":
		return true
	default:
		return false
	}
}

func normalizeChromaEmbedding(value interface{}) interface{} {
	if text, ok := value.(string); ok {
		var parsed interface{}
		if err := decodeJSONWithUseNumber([]byte(text), &parsed); err == nil {
			return parsed
		}
	}
	return value
}

func inferChromaValueType(value interface{}) string {
	switch value.(type) {
	case bool:
		return "bool"
	case json.Number, float64, float32, int, int64:
		return "number"
	case map[string]interface{}:
		return "json"
	case []interface{}:
		return "array"
	default:
		return "string"
	}
}

func firstStringValue(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func firstExisting(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			return value
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			return text
		}
	}
	return ""
}

func hasAnyKey(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

func getOrBool(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		switch v := m[key].(type) {
		case bool:
			return v
		case string:
			return strings.EqualFold(strings.TrimSpace(v), "true")
		}
	}
	return false
}

func intFromAny(value interface{}, fallback int) int {
	switch v := value.(type) {
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return int(n)
		}
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return n
		}
	}
	return fallback
}

func mapString(m map[string]interface{}, key string) string {
	return strings.TrimSpace(fmt.Sprintf("%v", m[key]))
}

func stringSliceFromAny(value interface{}, fallback []string) []string {
	if value == nil {
		return fallback
	}
	switch v := value.(type) {
	case []string:
		return v
	case []interface{}:
		result := make([]string, 0, len(v))
		for _, item := range v {
			if text := strings.TrimSpace(fmt.Sprintf("%v", item)); text != "" {
				result = append(result, text)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return fallback
}

func anySlice(value interface{}) []interface{} {
	switch v := value.(type) {
	case []interface{}:
		return v
	case []string:
		result := make([]interface{}, len(v))
		for i, item := range v {
			result[i] = item
		}
		return result
	default:
		return nil
	}
}

func nestedAnySlice(value interface{}) [][]interface{} {
	switch v := value.(type) {
	case []interface{}:
		result := make([][]interface{}, 0, len(v))
		for _, group := range v {
			result = append(result, anySlice(group))
		}
		return result
	default:
		return nil
	}
}

func nestedValue(groups [][]interface{}, groupIndex, itemIndex int) interface{} {
	if groupIndex < 0 || groupIndex >= len(groups) {
		return nil
	}
	group := groups[groupIndex]
	if itemIndex < 0 || itemIndex >= len(group) {
		return nil
	}
	return group[itemIndex]
}

func sliceValue(items []interface{}, index int) interface{} {
	if index < 0 || index >= len(items) {
		return nil
	}
	return normalizeJSONLikeValue(items[index])
}

func sliceValueMap(items []map[string]interface{}, index int) map[string]interface{} {
	if index < 0 || index >= len(items) {
		return nil
	}
	return items[index]
}

func normalizeJSONLikeValue(value interface{}) interface{} {
	switch value.(type) {
	case map[string]interface{}, []interface{}:
		payload, err := json.Marshal(value)
		if err == nil {
			return string(payload)
		}
	}
	return value
}
