//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
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

const defaultMongoPort = 27017

func normalizeMongoAddress(host string, port int) string {
	h := strings.TrimSpace(host)
	if h == "" {
		h = "localhost"
	}
	p := port
	if p <= 0 {
		p = defaultMongoPort
	}
	return fmt.Sprintf("%s:%d", h, p)
}

func normalizeMongoSeed(raw string, defaultPort int, useSRV bool) (string, bool) {
	host, port, ok := parseHostPortWithDefault(raw, defaultPort)
	if !ok {
		return "", false
	}

	if useSRV {
		normalized := strings.TrimSpace(host)
		if normalized == "" {
			return "", false
		}
		return normalized, true
	}

	return normalizeMongoAddress(host, port), true
}

func collectMongoSeeds(config connection.ConnectionConfig) []string {
	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultMongoPort
	}
	useSRV := config.MongoSRV

	candidates := make([]string, 0, len(config.Hosts)+1)
	if len(config.Hosts) > 0 {
		candidates = append(candidates, config.Hosts...)
	} else {
		if useSRV {
			candidates = append(candidates, strings.TrimSpace(config.Host))
		} else {
			candidates = append(candidates, normalizeMongoAddress(config.Host, defaultPort))
		}
	}

	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, entry := range candidates {
		normalized, ok := normalizeMongoSeed(entry, defaultPort, useSRV)
		if !ok {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}

	return result
}

func applyMongoURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	lowerURI := strings.ToLower(uriText)
	if strings.HasPrefix(lowerURI, "mongodb+srv://") {
		config.MongoSRV = true
	}
	if !strings.HasPrefix(lowerURI, "mongodb://") && !strings.HasPrefix(lowerURI, "mongodb+srv://") {
		return config
	}

	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}

	if parsed.User != nil {
		if config.User == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	if dbName := strings.TrimPrefix(parsed.Path, "/"); dbName != "" && config.Database == "" {
		config.Database = dbName
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultMongoPort
	}
	hostsFromURI := make([]string, 0, 4)
	hostText := strings.TrimSpace(parsed.Host)
	if hostText != "" {
		for _, entry := range strings.Split(hostText, ",") {
			normalized, ok := normalizeMongoSeed(entry, defaultPort, config.MongoSRV)
			if ok {
				hostsFromURI = append(hostsFromURI, normalized)
			}
		}
	}

	if len(config.Hosts) == 0 && len(hostsFromURI) > 0 {
		config.Hosts = hostsFromURI
	}
	if strings.TrimSpace(config.Host) == "" && len(hostsFromURI) > 0 {
		host, port, ok := parseHostPortWithDefault(hostsFromURI[0], defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}

	query := parsed.Query()
	if config.AuthSource == "" {
		config.AuthSource = strings.TrimSpace(query.Get("authSource"))
	}
	if config.ReadPreference == "" {
		config.ReadPreference = strings.TrimSpace(query.Get("readPreference"))
	}
	if config.ReplicaSet == "" {
		config.ReplicaSet = strings.TrimSpace(query.Get("replicaSet"))
	}
	if config.MongoAuthMechanism == "" {
		config.MongoAuthMechanism = strings.TrimSpace(query.Get("authMechanism"))
	}
	if config.Topology == "" {
		if len(config.Hosts) > 1 || strings.TrimSpace(config.ReplicaSet) != "" {
			config.Topology = "replica"
		} else {
			config.Topology = "single"
		}
	}

	return config
}

func (m *MongoDB) getURI(config connection.ConnectionConfig) string {
	if strings.TrimSpace(config.URI) != "" {
		return strings.TrimSpace(config.URI)
	}

	seeds := collectMongoSeeds(config)
	if len(seeds) == 0 {
		if config.MongoSRV {
			seed := strings.TrimSpace(config.Host)
			if seed == "" {
				seed = "localhost"
			}
			seeds = append(seeds, seed)
		} else {
			seeds = append(seeds, normalizeMongoAddress(config.Host, config.Port))
		}
	}

	scheme := "mongodb"
	if config.MongoSRV {
		scheme = "mongodb+srv"
	}
	hostText := strings.Join(seeds, ",")
	uri := fmt.Sprintf("%s://%s", scheme, hostText)

	if config.User != "" {
		var userinfo *url.Userinfo
		if config.Password != "" {
			userinfo = url.UserPassword(config.User, config.Password)
		} else {
			userinfo = url.User(config.User)
		}
		uri = fmt.Sprintf("%s://%s@%s", scheme, userinfo.String(), hostText)
	}

	path := "/"
	if strings.TrimSpace(config.Database) != "" {
		path = "/" + url.PathEscape(strings.TrimSpace(config.Database))
	}
	uri += path

	params := url.Values{}
	timeout := getConnectTimeoutSeconds(config)
	params.Set("connectTimeoutMS", strconv.Itoa(timeout*1000))
	params.Set("serverSelectionTimeoutMS", strconv.Itoa(timeout*1000))

	authSource := strings.TrimSpace(config.AuthSource)
	if authSource == "" && strings.TrimSpace(config.Database) != "" {
		authSource = strings.TrimSpace(config.Database)
	}
	if authSource == "" {
		authSource = "admin"
	}
	params.Set("authSource", authSource)

	if replicaSet := strings.TrimSpace(config.ReplicaSet); replicaSet != "" {
		params.Set("replicaSet", replicaSet)
	}
	if readPreference := strings.TrimSpace(config.ReadPreference); readPreference != "" {
		params.Set("readPreference", readPreference)
	}
	if authMechanism := strings.TrimSpace(config.MongoAuthMechanism); authMechanism != "" {
		params.Set("authMechanism", authMechanism)
	}

	if encoded := params.Encode(); encoded != "" {
		uri += "?" + encoded
	}

	return uri
}

func buildMongoAuthAttempts(config connection.ConnectionConfig) []connection.ConnectionConfig {
	attempts := []connection.ConnectionConfig{config}
	replicaUser := strings.TrimSpace(config.MongoReplicaUser)
	if replicaUser == "" {
		return attempts
	}
	if replicaUser == strings.TrimSpace(config.User) && config.MongoReplicaPassword == config.Password {
		return attempts
	}

	replicaConfig := config
	replicaConfig.URI = ""
	replicaConfig.User = replicaUser
	replicaConfig.Password = config.MongoReplicaPassword
	attempts = append(attempts, replicaConfig)
	return attempts
}

func (m *MongoDB) Connect(config connection.ConnectionConfig) error {
	runConfig := applyMongoURI(config)
	connectConfig := runConfig

	if runConfig.UseSSH && runConfig.MongoSRV {
		return fmt.Errorf("MongoDB SRV 记录模式暂不支持 SSH 隧道")
	}

	if runConfig.UseSSH {
		seeds := collectMongoSeeds(runConfig)
		if len(seeds) == 0 {
			seeds = append(seeds, normalizeMongoAddress(runConfig.Host, runConfig.Port))
		}
		targetHost, targetPort, ok := parseHostPortWithDefault(seeds[0], defaultMongoPort)
		if !ok {
			return fmt.Errorf("MongoDB 连接失败：无效地址 %s", seeds[0])
		}

		logger.Infof("MongoDB 使用 SSH 连接：地址=%s:%d", targetHost, targetPort)

		forwarder, err := ssh.GetOrCreateLocalForwarder(runConfig.SSH, targetHost, targetPort)
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

		localConfig := runConfig
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false
		localConfig.URI = ""
		localConfig.Hosts = []string{normalizeMongoAddress(host, port)}
		connectConfig = localConfig
		logger.Infof("MongoDB 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, targetHost, targetPort)
	}

	m.pingTimeout = getConnectTimeout(connectConfig)
	m.database = connectConfig.Database
	if m.database == "" {
		m.database = "admin"
	}

	attemptConfigs := buildMongoAuthAttempts(connectConfig)
	var errorDetails []string
	for index, attemptConfig := range attemptConfigs {
		authLabel := "主库凭据"
		if index > 0 {
			authLabel = "从库凭据"
		}

		uri := m.getURI(attemptConfig)
		clientOpts := options.Client().ApplyURI(uri)
		client, err := mongo.Connect(clientOpts)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s连接失败: %v", authLabel, err))
			continue
		}

		m.client = client
		if err := m.Ping(); err != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = client.Disconnect(ctx)
			cancel()
			m.client = nil
			errorDetails = append(errorDetails, fmt.Sprintf("%s验证失败: %v", authLabel, err))
			continue
		}
		return nil
	}

	if len(errorDetails) > 0 {
		return fmt.Errorf("MongoDB 连接失败：%s", strings.Join(errorDetails, "；"))
	}

	return fmt.Errorf("MongoDB 连接失败：无可用连接方案")
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

func asMongoStringList(raw interface{}) []string {
	values, ok := raw.(bson.A)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, entry := range values {
		text := strings.TrimSpace(fmt.Sprintf("%v", entry))
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func asMongoString(raw interface{}) string {
	if raw == nil {
		return ""
	}
	if value, ok := raw.(string); ok {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(fmt.Sprintf("%v", raw))
}

func asMongoInt(raw interface{}) int {
	switch value := raw.(type) {
	case int:
		return value
	case int32:
		return int(value)
	case int64:
		return int(value)
	case float32:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func asMongoBool(raw interface{}) bool {
	switch value := raw.(type) {
	case bool:
		return value
	case int:
		return value != 0
	case int32:
		return value != 0
	case int64:
		return value != 0
	case float32:
		return value != 0
	case float64:
		return value != 0
	default:
		return false
	}
}

func asMongoInt64(raw interface{}) int64 {
	switch value := raw.(type) {
	case int:
		return int64(value)
	case int32:
		return int64(value)
	case int64:
		return value
	case float32:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func mongoStateByCode(code int) string {
	switch code {
	case 1:
		return "PRIMARY"
	case 2:
		return "SECONDARY"
	case 3:
		return "RECOVERING"
	case 5:
		return "STARTUP2"
	case 6:
		return "UNKNOWN"
	case 7:
		return "ARBITER"
	case 8:
		return "DOWN"
	case 9:
		return "ROLLBACK"
	case 10:
		return "REMOVED"
	default:
		return "UNKNOWN"
	}
}

func normalizeMongoStateLabel(state string, stateCode int) string {
	normalized := strings.ToUpper(strings.TrimSpace(state))
	if normalized != "" {
		return normalized
	}
	return mongoStateByCode(stateCode)
}

func buildMembersFromReplStatus(raw bson.M) []connection.MongoMemberInfo {
	items, ok := raw["members"].(bson.A)
	if !ok {
		return nil
	}

	members := make([]connection.MongoMemberInfo, 0, len(items))
	for _, entry := range items {
		member, ok := entry.(bson.M)
		if !ok {
			continue
		}
		host := asMongoString(member["name"])
		if host == "" {
			continue
		}
		stateCode := asMongoInt(member["state"])
		state := normalizeMongoStateLabel(asMongoString(member["stateStr"]), stateCode)
		members = append(members, connection.MongoMemberInfo{
			Host:      host,
			Role:      state,
			State:     state,
			StateCode: stateCode,
			Healthy:   asMongoInt(member["health"]) > 0 || asMongoBool(member["health"]),
			IsSelf:    asMongoBool(member["self"]),
		})
	}

	sort.Slice(members, func(i, j int) bool {
		return members[i].Host < members[j].Host
	})
	return members
}

func buildMembersFromHello(raw bson.M) []connection.MongoMemberInfo {
	hosts := asMongoStringList(raw["hosts"])
	if len(hosts) == 0 {
		return nil
	}
	primary := asMongoString(raw["primary"])
	selfHost := asMongoString(raw["me"])
	passiveSet := make(map[string]struct{})
	for _, host := range asMongoStringList(raw["passives"]) {
		passiveSet[host] = struct{}{}
	}
	arbiterSet := make(map[string]struct{})
	for _, host := range asMongoStringList(raw["arbiters"]) {
		arbiterSet[host] = struct{}{}
	}

	members := make([]connection.MongoMemberInfo, 0, len(hosts))
	for _, host := range hosts {
		state := "SECONDARY"
		stateCode := 2
		if host == primary {
			state = "PRIMARY"
			stateCode = 1
		} else if _, ok := arbiterSet[host]; ok {
			state = "ARBITER"
			stateCode = 7
		} else if _, ok := passiveSet[host]; ok {
			state = "PASSIVE"
			stateCode = 6
		}
		members = append(members, connection.MongoMemberInfo{
			Host:      host,
			Role:      state,
			State:     state,
			StateCode: stateCode,
			Healthy:   true,
			IsSelf:    host == selfHost,
		})
	}

	sort.Slice(members, func(i, j int) bool {
		return members[i].Host < members[j].Host
	})
	return members
}

func (m *MongoDB) DiscoverMembers() (string, []connection.MongoMemberInfo, error) {
	if m.client == nil {
		return "", nil, fmt.Errorf("connection not open")
	}

	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	adminDB := m.client.Database("admin")

	var replStatus bson.M
	replErr := adminDB.RunCommand(ctx, bson.D{{Key: "replSetGetStatus", Value: 1}}).Decode(&replStatus)
	if replErr == nil {
		replicaSet := asMongoString(replStatus["set"])
		members := buildMembersFromReplStatus(replStatus)
		if len(members) > 0 {
			return replicaSet, members, nil
		}
	}

	var helloResult bson.M
	helloErr := adminDB.RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&helloResult)
	if helloErr != nil {
		if err := adminDB.RunCommand(ctx, bson.D{{Key: "isMaster", Value: 1}}).Decode(&helloResult); err != nil {
			if replErr != nil {
				return "", nil, fmt.Errorf("成员发现失败：replSetGetStatus=%v；hello=%v", replErr, err)
			}
			return "", nil, fmt.Errorf("成员发现失败：hello=%w", err)
		}
	}

	replicaSet := asMongoString(helloResult["setName"])
	members := buildMembersFromHello(helloResult)
	if len(members) == 0 {
		if replErr != nil {
			return replicaSet, nil, fmt.Errorf("未获取到成员信息：replSetGetStatus=%v", replErr)
		}
		return replicaSet, nil, fmt.Errorf("未获取到成员信息")
	}
	return replicaSet, members, nil
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

// sqlToMongoFind 将前端生成的简单 SQL 转换为 MongoDB find 命令 JSON。
// 支持：SELECT * FROM "coll" LIMIT n OFFSET m / SELECT COUNT(*) as total FROM "coll"
func sqlToMongoFind(sql string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(sql))

	// SELECT COUNT(*) as total FROM "coll" ...
	if strings.HasPrefix(lower, "select count(") {
		coll := extractCollectionFromSQL(sql)
		if coll == "" {
			return "", false
		}
		return fmt.Sprintf(`{"count":"%s","query":{}}`, coll), true
	}

	// SELECT * FROM "coll" ... LIMIT n OFFSET m
	if !strings.HasPrefix(lower, "select") {
		return "", false
	}
	coll := extractCollectionFromSQL(sql)
	if coll == "" {
		return "", false
	}

	limit := int64(0)
	skip := int64(0)

	// 提取 LIMIT
	if idx := strings.Index(lower, "limit "); idx >= 0 {
		after := strings.TrimSpace(lower[idx+6:])
		parts := strings.Fields(after)
		if len(parts) > 0 {
			if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
				limit = n
			}
		}
	}

	// 提取 OFFSET
	if idx := strings.Index(lower, "offset "); idx >= 0 {
		after := strings.TrimSpace(lower[idx+7:])
		parts := strings.Fields(after)
		if len(parts) > 0 {
			if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
				skip = n
			}
		}
	}

	cmd := fmt.Sprintf(`{"find":"%s","filter":{}`, coll)
	if limit > 0 {
		cmd += fmt.Sprintf(`,"limit":%d`, limit)
	}
	if skip > 0 {
		cmd += fmt.Sprintf(`,"skip":%d`, skip)
	}
	cmd += "}"
	return cmd, true
}

// extractCollectionFromSQL 从 SQL 中提取 FROM 后的 collection 名称。
func extractCollectionFromSQL(sql string) string {
	lower := strings.ToLower(sql)
	idx := strings.Index(lower, "from ")
	if idx < 0 {
		return ""
	}
	after := strings.TrimSpace(sql[idx+5:])

	// 去掉引号包裹
	var coll string
	if len(after) > 0 && after[0] == '"' {
		end := strings.Index(after[1:], "\"")
		if end < 0 {
			return ""
		}
		coll = after[1 : end+1]
	} else if len(after) > 0 && after[0] == '`' {
		end := strings.Index(after[1:], "`")
		if end < 0 {
			return ""
		}
		coll = after[1 : end+1]
	} else {
		parts := strings.Fields(after)
		if len(parts) == 0 {
			return ""
		}
		coll = parts[0]
	}
	return strings.TrimSpace(coll)
}

func (m *MongoDB) queryWithContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.client == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("empty query")
	}

	// 如果输入是 SQL 语句（前端 DataViewer 统一生成），自动转换为 MongoDB JSON 命令
	lowerQuery := strings.ToLower(query)
	if strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "show") {
		if converted, ok := sqlToMongoFind(query); ok {
			query = converted
		}
	}

	// Parse JSON command
	var cmd bson.D
	if err := bson.UnmarshalExtJSON([]byte(query), true, &cmd); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON command: %w", err)
	}

	// 对 find 和 count 命令使用原生 driver API，避免 RunCommand 的 firstBatch 限制
	if len(cmd) > 0 {
		switch cmd[0].Key {
		case "find":
			return m.execFind(ctx, cmd)
		case "count":
			return m.execCount(ctx, cmd)
		}
	}

	// 其他命令走 RunCommand
	db := m.client.Database(m.database)
	var result bson.M
	if err := db.RunCommand(ctx, cmd).Decode(&result); err != nil {
		return nil, nil, err
	}

	// Handle COUNT result (e.g. delete/update returns "n")
	if n, ok := result["n"]; ok {
		if _, hasCursor := result["cursor"]; !hasCursor {
			return []map[string]interface{}{{"total": n}}, []string{"total"}, nil
		}
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

// execFind 使用原生 Collection.Find() 执行查询，正确处理游标迭代
func (m *MongoDB) execFind(ctx context.Context, cmd bson.D) ([]map[string]interface{}, []string, error) {
	var collName string
	var filter interface{}
	var limit int64
	var skip int64
	var sortDoc interface{}
	var projection interface{}

	for _, elem := range cmd {
		switch elem.Key {
		case "find":
			collName = fmt.Sprintf("%v", elem.Value)
		case "filter":
			filter = elem.Value
		case "limit":
			limit = asMongoInt64(elem.Value)
		case "skip":
			skip = asMongoInt64(elem.Value)
		case "sort":
			sortDoc = elem.Value
		case "projection":
			projection = elem.Value
		}
	}

	if collName == "" {
		return nil, nil, fmt.Errorf("find command missing collection name")
	}
	if filter == nil {
		filter = bson.D{}
	}

	collection := m.client.Database(m.database).Collection(collName)
	opts := options.Find()
	if limit > 0 {
		opts.SetLimit(limit)
	}
	if skip > 0 {
		opts.SetSkip(skip)
	}
	if sortDoc != nil {
		opts.SetSort(sortDoc)
	}
	if projection != nil {
		opts.SetProjection(projection)
	}

	cursor, err := collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, nil, err
	}
	defer cursor.Close(ctx)

	var data []map[string]interface{}
	columnSet := make(map[string]bool)

	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		row := make(map[string]interface{})
		for k, v := range doc {
			row[k] = convertBsonValue(v)
			columnSet[k] = true
		}
		data = append(data, row)
	}

	if err := cursor.Err(); err != nil {
		return nil, nil, err
	}

	columns := make([]string, 0, len(columnSet))
	for k := range columnSet {
		columns = append(columns, k)
	}
	sort.Strings(columns)

	// 将 _id 列置首
	for i, col := range columns {
		if col == "_id" && i > 0 {
			columns = append(columns[:i], columns[i+1:]...)
			columns = append([]string{"_id"}, columns...)
			break
		}
	}

	return data, columns, nil
}

// execCount 使用原生 Collection.CountDocuments() 执行计数
func (m *MongoDB) execCount(ctx context.Context, cmd bson.D) ([]map[string]interface{}, []string, error) {
	var collName string
	var filter interface{}

	for _, elem := range cmd {
		switch elem.Key {
		case "count":
			collName = fmt.Sprintf("%v", elem.Value)
		case "query":
			filter = elem.Value
		}
	}

	if collName == "" {
		return nil, nil, fmt.Errorf("count command missing collection name")
	}
	if filter == nil {
		filter = bson.D{}
	}

	collection := m.client.Database(m.database).Collection(collName)
	n, err := collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, nil, err
	}

	return []map[string]interface{}{{"total": n}}, []string{"total"}, nil
}

// convertBsonValue 将 BSON 特殊类型转换为前端可读的 JSON 友好值
func convertBsonValue(v interface{}) interface{} {
	switch val := v.(type) {
	case bson.ObjectID:
		return val.Hex()
	case bson.M:
		result := make(map[string]interface{}, len(val))
		for k, v2 := range val {
			result[k] = convertBsonValue(v2)
		}
		return result
	case bson.D:
		result := make(map[string]interface{}, len(val))
		for _, elem := range val {
			result[elem.Key] = convertBsonValue(elem.Value)
		}
		return result
	case bson.A:
		result := make([]interface{}, len(val))
		for i, v2 := range val {
			result[i] = convertBsonValue(v2)
		}
		return result
	default:
		return v
	}
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
