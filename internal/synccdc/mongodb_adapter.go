package synccdc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	mongoSnapshotSemantics = "startAtOperationTime at-least-once barrier; complete handoff requires every snapshot read to be causally constrained at or after this operationTime, which this adapter cannot enforce by itself; without that constraint initial snapshot is unsupported, reads are not pinned to one cluster timestamp, and duplicate events are possible"
	mongoDeliverySemantics = "ordered per MongoDB change stream cursor with resumable at-least-once delivery; each returned transaction contains one change event; stream termination including filtered drop/invalidate returns a re-snapshot-required error"
	mongoAckSemantics      = "local delivered-position validation only; MongoDB change streams have no server-side acknowledgement"
)

var mongoRequiredSettings = []string{
	"MongoDB 4.2+ replica set or sharded cluster; standalone servers are unsupported",
	"database-scope changeStream/find privileges for Probe, plus find/changeStream access to every selected namespace",
	"majority read concern and oplog retention covering the full snapshot duration",
	"a resolved direct MongoDB endpoint; SSH, proxy, and HTTP tunnel routing must be established before CDC",
	"cluster-scope changeStream privilege when selected namespaces span multiple databases",
	"snapshot reader support for causal reads at or after the returned operationTime when initialSnapshot is enabled",
}

type MongoDBAdapter struct {
	connector mongoConnector
}

type mongoSnapshotToken struct {
	Version       int                `json:"version"`
	Strategy      string             `json:"strategy"`
	ScopeHash     string             `json:"scopeHash"`
	OperationTime mongoOperationTime `json:"operationTime"`
	Semantics     string             `json:"semantics"`
}

func NewMongoDBAdapter() *MongoDBAdapter {
	return &MongoDBAdapter{connector: realMongoConnector{}}
}

func newMongoDBAdapterWithConnector(connector mongoConnector) *MongoDBAdapter {
	return &MongoDBAdapter{connector: connector}
}

func (a *MongoDBAdapter) Name() string {
	return mongoDBAdapterName
}

func (a *MongoDBAdapter) SourceTypes() []string {
	return []string{"mongodb", "mongodb-v1"}
}

func (a *MongoDBAdapter) Probe(ctx context.Context, config connection.ConnectionConfig) (Capability, error) {
	ctx = mongoContext(ctx)
	capability := mongoCapability(config.Type)
	if normalizeSourceType(config.Type) != "mongodb" {
		capability.Supported = false
		capability.Reason = fmt.Sprintf("source type %q is not handled by the MongoDB CDC adapter", strings.TrimSpace(config.Type))
		return capability, nil
	}
	if err := validateMongoNetworkRoute(config); err != nil {
		capability.Reason = err.Error()
		return capability, nil
	}
	database := mongoConfigDatabase(config)
	if database == "" {
		capability.Reason = "MongoDB CDC requires a source database for its privilege and change-stream probe"
		return capability, nil
	}
	if a == nil || a.connector == nil {
		return capability, errors.New("MongoDB CDC connector is not configured")
	}
	conn, err := a.connector.Connect(ctx, config)
	if err != nil {
		if ctxErr := contextError(ctx, err); ctxErr != nil {
			return capability, ctxErr
		}
		capability.Reason = classifyMongoProbeError(err)
		return capability, nil
	}
	defer disconnectMongoConnection(conn)

	topology, err := conn.Inspect(ctx)
	if err != nil {
		if ctxErr := contextError(ctx, err); ctxErr != nil {
			return capability, ctxErr
		}
		capability.Reason = classifyMongoProbeError(err)
		return capability, nil
	}
	if reason := validateMongoTopology(topology); reason != "" {
		capability.Reason = reason
		return capability, nil
	}
	if err := conn.ProbeChangeStream(ctx, database, bson.Timestamp{}); err != nil {
		if ctxErr := contextError(ctx, err); ctxErr != nil {
			return capability, ctxErr
		}
		capability.Reason = classifyMongoProbeError(err)
		return capability, nil
	}
	capability.Ready = true
	capability.Reason = mongoSnapshotSemantics
	return capability, nil
}

func (a *MongoDBAdapter) BeginSnapshot(ctx context.Context, request Request) (Barrier, error) {
	ctx = mongoContext(ctx)
	namespaces, scopeHash, err := validateMongoRequest(request)
	if err != nil {
		return Barrier{}, err
	}
	if a == nil || a.connector == nil {
		return Barrier{}, errors.New("MongoDB CDC connector is not configured")
	}
	conn, err := a.connector.Connect(ctx, request.Config)
	if err != nil {
		return Barrier{}, err
	}
	defer disconnectMongoConnection(conn)
	if err := ensureMongoTopology(ctx, conn); err != nil {
		return Barrier{}, err
	}
	operationTime, err := conn.SnapshotOperationTime(ctx, namespaces[0])
	if err != nil {
		return Barrier{}, err
	}
	position, err := mongoOperationTimePosition(scopeHash, operationTime)
	if err != nil {
		return Barrier{}, err
	}
	snapshotToken, err := json.Marshal(mongoSnapshotToken{
		Version:   mongoPositionVersion,
		Strategy:  "startAtOperationTime",
		ScopeHash: scopeHash,
		OperationTime: mongoOperationTime{
			Seconds:   operationTime.T,
			Increment: operationTime.I,
		},
		Semantics: mongoSnapshotSemantics,
	})
	if err != nil {
		return Barrier{}, fmt.Errorf("encode MongoDB CDC snapshot token: %w", err)
	}
	return Barrier{Position: position, SnapshotToken: snapshotToken}, nil
}

func (a *MongoDBAdapter) Open(ctx context.Context, request Request, position Position) (Stream, error) {
	ctx = mongoContext(ctx)
	namespaces, scopeHash, err := validateMongoRequest(request)
	if err != nil {
		return nil, err
	}
	payload, resumeToken, operationTime, err := decodeMongoPosition(position)
	if err != nil {
		return nil, err
	}
	if payload.ScopeHash != scopeHash {
		return nil, errors.New("MongoDB CDC position belongs to a different source or namespace selection")
	}
	if a == nil || a.connector == nil {
		return nil, errors.New("MongoDB CDC connector is not configured")
	}
	conn, err := a.connector.Connect(ctx, request.Config)
	if err != nil {
		return nil, err
	}
	if err := ensureMongoTopology(ctx, conn); err != nil {
		disconnectMongoConnection(conn)
		return nil, err
	}
	cursor, err := conn.OpenChangeStream(ctx, namespaces, mongoWatchStart{
		ResumeToken:   resumeToken,
		OperationTime: operationTime,
	})
	if err != nil {
		disconnectMongoConnection(conn)
		return nil, fmt.Errorf("open MongoDB change stream: %w", err)
	}
	return newMongoDBStream(conn, cursor, namespaces, scopeHash), nil
}

func mongoCapability(sourceType string) Capability {
	normalizedSource := normalizeSourceType(sourceType)
	if normalizedSource == "" {
		normalizedSource = "mongodb"
	}
	return Capability{
		Adapter:                     mongoDBAdapterName,
		SourceType:                  normalizedSource,
		Supported:                   true,
		Ready:                       false,
		RequiredSettings:            append([]string(nil), mongoRequiredSettings...),
		SupportsInitialSnapshot:     true,
		SupportsSchemaEvents:        false,
		PreservesSourceTransactions: false,
		RequiresCausalSnapshotReads: true,
		SnapshotSemantics:           mongoSnapshotSemantics,
		DeliverySemantics:           mongoDeliverySemantics,
		AcknowledgementSemantics:    mongoAckSemantics,
	}
}

func validateMongoRequest(request Request) ([]mongoNamespace, string, error) {
	if normalizeSourceType(request.Config.Type) != "mongodb" {
		return nil, "", fmt.Errorf("MongoDB CDC source type must be mongodb or mongodb-v1, got %q", strings.TrimSpace(request.Config.Type))
	}
	if err := validateMongoNetworkRoute(request.Config); err != nil {
		return nil, "", err
	}
	if len(request.Objects) == 0 {
		return nil, "", errors.New("MongoDB CDC requires at least one selected collection")
	}
	fallbackDatabase := firstNonEmpty(request.Database, request.Schema, mongoConfigDatabase(request.Config))
	seen := make(map[string]struct{}, len(request.Objects))
	namespaces := make([]mongoNamespace, 0, len(request.Objects))
	for _, object := range request.Objects {
		database := firstNonEmpty(object.Database, object.Schema, fallbackDatabase)
		collection := strings.TrimSpace(object.Name)
		if database == "" {
			return nil, "", fmt.Errorf("MongoDB CDC collection %q has no database namespace", collection)
		}
		if collection == "" {
			return nil, "", errors.New("MongoDB CDC collection name is required")
		}
		if strings.ContainsRune(database, '\x00') || strings.ContainsRune(collection, '\x00') {
			return nil, "", errors.New("MongoDB CDC namespaces must not contain NUL characters")
		}
		if strings.HasPrefix(collection, "system.") {
			return nil, "", fmt.Errorf("MongoDB CDC does not support system collection %s.%s", database, collection)
		}
		key := database + "\x00" + collection
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		namespaces = append(namespaces, mongoNamespace{Database: database, Collection: collection})
	}
	sort.Slice(namespaces, func(i, j int) bool {
		if namespaces[i].Database == namespaces[j].Database {
			return namespaces[i].Collection < namespaces[j].Collection
		}
		return namespaces[i].Database < namespaces[j].Database
	})
	return namespaces, mongoScopeHash(request.Config, namespaces), nil
}

func mongoScopeHash(config connection.ConnectionConfig, namespaces []mongoNamespace) string {
	parts := []string{
		"v1",
		normalizeSourceType(config.Type),
		strings.TrimSpace(config.ID),
		strings.TrimSpace(config.ReplicaSet),
		mongoSafeEndpoint(config),
	}
	for _, namespace := range namespaces {
		parts = append(parts, namespace.Database+"."+namespace.Collection)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func mongoSafeEndpoint(config connection.ConnectionConfig) string {
	if rawURI := strings.TrimSpace(config.URI); rawURI != "" {
		if parsed, err := url.Parse(rawURI); err == nil {
			parsed.User = nil
			parsed.RawQuery = ""
			parsed.Fragment = ""
			return strings.ToLower(parsed.String())
		}
	}
	return strings.ToLower(strings.Join(normalizedMongoHosts(config), ",") + "/" + strings.TrimSpace(config.Database))
}

func mongoConfigDatabase(config connection.ConnectionConfig) string {
	if database := strings.TrimSpace(config.Database); database != "" {
		return database
	}
	if rawURI := strings.TrimSpace(config.URI); rawURI != "" {
		if parsed, err := url.Parse(rawURI); err == nil {
			if database, err := url.PathUnescape(strings.Trim(parsed.EscapedPath(), "/")); err == nil {
				return strings.TrimSpace(database)
			}
		}
	}
	return ""
}

func ensureMongoTopology(ctx context.Context, conn mongoConnection) error {
	topology, err := conn.Inspect(ctx)
	if err != nil {
		return err
	}
	if reason := validateMongoTopology(topology); reason != "" {
		return errors.New(reason)
	}
	return nil
}

func validateMongoTopology(topology mongoTopology) string {
	if strings.TrimSpace(topology.ReplicaSet) == "" && !topology.Sharded {
		return "MongoDB CDC is unavailable on standalone servers; configure a replica set or sharded cluster"
	}
	if topology.MaxWireVersion < mongoMinimumBarrierWireVersion {
		return fmt.Sprintf("MongoDB CDC requires MongoDB 4.2+ (maxWireVersion >= %d), server reported %d", mongoMinimumBarrierWireVersion, topology.MaxWireVersion)
	}
	return ""
}

func classifyMongoProbeError(err error) string {
	if err == nil {
		return ""
	}
	var commandError mongo.CommandError
	if errors.As(err, &commandError) {
		switch commandError.Code {
		case 13:
			return "MongoDB CDC probe was not authorized; grant changeStream and find privileges for the source database and selected collections"
		case 286:
			return "MongoDB change-stream history is no longer available; increase oplog retention and create a new snapshot barrier"
		case 40573, 40615:
			return "MongoDB change streams require a replica set or sharded cluster; standalone servers are unsupported"
		}
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "not authorized"), strings.Contains(message, "unauthorized"):
		return "MongoDB CDC probe was not authorized; grant changeStream and find privileges for the source database and selected collections"
	case strings.Contains(message, "only supported on replica sets"), strings.Contains(message, "$changestream") && strings.Contains(message, "standalone"):
		return "MongoDB change streams require a replica set or sharded cluster; standalone servers are unsupported"
	case strings.Contains(message, "operationtime"):
		return "MongoDB did not provide an operationTime; enable majority read concern on a MongoDB 4.0+ replica set or sharded cluster"
	default:
		return "MongoDB CDC probe failed; verify the endpoint, TLS, credentials, replica-set settings, and source privileges"
	}
}

func contextError(ctx context.Context, err error) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

func disconnectMongoConnection(conn mongoConnection) {
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = conn.Disconnect(ctx)
	cancel()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func mongoContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

var _ Adapter = (*MongoDBAdapter)(nil)
