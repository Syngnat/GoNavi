package synccdc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	mongoDBAdapterName       = "mongodb-change-stream"
	mongoPositionVersion     = 1
	mongoResumeTokenFormat   = "bson-base64-v1"
	mongoMaxPositionBytes    = 2 << 20
	mongoMaxResumeTokenBytes = 1 << 20
)

type mongoOperationTime struct {
	Seconds   uint32 `json:"seconds"`
	Increment uint32 `json:"increment"`
}

type mongoPositionPayload struct {
	Version         int                 `json:"version"`
	ScopeHash       string              `json:"scopeHash"`
	ResumeTokenBSON string              `json:"resumeTokenBson,omitempty"`
	ResumeFormat    string              `json:"resumeFormat,omitempty"`
	OperationTime   *mongoOperationTime `json:"operationTime,omitempty"`
}

func mongoOperationTimePosition(scopeHash string, timestamp bson.Timestamp) (Position, error) {
	if timestamp.IsZero() {
		return Position{}, errors.New("MongoDB CDC operation time is empty")
	}
	return marshalMongoPosition(mongoPositionPayload{
		Version:   mongoPositionVersion,
		ScopeHash: strings.TrimSpace(scopeHash),
		OperationTime: &mongoOperationTime{
			Seconds:   timestamp.T,
			Increment: timestamp.I,
		},
	})
}

func mongoResumeTokenPosition(scopeHash string, token bson.Raw) (Position, error) {
	if len(token) == 0 {
		return Position{}, errors.New("MongoDB CDC resume token is empty")
	}
	if err := token.Validate(); err != nil {
		return Position{}, fmt.Errorf("MongoDB CDC resume token is invalid BSON: %w", err)
	}
	return marshalMongoPosition(mongoPositionPayload{
		Version:         mongoPositionVersion,
		ScopeHash:       strings.TrimSpace(scopeHash),
		ResumeTokenBSON: base64.RawURLEncoding.EncodeToString(token),
		ResumeFormat:    mongoResumeTokenFormat,
	})
}

func marshalMongoPosition(payload mongoPositionPayload) (Position, error) {
	if strings.TrimSpace(payload.ScopeHash) == "" {
		return Position{}, errors.New("MongoDB CDC position scope is required")
	}
	opaque, err := json.Marshal(payload)
	if err != nil {
		return Position{}, fmt.Errorf("encode MongoDB CDC position: %w", err)
	}
	return Position{Adapter: mongoDBAdapterName, Opaque: opaque}, nil
}

func decodeMongoPosition(position Position) (mongoPositionPayload, bson.Raw, *bson.Timestamp, error) {
	if err := ValidatePosition(position, mongoDBAdapterName); err != nil {
		return mongoPositionPayload{}, nil, nil, err
	}
	if len(position.Opaque) > mongoMaxPositionBytes {
		return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC position exceeds the supported size")
	}
	decoder := json.NewDecoder(bytes.NewReader(position.Opaque))
	decoder.DisallowUnknownFields()
	var payload mongoPositionPayload
	if err := decoder.Decode(&payload); err != nil {
		return mongoPositionPayload{}, nil, nil, fmt.Errorf("decode MongoDB CDC position: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC position must contain exactly one JSON object")
	}
	if payload.Version != mongoPositionVersion {
		return mongoPositionPayload{}, nil, nil, fmt.Errorf("unsupported MongoDB CDC position version %d", payload.Version)
	}
	if strings.TrimSpace(payload.ScopeHash) == "" {
		return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC position scope is required")
	}
	hasToken := strings.TrimSpace(payload.ResumeTokenBSON) != ""
	hasOperationTime := payload.OperationTime != nil
	if hasToken == hasOperationTime {
		return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC position must contain exactly one resume token or operation time")
	}
	if hasToken {
		if payload.ResumeFormat != mongoResumeTokenFormat {
			return mongoPositionPayload{}, nil, nil, fmt.Errorf("unsupported MongoDB CDC resume token format %q", payload.ResumeFormat)
		}
		raw, err := base64.RawURLEncoding.DecodeString(payload.ResumeTokenBSON)
		if err != nil {
			return mongoPositionPayload{}, nil, nil, fmt.Errorf("decode MongoDB CDC resume token: %w", err)
		}
		if len(raw) > mongoMaxResumeTokenBytes {
			return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC resume token exceeds the supported size")
		}
		token := bson.Raw(raw)
		if err := token.Validate(); err != nil {
			return mongoPositionPayload{}, nil, nil, fmt.Errorf("MongoDB CDC resume token is invalid BSON: %w", err)
		}
		return payload, token, nil, nil
	}
	timestamp := bson.Timestamp{T: payload.OperationTime.Seconds, I: payload.OperationTime.Increment}
	if timestamp.IsZero() {
		return mongoPositionPayload{}, nil, nil, errors.New("MongoDB CDC operation time is empty")
	}
	return payload, nil, &timestamp, nil
}

func mongoPositionIdentity(position Position) (string, error) {
	payload, token, operationTime, err := decodeMongoPosition(position)
	if err != nil {
		return "", err
	}
	if len(token) > 0 {
		return payload.ScopeHash + ":token:" + base64.RawURLEncoding.EncodeToString(token), nil
	}
	return fmt.Sprintf("%s:time:%d:%d", payload.ScopeHash, operationTime.T, operationTime.I), nil
}
