package synccdc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

var (
	ErrMongoDBStreamClosed       = errors.New("MongoDB CDC stream is closed")
	ErrMongoDBResnapshotRequired = errors.New("MongoDB CDC stream ended and requires a new snapshot")
)

const mongoMaxBufferedEventsPerDelivery = 256

type mongoBufferedCursor interface {
	TryNext(context.Context) bool
	RemainingBatchLength() int
}

type mongoChangeNamespace struct {
	Database   string `bson:"db"`
	Collection string `bson:"coll"`
}

type mongoChangeEnvelope struct {
	OperationType string               `bson:"operationType"`
	Namespace     mongoChangeNamespace `bson:"ns"`
	DocumentKey   bson.Raw             `bson:"documentKey"`
	FullDocument  bson.Raw             `bson:"fullDocument"`
	ClusterTime   bson.Timestamp       `bson:"clusterTime"`
	WallTime      time.Time            `bson:"wallTime"`
	SessionID     bson.Raw             `bson:"lsid"`
	TxnNumber     *int64               `bson:"txnNumber"`
}

type mongoDBStream struct {
	connection mongoConnection
	cursor     mongoCursor
	scopeHash  string
	allowed    map[string]struct{}

	lifetimeCtx              context.Context
	cancel                   context.CancelFunc
	opMu                     sync.Mutex
	stateMu                  sync.Mutex
	closed                   bool
	lastDeliveredIdentity    string
	lastAcknowledgedIdentity string
	closeOnce                sync.Once
	closeErr                 error
}

func newMongoDBStream(connection mongoConnection, cursor mongoCursor, namespaces []mongoNamespace, scopeHash string) *mongoDBStream {
	lifetimeCtx, cancel := context.WithCancel(context.Background())
	allowed := make(map[string]struct{}, len(namespaces))
	for _, namespace := range namespaces {
		allowed[mongoNamespaceKey(namespace.Database, namespace.Collection)] = struct{}{}
	}
	return &mongoDBStream{
		connection:  connection,
		cursor:      cursor,
		scopeHash:   scopeHash,
		allowed:     allowed,
		lifetimeCtx: lifetimeCtx,
		cancel:      cancel,
	}
}

func (s *mongoDBStream) Next(ctx context.Context) (Transaction, error) {
	if s == nil {
		return Transaction{}, ErrMongoDBStreamClosed
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Transaction{}, err
	}
	s.stateMu.Lock()
	closed := s.closed
	s.stateMu.Unlock()
	if closed {
		return Transaction{}, ErrMongoDBStreamClosed
	}

	nextCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.lifetimeCtx, cancel)
	defer func() {
		stop()
		cancel()
	}()

	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.stateMu.Lock()
	closed = s.closed
	s.stateMu.Unlock()
	if closed {
		return Transaction{}, ErrMongoDBStreamClosed
	}
	if !s.cursor.Next(nextCtx) {
		cursorErr := s.cursor.Err()
		if err := ctx.Err(); err != nil {
			return Transaction{}, err
		}
		if s.lifetimeCtx.Err() != nil {
			return Transaction{}, ErrMongoDBStreamClosed
		}
		if cursorErr != nil {
			return Transaction{}, fmt.Errorf("read MongoDB change stream: %w", cursorErr)
		}
		return Transaction{}, ErrMongoDBResnapshotRequired
	}

	event, position, identity, err := s.decodeCurrentEvent()
	if err != nil {
		return Transaction{}, err
	}
	events := []Event{event}
	if bufferedCursor, ok := s.cursor.(mongoBufferedCursor); ok {
		for len(events) < mongoMaxBufferedEventsPerDelivery && bufferedCursor.RemainingBatchLength() > 0 && bufferedCursor.TryNext(nextCtx) {
			bufferedEvent, bufferedPosition, bufferedIdentity, decodeErr := s.decodeCurrentEvent()
			if decodeErr != nil {
				return Transaction{}, decodeErr
			}
			events = append(events, bufferedEvent)
			position = bufferedPosition
			identity = bufferedIdentity
		}
		if err := ctx.Err(); err != nil {
			return Transaction{}, err
		}
		if s.lifetimeCtx.Err() != nil {
			return Transaction{}, ErrMongoDBStreamClosed
		}
		if cursorErr := s.cursor.Err(); cursorErr != nil {
			return Transaction{}, fmt.Errorf("read MongoDB buffered change stream events: %w", cursorErr)
		}
	}
	s.stateMu.Lock()
	s.lastDeliveredIdentity = identity
	s.stateMu.Unlock()
	return Transaction{Events: events, Position: position}, nil
}

func (s *mongoDBStream) decodeCurrentEvent() (Event, Position, string, error) {
	var envelope mongoChangeEnvelope
	if err := s.cursor.Decode(&envelope); err != nil {
		return Event{}, Position{}, "", fmt.Errorf("decode MongoDB change stream event: %w", err)
	}
	event, err := mapMongoChangeEvent(envelope, s.allowed)
	if err != nil {
		return Event{}, Position{}, "", err
	}
	position, err := mongoResumeTokenPosition(s.scopeHash, append(bson.Raw(nil), s.cursor.ResumeToken()...))
	if err != nil {
		return Event{}, Position{}, "", err
	}
	identity, err := mongoPositionIdentity(position)
	if err != nil {
		return Event{}, Position{}, "", err
	}
	return event, position, identity, nil
}

func (s *mongoDBStream) Acknowledge(ctx context.Context, position Position) error {
	if s == nil {
		return ErrMongoDBStreamClosed
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	payload, _, _, err := decodeMongoPosition(position)
	if err != nil {
		return err
	}
	if payload.ScopeHash != s.scopeHash {
		return errors.New("MongoDB CDC acknowledgement belongs to a different source or namespace selection")
	}
	identity, err := mongoPositionIdentity(position)
	if err != nil {
		return err
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.closed {
		return ErrMongoDBStreamClosed
	}
	if identity == s.lastAcknowledgedIdentity && identity == s.lastDeliveredIdentity && identity != "" {
		return nil
	}
	if identity == "" || identity != s.lastDeliveredIdentity {
		return errors.New("MongoDB CDC can only acknowledge the most recently delivered position")
	}
	// MongoDB exposes no server acknowledgement for change streams. Recording
	// this identity only validates the caller's durable local checkpoint.
	s.lastAcknowledgedIdentity = identity
	return nil
}

func (s *mongoDBStream) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.stateMu.Lock()
		s.closed = true
		s.stateMu.Unlock()
		s.cancel()

		s.opMu.Lock()
		defer s.opMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var cursorErr error
		if s.cursor != nil {
			cursorErr = s.cursor.Close(ctx)
		}
		var disconnectErr error
		if s.connection != nil {
			disconnectErr = s.connection.Disconnect(ctx)
		}
		s.closeErr = errors.Join(cursorErr, disconnectErr)
	})
	return s.closeErr
}

func mapMongoChangeEvent(envelope mongoChangeEnvelope, allowed map[string]struct{}) (Event, error) {
	if _, ok := allowed[mongoNamespaceKey(envelope.Namespace.Database, envelope.Namespace.Collection)]; !ok {
		return Event{}, fmt.Errorf("MongoDB change stream returned out-of-scope namespace %s.%s", envelope.Namespace.Database, envelope.Namespace.Collection)
	}
	operation := envelope.OperationType
	switch operation {
	case "insert", "replace", "update", "delete":
	default:
		return Event{}, fmt.Errorf("unsupported MongoDB change-stream operation %q", operation)
	}
	key, err := mongoRawDocumentToJSONMap(envelope.DocumentKey)
	if err != nil {
		return Event{}, fmt.Errorf("decode MongoDB change-stream document key: %w", err)
	}
	if len(key) == 0 {
		return Event{}, fmt.Errorf("MongoDB %s event has no document key", operation)
	}
	var after map[string]interface{}
	if operation != "delete" {
		after, err = mongoRawDocumentToJSONMap(envelope.FullDocument)
		if err != nil {
			return Event{}, fmt.Errorf("decode MongoDB %s fullDocument: %w", operation, err)
		}
		if len(after) == 0 && operation != "update" {
			return Event{}, fmt.Errorf("MongoDB %s event has no fullDocument; updateLookup could not produce an apply-safe row", operation)
		}
	}
	commitTime := envelope.WallTime.UTC()
	if !envelope.ClusterTime.IsZero() {
		commitTime = time.Unix(int64(envelope.ClusterTime.T), 0).UTC()
	}
	if commitTime.IsZero() {
		return Event{}, errors.New("MongoDB change-stream event has no commit time")
	}
	return Event{
		Object: ObjectRef{
			Database: envelope.Namespace.Database,
			Name:     envelope.Namespace.Collection,
		},
		Operation:  operation,
		Key:        key,
		After:      after,
		CommitTime: commitTime,
		SourceTxID: mongoSourceTransactionID(envelope.SessionID, envelope.TxnNumber),
	}, nil
}

func mongoRawDocumentToJSONMap(raw bson.Raw) (map[string]interface{}, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if err := raw.Validate(); err != nil {
		return nil, err
	}
	var document bson.M
	if err := bson.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	converted, ok := mongoBSONValueToJSON(document).(map[string]interface{})
	if !ok {
		return nil, errors.New("MongoDB BSON document did not decode to an object")
	}
	return converted, nil
}

func mongoBSONValueToJSON(value interface{}) interface{} {
	switch typed := value.(type) {
	case bson.M:
		result := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			result[key] = mongoBSONValueToJSON(item)
		}
		return result
	case bson.D:
		result := make(map[string]interface{}, len(typed))
		for _, item := range typed {
			result[item.Key] = mongoBSONValueToJSON(item.Value)
		}
		return result
	case bson.A:
		result := make([]interface{}, len(typed))
		for index, item := range typed {
			result[index] = mongoBSONValueToJSON(item)
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(typed))
		for index, item := range typed {
			result[index] = mongoBSONValueToJSON(item)
		}
		return result
	case bson.ObjectID, bson.DateTime, bson.Decimal128, bson.Binary, bson.Regex,
		bson.Timestamp, bson.MaxKey, bson.MinKey, bson.Undefined, int32, int64, []byte, time.Time:
		if converted, ok := mongoExtendedJSONValue(typed); ok {
			return converted
		}
		return typed
	default:
		return value
	}
}

func mongoExtendedJSONValue(value interface{}) (interface{}, bool) {
	payload, err := bson.MarshalExtJSON(bson.M{"v": value}, true, false)
	if err != nil {
		return nil, false
	}
	var wrapped map[string]interface{}
	if err := json.Unmarshal(payload, &wrapped); err != nil {
		return nil, false
	}
	converted, ok := wrapped["v"]
	return converted, ok
}

func mongoSourceTransactionID(sessionID bson.Raw, transactionNumber *int64) string {
	if len(sessionID) == 0 || transactionNumber == nil {
		return ""
	}
	sum := sha256.Sum256(append(append([]byte(nil), sessionID...), []byte(strconv.FormatInt(*transactionNumber, 10))...))
	return "mongo-tx-" + hex.EncodeToString(sum[:12])
}

func mongoNamespaceKey(database, collection string) string {
	return database + "\x00" + collection
}

var _ Stream = (*mongoDBStream)(nil)
