//go:build gonavi_full_drivers || gonavi_pulsar_driver

package db

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"

	"github.com/apache/pulsar-client-go/pulsar"
	pulsarlog "github.com/apache/pulsar-client-go/pulsar/log"
)

const (
	defaultPulsarPort         = 6650
	defaultPulsarTLSPort      = 6651
	defaultPulsarQueryTimeout = 30 * time.Second
	defaultPulsarPreviewLimit = 100
	maxPulsarPreviewLimit     = 1000
	pulsarSyntheticDatabase   = "topics"
)

// PulsarDB implements the message-oriented Database contract for Apache Pulsar.
type PulsarDB struct {
	client       pulsar.Client
	defaultTopic string
	probeTopic   string
	listTopics   func(context.Context) ([]string, error)
}

var _ Database = (*PulsarDB)(nil)

func (p *PulsarDB) Connect(config connection.ConnectionConfig) error {
	_ = p.Close()
	if config.UseSSH || config.UseProxy || config.UseHTTPTunnel {
		return fmt.Errorf("pulsar SSH, proxy and HTTP tunnels are not supported")
	}
	if raw := strings.TrimSpace(config.URI); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "pulsar" && u.Scheme != "pulsar+ssl") || u.Hostname() == "" {
			return fmt.Errorf("invalid pulsar service URI")
		}
	}
	runConfig := normalizePulsarConfig(config)
	options := pulsar.ClientOptions{
		URL:                        runConfig.serviceURL,
		ConnectionTimeout:          getConnectTimeout(config),
		OperationTimeout:           getConnectTimeout(config),
		TLSAllowInsecureConnection: strings.EqualFold(runConfig.sslMode, "skip-verify"),
		TLSValidateHostname:        !strings.EqualFold(runConfig.sslMode, "skip-verify"),
		TLSTrustCertsFilePath:      runConfig.caPath,
		TLSCertificateFile:         runConfig.certPath,
		TLSKeyFilePath:             runConfig.keyPath,
		// App logs returned errors with its existing redaction and connection context.
		Logger: pulsarlog.DefaultNopLogger(),
	}
	if (runConfig.certPath == "") != (runConfig.keyPath == "") {
		return fmt.Errorf("pulsar TLS certificate and key must be configured together")
	}
	if runConfig.token != "" {
		options.Authentication = pulsar.NewAuthenticationToken(runConfig.token)
	} else if runConfig.user != "" {
		auth, err := pulsar.NewAuthenticationBasic(runConfig.user, runConfig.password)
		if err != nil {
			return fmt.Errorf("create pulsar basic authentication: %w", err)
		}
		options.Authentication = auth
	} else if runConfig.certPath != "" {
		options.Authentication = pulsar.NewAuthenticationTLS(runConfig.certPath, runConfig.keyPath)
	}
	client, err := pulsar.NewClient(options)
	if err != nil {
		return fmt.Errorf("connect pulsar: %w", err)
	}
	p.client = client
	p.defaultTopic = runConfig.topic
	p.probeTopic = "persistent://" + runConfig.tenant + "/" + runConfig.namespace + "/__gonavi_connection_probe__"
	p.listTopics = newPulsarTopicLister(runConfig)
	if err := p.Ping(); err != nil {
		_ = p.Close()
		return fmt.Errorf("probe pulsar connection: %w", err)
	}
	return nil
}

func (p *PulsarDB) Close() error {
	if p.client != nil {
		p.client.Close()
	}
	p.client = nil
	p.defaultTopic = ""
	p.probeTopic = ""
	p.listTopics = nil
	return nil
}

func (p *PulsarDB) Ping() error {
	if p.client == nil {
		return fmt.Errorf("pulsar connection is not open")
	}
	if p.defaultTopic == "" {
		_, err := p.client.TopicPartitions(p.probeTopic)
		if err != nil && !pulsarTopicNotFoundError(err) {
			return err
		}
		if p.listTopics != nil {
			_, err = p.listTopics(metadataContextFor(p))
		}
		return err
	}
	_, err := p.client.TopicPartitions(p.defaultTopic)
	return err
}

func pulsarTopicNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	var pulsarErr *pulsar.Error
	if errors.As(err, &pulsarErr) {
		return pulsarErr.Result() == pulsar.TopicNotFound
	}
	return strings.Contains(err.Error(), "TopicNotFound")
}

func (p *PulsarDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(metadataContextFor(p), defaultPulsarQueryTimeout)
	defer cancel()
	return p.QueryContext(ctx, query)
}

func (p *PulsarDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if p.client == nil {
		return nil, nil, fmt.Errorf("pulsar connection is not open")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	parsed, ok := parsePulsarSQL(query)
	if !ok {
		return nil, nil, fmt.Errorf("unsupported pulsar query; expected SHOW TOPICS, DESCRIBE TOPIC, SELECT * FROM topic or CONSUME FROM topic")
	}
	if parsed.action == "show_topics" {
		if p.listTopics == nil {
			return nil, nil, fmt.Errorf("pulsar topic discovery requires an admin endpoint")
		}
		topics, err := p.listTopics(ctx)
		if err != nil {
			return nil, nil, err
		}
		if parsed.limit > 0 && len(topics) > parsed.limit {
			topics = topics[:parsed.limit]
		}
		rows := make([]map[string]interface{}, 0, len(topics))
		for _, topic := range topics {
			partitions, partitionErr := p.client.TopicPartitions(topic)
			if partitionErr != nil {
				return nil, nil, partitionErr
			}
			rows = append(rows, map[string]interface{}{"topic": topic, "partition_count": len(partitions)})
		}
		return rows, []string{"topic", "partition_count"}, nil
	}
	topic := pulsarResolveTopic(parsed.topic, p.defaultTopic)
	if topic == "" {
		return nil, nil, fmt.Errorf("pulsar topic is required")
	}
	if parsed.action == "describe_topic" {
		partitions, err := p.client.TopicPartitions(topic)
		if err != nil {
			return nil, nil, err
		}
		return []map[string]interface{}{{"topic": topic, "partition_count": len(partitions), "partitions": partitions}}, []string{"topic", "partition_count", "partitions"}, nil
	}
	return p.readMessages(ctx, topic, parsed.limit, parsed.latest)
}

func (p *PulsarDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(metadataContextFor(p), defaultPulsarQueryTimeout)
	defer cancel()
	return p.ExecContext(ctx, query)
}

func (p *PulsarDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if p.client == nil {
		return 0, fmt.Errorf("pulsar connection is not open")
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	var command struct {
		Publish string                 `json:"publish"`
		Topic   string                 `json:"topic"`
		Key     string                 `json:"key"`
		Value   json.RawMessage        `json:"value"`
		Payload json.RawMessage        `json:"payload"`
		Props   map[string]interface{} `json:"properties"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(query)), &command); err != nil {
		return 0, fmt.Errorf("parse pulsar publish command: %w", err)
	}
	if command.Publish == "" && command.Topic == "" {
		return 0, fmt.Errorf("pulsar publish command requires a topic")
	}
	topic := pulsarResolveTopic(firstNonEmpty(command.Publish, command.Topic), p.defaultTopic)
	value := command.Value
	if len(value) == 0 {
		value = command.Payload
	}
	if len(value) == 0 {
		return 0, fmt.Errorf("pulsar publish command requires a value or payload")
	}
	// JSON strings are sent as text; other JSON values retain their exact encoding.
	var decoded string
	var body interface{} = value
	if json.Unmarshal(value, &decoded) == nil && string(value) != "null" {
		body = decoded
	}
	payload, err := pulsarPayload(body)
	if err != nil {
		return 0, err
	}
	producer, err := p.client.CreateProducer(pulsar.ProducerOptions{Topic: topic, SendTimeout: defaultPulsarQueryTimeout})
	if err != nil {
		return 0, fmt.Errorf("create pulsar producer: %w", err)
	}
	defer producer.Close()
	properties := make(map[string]string, len(command.Props))
	for key, value := range command.Props {
		properties[key] = fmt.Sprint(value)
	}
	if _, err := producer.Send(ctx, &pulsar.ProducerMessage{Payload: payload, Key: command.Key, Properties: properties}); err != nil {
		return 0, fmt.Errorf("publish pulsar message: %w", err)
	}
	return 1, nil
}

func (p *PulsarDB) GetDatabases() ([]string, error) { return []string{pulsarSyntheticDatabase}, nil }

func (p *PulsarDB) GetTables(dbName string) ([]string, error) {
	if p.listTopics != nil {
		topics, err := p.listTopics(metadataContextFor(p))
		if err != nil {
			if p.defaultTopic != "" {
				return []string{p.defaultTopic}, err
			}
			return nil, err
		}
		return topics, nil
	}
	if p.defaultTopic == "" {
		return []string{}, nil
	}
	return []string{p.defaultTopic}, nil
}

func (p *PulsarDB) GetCreateStatement(_, tableName string) (string, error) {
	if p.client == nil {
		return "", fmt.Errorf("pulsar connection is not open")
	}
	partitions, err := p.client.TopicPartitions(pulsarResolveTopic(tableName, p.defaultTopic))
	if err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(partitions, "", "  ")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("// Pulsar topic: %s\n%s", tableName, encoded), nil
}

func (p *PulsarDB) GetColumns(_, _ string) ([]connection.ColumnDefinition, error) {
	return []connection.ColumnDefinition{
		{Name: "topic", Type: "string", Key: "PRI"},
		{Name: "message_id", Type: "string", Key: "PRI"},
		{Name: "publish_time", Type: "timestamp"},
		{Name: "event_time", Type: "timestamp"},
		{Name: "key", Type: "string"},
		{Name: "value", Type: "json"},
		{Name: "payload_encoding", Type: "string", Comment: "json / text / base64"},
		{Name: "properties", Type: "json"},
		{Name: "redelivery_count", Type: "integer"},
	}, nil
}
func (p *PulsarDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := p.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	cols, err := p.GetColumns(dbName, "")
	if err != nil {
		return nil, err
	}
	result := make([]connection.ColumnDefinitionWithTable, 0, len(tables)*len(cols))
	for _, table := range tables {
		for _, col := range cols {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: col.Name, Type: col.Type, Comment: col.Comment})
		}
	}
	return result, nil
}
func (p *PulsarDB) GetIndexes(_, _ string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}
func (p *PulsarDB) GetForeignKeys(_, _ string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}
func (p *PulsarDB) GetTriggers(_, _ string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
func (p *PulsarDB) ApplyChanges(string, connection.ChangeSet) error {
	return fmt.Errorf("pulsar previews are read-only; use a JSON publish command")
}

type pulsarConfig struct {
	serviceURL, adminURL, topic, tenant, namespace, user, password, token, sslMode, caPath, certPath, keyPath string
}

func normalizePulsarConfig(config connection.ConnectionConfig) pulsarConfig {
	values := url.Values{}
	if parsed, err := url.Parse(strings.TrimSpace(config.URI)); err == nil && parsed.Scheme != "" {
		for key, items := range parsed.Query() {
			for _, item := range items {
				values.Add(key, item)
			}
		}
		if config.Host == "" {
			config.Host = parsed.Hostname()
		}
		if config.Port == 0 {
			config.Port, _ = strconv.Atoi(parsed.Port())
		}
		if config.Database == "" {
			config.Database = strings.Trim(parsed.Path, "/")
		}
		if config.User == "" && parsed.User != nil {
			config.User = parsed.User.Username()
		}
		if config.Password == "" && parsed.User != nil {
			config.Password, _ = parsed.User.Password()
		}
		config.UseSSL = config.UseSSL || strings.EqualFold(parsed.Scheme, "pulsar+ssl")
	}
	mergeConnectionParamValues(values, connectionParamsFromText(config.ConnectionParams))
	config.UseSSL = config.UseSSL || parseMetadataBool(values.Get("tls")) || parseMetadataBool(values.Get("ssl"))
	if parseMetadataBool(values.Get("skip_verify")) {
		config.SSLMode = "skip-verify"
	}
	scheme := "pulsar"
	if config.UseSSL || strings.EqualFold(config.SSLMode, "required") || strings.EqualFold(config.SSLMode, "skip-verify") {
		scheme = "pulsar+ssl"
	}
	port := config.Port
	if port <= 0 {
		port = defaultPulsarPort
		if scheme == "pulsar+ssl" {
			port = defaultPulsarTLSPort
		}
	}
	serviceURL := scheme + "://" + net.JoinHostPort(strings.Trim(strings.TrimSpace(config.Host), "[]"), strconv.Itoa(port))
	token := firstNonEmpty(values.Get("token"), values.Get("authToken"))
	topic := strings.TrimSpace(config.Database)
	tenant, namespace := pulsarTopicNamespace(topic)
	if configuredTenant := strings.TrimSpace(values.Get("tenant")); configuredTenant != "" {
		tenant = configuredTenant
	}
	if configuredNamespace := strings.TrimSpace(values.Get("namespace")); configuredNamespace != "" {
		namespace = configuredNamespace
	}
	adminURL := firstNonEmpty(values.Get("admin_url"), values.Get("web_service_url"))
	if adminURL == "" {
		adminScheme := "http"
		adminPort := 8080
		if scheme == "pulsar+ssl" {
			adminScheme, adminPort = "https", 8443
		}
		adminURL = adminScheme + "://" + net.JoinHostPort(strings.Trim(strings.TrimSpace(config.Host), "[]"), strconv.Itoa(adminPort))
	}
	return pulsarConfig{
		serviceURL: serviceURL, adminURL: strings.TrimRight(adminURL, "/"), topic: topic, tenant: tenant, namespace: namespace,
		user: config.User, password: config.Password, token: token, sslMode: config.SSLMode,
		caPath:   firstNonEmpty(config.SSLCAPath, values.Get("sslCAPath"), values.Get("tlsTrustCertsFilePath"), values.Get("ca")),
		certPath: firstNonEmpty(config.SSLCertPath, values.Get("sslCertPath")),
		keyPath:  firstNonEmpty(config.SSLKeyPath, values.Get("sslKeyPath")),
	}
}

type pulsarParsedSQL struct {
	action, topic string
	limit         int
	latest        bool
}

var pulsarReadRE = regexp.MustCompile(`(?i)^(SELECT\s+\*|CONSUME)\s+FROM\s+(?:"([^"]+)"|` + "`([^`]+)`" + `|([^\s;]+))(?:\s+(EARLIEST|LATEST))?(?:\s+LIMIT\s+([0-9]+))?$`)
var pulsarDescribeRE = regexp.MustCompile(`(?i)^DESCRIBE\s+TOPIC\s+(?:"([^"]+)"|` + "`([^`]+)`" + `|([^\s;]+))$`)
var pulsarShowTopicsRE = regexp.MustCompile(`(?i)^SHOW\s+TOPICS(?:\s+LIMIT\s+([0-9]+))?$`)

func parsePulsarSQL(sqlText string) (pulsarParsedSQL, bool) {
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sqlText), ";"))
	if match := pulsarShowTopicsRE.FindStringSubmatch(text); match != nil {
		if match[1] != "" {
			limit, err := strconv.Atoi(match[1])
			if err != nil || limit < 1 || limit > maxPulsarPreviewLimit {
				return pulsarParsedSQL{}, false
			}
		}
		limit := defaultPulsarPreviewLimit
		if match[1] != "" {
			limit, _ = strconv.Atoi(match[1])
		}
		return pulsarParsedSQL{action: "show_topics", topic: "", limit: limit}, true
	}
	if match := pulsarDescribeRE.FindStringSubmatch(text); match != nil {
		return pulsarParsedSQL{action: "describe_topic", topic: firstNonEmpty(match[1], match[2], match[3])}, true
	}
	match := pulsarReadRE.FindStringSubmatch(text)
	if match == nil {
		return pulsarParsedSQL{}, false
	}
	limit := defaultPulsarPreviewLimit
	if match[6] != "" {
		var err error
		limit, err = strconv.Atoi(match[6])
		if err != nil || limit < 1 || limit > maxPulsarPreviewLimit {
			return pulsarParsedSQL{}, false
		}
	}
	return pulsarParsedSQL{action: "read", topic: firstNonEmpty(match[2], match[3], match[4]), limit: limit, latest: strings.EqualFold(match[5], "LATEST")}, true
}
func (p *PulsarDB) readMessages(ctx context.Context, topic string, limit int, latest bool) ([]map[string]interface{}, []string, error) {
	if limit <= 0 {
		limit = defaultPulsarPreviewLimit
	}
	start := pulsar.LatestMessageID()
	if !latest {
		start = pulsar.EarliestMessageID()
	}
	reader, err := p.client.CreateReader(pulsar.ReaderOptions{Topic: topic, StartMessageID: start, StartMessageIDInclusive: !latest, ReceiverQueueSize: limit})
	if err != nil {
		return nil, nil, err
	}
	defer reader.Close()
	rows := make([]map[string]interface{}, 0, limit)
	for len(rows) < limit {
		readCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
		message, readErr := reader.Next(readCtx)
		cancel()
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			if errors.Is(readErr, context.DeadlineExceeded) {
				break
			}
			return nil, nil, readErr
		}
		rows = append(rows, pulsarMessageRow(message))
	}
	return rows, pulsarColumns(), nil
}
func pulsarMessageRow(message pulsar.Message) map[string]interface{} {
	value, encoding := pulsarDecodePayload(message.Payload())
	return map[string]interface{}{
		"topic": message.Topic(), "message_id": fmt.Sprint(message.ID()),
		"publish_time": message.PublishTime().Format(time.RFC3339Nano),
		"event_time":   message.EventTime().Format(time.RFC3339Nano),
		"key":          message.Key(), "value": value, "payload_encoding": encoding,
		"properties": message.Properties(), "redelivery_count": message.RedeliveryCount(),
	}
}
func pulsarColumns() []string {
	return []string{"topic", "message_id", "publish_time", "event_time", "key", "value", "payload_encoding", "properties", "redelivery_count"}
}
func pulsarDecodePayload(payload []byte) (interface{}, string) {
	if !utf8.Valid(payload) {
		return base64.StdEncoding.EncodeToString(payload), "base64"
	}
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if decoder.Decode(&value) == nil {
		var trailing interface{}
		if errors.Is(decoder.Decode(&trailing), io.EOF) {
			return pulsarJSONValue(value), "json"
		}
	}
	return string(payload), "text"
}

func pulsarJSONValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case json.Number:
		if pulsarJSONNumberNeedsString(typed) {
			return string(typed)
		}
		return typed
	case map[string]interface{}:
		for key, item := range typed {
			typed[key] = pulsarJSONValue(item)
		}
	case []interface{}:
		for index, item := range typed {
			typed[index] = pulsarJSONValue(item)
		}
	}
	return value
}

func pulsarJSONNumberNeedsString(number json.Number) bool {
	text := string(number)
	value, ok := new(big.Rat).SetString(text)
	if !ok {
		return false
	}
	limit := new(big.Rat).SetInt64(9007199254740991)
	return value.Cmp(limit) > 0 || value.Cmp(new(big.Rat).Neg(limit)) < 0
}

func pulsarTopicNamespace(topic string) (string, string) {
	trimmed := strings.Trim(strings.TrimSpace(topic), "/")
	for _, domain := range []string{"persistent://", "non-persistent://"} {
		if strings.HasPrefix(strings.ToLower(trimmed), domain) {
			parts := strings.Split(trimmed[len(domain):], "/")
			if len(parts) >= 3 {
				return parts[0], parts[1]
			}
		}
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) >= 3 {
		return parts[0], parts[1]
	}
	return "public", "default"
}

func newPulsarTopicLister(config pulsarConfig) func(context.Context) ([]string, error) {
	if config.adminURL == "" || config.tenant == "" || config.namespace == "" {
		return nil
	}
	return func(ctx context.Context) ([]string, error) {
		client := &http.Client{Timeout: defaultPulsarQueryTimeout}
		defer client.CloseIdleConnections()
		if strings.HasPrefix(strings.ToLower(config.adminURL), "https://") {
			tlsConfig := &tls.Config{InsecureSkipVerify: strings.EqualFold(config.sslMode, "skip-verify")} // #nosec G402
			if config.caPath != "" {
				roots, err := x509.SystemCertPool()
				if err != nil || roots == nil {
					roots = x509.NewCertPool()
				}
				pem, err := os.ReadFile(config.caPath)
				if err != nil {
					return nil, fmt.Errorf("load pulsar admin CA: %w", err)
				}
				if !roots.AppendCertsFromPEM(pem) {
					return nil, fmt.Errorf("load pulsar admin CA: no valid certificates")
				}
				tlsConfig.RootCAs = roots
			}
			if config.certPath != "" && config.keyPath != "" {
				certificate, err := tls.LoadX509KeyPair(config.certPath, config.keyPath)
				if err != nil {
					return nil, fmt.Errorf("load pulsar admin client certificate: %w", err)
				}
				tlsConfig.Certificates = []tls.Certificate{certificate}
			}
			client.Transport = &http.Transport{TLSClientConfig: tlsConfig}
		}
		endpoint := strings.TrimRight(config.adminURL, "/") + "/admin/v2/namespaces/" + url.PathEscape(config.tenant) + "/" + url.PathEscape(config.namespace) + "/topics"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		if config.token != "" {
			req.Header.Set("Authorization", "Bearer "+config.token)
		} else if config.user != "" {
			req.SetBasicAuth(config.user, config.password)
		}
		response, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("list pulsar topics: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			return nil, fmt.Errorf("list pulsar topics: admin API returned %s: %s", response.Status, strings.TrimSpace(string(body)))
		}
		var topics []string
		if err := json.NewDecoder(response.Body).Decode(&topics); err != nil {
			return nil, fmt.Errorf("decode pulsar topics: %w", err)
		}
		sort.Strings(topics)
		return topics, nil
	}
}
func pulsarPayload(value interface{}) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return []byte(typed), nil
	case []byte:
		return typed, nil
	case json.RawMessage:
		return typed, nil
	default:
		payload, err := json.Marshal(typed)
		if err != nil {
			return nil, fmt.Errorf("encode pulsar payload: %w", err)
		}
		return payload, nil
	}
}
func pulsarResolveTopic(value, fallback string) string {
	text := strings.Trim(strings.TrimSpace(value), "`\"")
	if text != "" {
		return text
	}
	return strings.Trim(strings.TrimSpace(fallback), "`\"")
}
