package synccdc

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/tlsconfig"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readconcern"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

const (
	mongoDefaultPort                     = 27017
	mongoDefaultConnectTimeout           = 30 * time.Second
	mongoMinimumBarrierWireVersion int32 = 8 // mongo-driver/v2 supports MongoDB 4.2+.
)

type mongoNamespace struct {
	Database   string
	Collection string
}

type mongoTopology struct {
	ReplicaSet     string
	Sharded        bool
	MaxWireVersion int32
}

type mongoWatchStart struct {
	ResumeToken   bson.Raw
	OperationTime *bson.Timestamp
}

type mongoCursor interface {
	Next(context.Context) bool
	Decode(any) error
	ResumeToken() bson.Raw
	Err() error
	Close(context.Context) error
}

type mongoConnection interface {
	Inspect(context.Context) (mongoTopology, error)
	SnapshotOperationTime(context.Context, mongoNamespace) (bson.Timestamp, error)
	ProbeChangeStream(context.Context, string, bson.Timestamp) error
	OpenChangeStream(context.Context, []mongoNamespace, mongoWatchStart) (mongoCursor, error)
	Disconnect(context.Context) error
}

type mongoConnector interface {
	Connect(context.Context, connection.ConnectionConfig) (mongoConnection, error)
}

type realMongoConnector struct{}

type realMongoConnection struct {
	client *mongo.Client
}

type mongoHelloResponse struct {
	SetName        string `bson:"setName"`
	Message        string `bson:"msg"`
	MaxWireVersion int32  `bson:"maxWireVersion"`
}

func (realMongoConnector) Connect(ctx context.Context, config connection.ConnectionConfig) (mongoConnection, error) {
	var lastErr error
	for _, attempt := range mongoAuthAttempts(config) {
		clientOptions, err := mongoClientOptions(attempt)
		if err != nil {
			return nil, err
		}
		client, err := mongo.Connect(clientOptions)
		if err != nil {
			lastErr = fmt.Errorf("connect to MongoDB for CDC: %w", err)
			continue
		}
		if err := client.Ping(ctx, readpref.Primary()); err != nil {
			disconnectCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = client.Disconnect(disconnectCtx)
			cancel()
			lastErr = fmt.Errorf("ping MongoDB for CDC: %w", err)
			if ctxErr := contextError(ctx, err); ctxErr != nil {
				return nil, ctxErr
			}
			continue
		}
		return &realMongoConnection{client: client}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("MongoDB CDC has no usable authentication configuration")
	}
	return nil, lastErr
}

func (c *realMongoConnection) Inspect(ctx context.Context) (mongoTopology, error) {
	if c == nil || c.client == nil {
		return mongoTopology{}, errors.New("MongoDB CDC connection is closed")
	}
	var result mongoHelloResponse
	if err := c.client.Database("admin").RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&result); err != nil {
		var commandError mongo.CommandError
		if !errors.As(err, &commandError) || commandError.Code != 59 {
			return mongoTopology{}, fmt.Errorf("inspect MongoDB topology: %w", err)
		}
		if err := c.client.Database("admin").RunCommand(ctx, bson.D{{Key: "isMaster", Value: 1}}).Decode(&result); err != nil {
			return mongoTopology{}, fmt.Errorf("inspect MongoDB topology: %w", err)
		}
	}
	return mongoTopology{
		ReplicaSet:     strings.TrimSpace(result.SetName),
		Sharded:        strings.EqualFold(strings.TrimSpace(result.Message), "isdbgrid"),
		MaxWireVersion: result.MaxWireVersion,
	}, nil
}

func (c *realMongoConnection) SnapshotOperationTime(ctx context.Context, namespace mongoNamespace) (bson.Timestamp, error) {
	if c == nil || c.client == nil {
		return bson.Timestamp{}, errors.New("MongoDB CDC connection is closed")
	}
	var operationTime bson.Timestamp
	err := c.client.UseSession(ctx, func(sessionContext context.Context) error {
		result := c.client.Database(namespace.Database).Collection(namespace.Collection).FindOne(
			sessionContext,
			bson.D{},
			options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}}),
		)
		if err := result.Err(); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return fmt.Errorf("establish majority snapshot barrier for %s.%s: %w", namespace.Database, namespace.Collection, err)
		}
		session := mongo.SessionFromContext(sessionContext)
		if session == nil || session.OperationTime() == nil {
			return errors.New("MongoDB did not return an operationTime for the snapshot barrier")
		}
		operationTime = *session.OperationTime()
		return nil
	})
	if err != nil {
		return bson.Timestamp{}, err
	}
	if operationTime.IsZero() {
		return bson.Timestamp{}, errors.New("MongoDB returned an empty operationTime for the snapshot barrier")
	}
	return operationTime, nil
}

func (c *realMongoConnection) ProbeChangeStream(ctx context.Context, database string, operationTime bson.Timestamp) error {
	if c == nil || c.client == nil {
		return errors.New("MongoDB CDC connection is closed")
	}
	pipeline := mongo.Pipeline{bson.D{{Key: "$match", Value: bson.D{
		{Key: "operationType", Value: "__gonavi_cdc_probe__"},
	}}}}
	streamOptions := options.ChangeStream().
		SetFullDocument(options.UpdateLookup).
		SetMaxAwaitTime(250 * time.Millisecond)
	if !operationTime.IsZero() {
		streamOptions.SetStartAtOperationTime(&operationTime)
	}
	stream, err := c.client.Database(database).Watch(ctx, pipeline, streamOptions)
	if err != nil {
		return err
	}
	return stream.Close(ctx)
}

func (c *realMongoConnection) OpenChangeStream(ctx context.Context, namespaces []mongoNamespace, start mongoWatchStart) (mongoCursor, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("MongoDB CDC connection is closed")
	}
	pipeline := mongoNamespacePipeline(namespaces)
	streamOptions := options.ChangeStream().
		SetFullDocument(options.UpdateLookup).
		SetMaxAwaitTime(time.Second)
	if len(start.ResumeToken) > 0 {
		streamOptions.SetResumeAfter(start.ResumeToken)
	} else if start.OperationTime != nil {
		streamOptions.SetStartAtOperationTime(start.OperationTime)
	} else {
		return nil, errors.New("MongoDB CDC change stream start position is required")
	}

	if len(namespaces) == 1 {
		namespace := namespaces[0]
		return c.client.Database(namespace.Database).Collection(namespace.Collection).Watch(ctx, pipeline, streamOptions)
	}
	if database, ok := singleMongoDatabase(namespaces); ok {
		return c.client.Database(database).Watch(ctx, pipeline, streamOptions)
	}
	return c.client.Watch(ctx, pipeline, streamOptions)
}

func (c *realMongoConnection) Disconnect(ctx context.Context) error {
	if c == nil || c.client == nil {
		return nil
	}
	client := c.client
	c.client = nil
	return client.Disconnect(ctx)
}

func mongoNamespacePipeline(namespaces []mongoNamespace) mongo.Pipeline {
	operationFilter := bson.D{{Key: "$in", Value: bson.A{"insert", "replace", "update", "delete"}}}
	match := bson.D{{Key: "operationType", Value: operationFilter}}
	if len(namespaces) == 1 {
		match = append(match,
			bson.E{Key: "ns.db", Value: namespaces[0].Database},
			bson.E{Key: "ns.coll", Value: namespaces[0].Collection},
		)
	} else if database, ok := singleMongoDatabase(namespaces); ok {
		collections := make(bson.A, 0, len(namespaces))
		for _, namespace := range namespaces {
			collections = append(collections, namespace.Collection)
		}
		match = append(match,
			bson.E{Key: "ns.db", Value: database},
			bson.E{Key: "ns.coll", Value: bson.D{{Key: "$in", Value: collections}}},
		)
	} else {
		alternatives := make(bson.A, 0, len(namespaces))
		for _, namespace := range namespaces {
			alternatives = append(alternatives, bson.D{
				{Key: "ns.db", Value: namespace.Database},
				{Key: "ns.coll", Value: namespace.Collection},
			})
		}
		match = append(match, bson.E{Key: "$or", Value: alternatives})
	}
	return mongo.Pipeline{bson.D{{Key: "$match", Value: match}}}
}

func singleMongoDatabase(namespaces []mongoNamespace) (string, bool) {
	if len(namespaces) == 0 {
		return "", false
	}
	database := namespaces[0].Database
	for _, namespace := range namespaces[1:] {
		if namespace.Database != database {
			return "", false
		}
	}
	return database, true
}

func mongoClientOptions(config connection.ConnectionConfig) (*options.ClientOptions, error) {
	if err := validateMongoNetworkRoute(config); err != nil {
		return nil, err
	}
	uri, err := mongoConnectionURI(config)
	if err != nil {
		return nil, err
	}
	clientOptions := options.Client().ApplyURI(uri).
		SetReadConcern(readconcern.Majority()).
		SetReadPreference(readpref.Primary())
	timeout := time.Duration(config.Timeout) * time.Second
	if timeout <= 0 {
		timeout = mongoDefaultConnectTimeout
	}
	clientOptions.SetConnectTimeout(timeout).SetServerSelectionTimeout(timeout)

	username := strings.TrimSpace(config.User)
	password := config.Password
	mechanism := strings.TrimSpace(config.MongoAuthMechanism)
	if username != "" && !strings.EqualFold(mechanism, "NONE") {
		authSource := strings.TrimSpace(config.AuthSource)
		if authSource == "" {
			authSource = "admin"
		}
		clientOptions.SetAuth(options.Credential{
			AuthMechanism: mechanism,
			AuthSource:    authSource,
			Username:      username,
			Password:      password,
			PasswordSet:   true,
		})
	}
	if replicaSet := strings.TrimSpace(config.ReplicaSet); replicaSet != "" {
		clientOptions.SetReplicaSet(replicaSet)
	}
	tlsConfig, err := mongoCDCClientTLSConfig(config)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		clientOptions.SetTLSConfig(tlsConfig)
	}
	return clientOptions, nil
}

func mongoAuthAttempts(config connection.ConnectionConfig) []connection.ConnectionConfig {
	replicaUser := strings.TrimSpace(config.MongoReplicaUser)
	primaryUser := strings.TrimSpace(config.User)
	if replicaUser == "" || (replicaUser == primaryUser && config.MongoReplicaPassword == config.Password) {
		return []connection.ConnectionConfig{config}
	}
	replicaAttempt := config
	replicaAttempt.User = replicaUser
	replicaAttempt.Password = config.MongoReplicaPassword
	replicaAttempt.MongoReplicaUser = ""
	replicaAttempt.MongoReplicaPassword = ""
	if primaryUser == "" {
		return []connection.ConnectionConfig{replicaAttempt}
	}
	return []connection.ConnectionConfig{config, replicaAttempt}
}

func validateMongoNetworkRoute(config connection.ConnectionConfig) error {
	if config.UseSSH {
		return errors.New("MongoDB CDC requires a resolved direct endpoint; unresolved SSH tunnelling is not supported")
	}
	if config.UseProxy {
		return errors.New("MongoDB CDC requires a resolved direct endpoint; unresolved proxy routing is not supported")
	}
	if config.UseHTTPTunnel {
		return errors.New("MongoDB CDC requires a resolved direct endpoint; unresolved HTTP tunnelling is not supported")
	}
	return nil
}

func mongoConnectionURI(config connection.ConnectionConfig) (string, error) {
	rawURI := strings.TrimSpace(config.URI)
	if rawURI != "" {
		parsed, err := url.Parse(rawURI)
		if err != nil {
			return "", errors.New("MongoDB CDC URI is invalid")
		}
		if parsed.Scheme != "mongodb" && parsed.Scheme != "mongodb+srv" {
			return "", fmt.Errorf("MongoDB CDC URI scheme must be mongodb or mongodb+srv, got %q", parsed.Scheme)
		}
		if strings.TrimSpace(parsed.Host) == "" {
			return "", errors.New("MongoDB CDC URI host is required")
		}
		if err := mergeMongoConnectionParams(parsed.Query(), config.ConnectionParams, parsed); err != nil {
			return "", err
		}
		return parsed.String(), nil
	}

	hosts := normalizedMongoHosts(config)
	if len(hosts) == 0 {
		return "", errors.New("MongoDB CDC host is required")
	}
	if config.MongoSRV && len(hosts) != 1 {
		return "", errors.New("MongoDB SRV CDC configuration requires exactly one host")
	}
	scheme := "mongodb"
	if config.MongoSRV {
		scheme = "mongodb+srv"
	}
	database := strings.TrimSpace(config.Database)
	path := "/" + database
	parsed := &url.URL{Scheme: scheme, Host: strings.Join(hosts, ","), Path: path}
	params := parsed.Query()
	if replicaSet := strings.TrimSpace(config.ReplicaSet); replicaSet != "" {
		params.Set("replicaSet", replicaSet)
	}
	if authSource := strings.TrimSpace(config.AuthSource); authSource != "" {
		params.Set("authSource", authSource)
	}
	if mechanism := strings.TrimSpace(config.MongoAuthMechanism); mechanism != "" && !strings.EqualFold(mechanism, "NONE") {
		params.Set("authMechanism", mechanism)
	}
	if err := mergeMongoConnectionParams(params, config.ConnectionParams, parsed); err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func mergeMongoConnectionParams(params url.Values, raw string, target *url.URL) error {
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "?")
	raw = strings.ReplaceAll(raw, ";", "&")
	if raw != "" {
		parsed, err := url.ParseQuery(raw)
		if err != nil {
			return errors.New("MongoDB CDC connection parameters are invalid")
		}
		for key, values := range parsed {
			params.Del(key)
			for _, value := range values {
				params.Add(key, value)
			}
		}
	}
	target.RawQuery = params.Encode()
	return nil
}

func normalizedMongoHosts(config connection.ConnectionConfig) []string {
	rawHosts := append([]string(nil), config.Hosts...)
	if len(rawHosts) == 0 && strings.TrimSpace(config.Host) != "" {
		rawHosts = []string{config.Host}
	}
	seen := make(map[string]struct{}, len(rawHosts))
	hosts := make([]string, 0, len(rawHosts))
	for _, rawHost := range rawHosts {
		host := strings.TrimSpace(rawHost)
		if host == "" {
			continue
		}
		if config.MongoSRV {
			host = strings.TrimSuffix(host, ".")
		} else if _, _, err := net.SplitHostPort(host); err != nil {
			port := config.Port
			if port <= 0 {
				port = mongoDefaultPort
			}
			host = net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
		}
		if _, exists := seen[host]; exists {
			continue
		}
		seen[host] = struct{}{}
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	return hosts
}

func mongoCDCClientTLSConfig(config connection.ConnectionConfig) (*tls.Config, error) {
	if !config.UseSSL {
		return nil, nil
	}
	mode := strings.ToLower(strings.TrimSpace(config.SSLMode))
	insecure := mode == "" || mode == "preferred" || mode == "prefer" || mode == "skip-verify" || mode == "skipverify" || mode == "insecure"
	if mode == "disable" || mode == "disabled" || mode == "off" || mode == "false" || mode == "none" {
		return nil, nil
	}
	tlsConfig, err := tlsconfig.BuildClientConfig(tlsconfig.ClientConfigOptions{
		Enabled:            true,
		InsecureSkipVerify: insecure,
		CAPath:             config.SSLCAPath,
		CertPath:           config.SSLCertPath,
		KeyPath:            config.SSLKeyPath,
	})
	if err != nil {
		return nil, fmt.Errorf("configure MongoDB CDC TLS: %w", err)
	}
	return tlsConfig, nil
}
