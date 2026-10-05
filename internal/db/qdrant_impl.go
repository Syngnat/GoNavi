package db

import (
	"net/http"
	"time"

	"GoNavi-Wails/internal/ssh"
)

const (
	defaultQdrantPort         = 6333
	defaultQdrantDatabase     = "default"
	defaultQdrantQueryTimeout = 30 * time.Second
)

type QdrantDB struct {
	client      *http.Client
	baseURL     string
	database    string
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
}

var _ BatchApplierContext = (*QdrantDB)(nil)

type qdrantCollectionInfo struct {
	Name string `json:"name"`
}

type qdrantListCollectionsResponse struct {
	Result struct {
		Collections []qdrantCollectionInfo `json:"collections"`
	} `json:"result"`
}

type qdrantCollectionResponse struct {
	Result map[string]interface{} `json:"result"`
}

type qdrantPoint struct {
	ID      interface{}            `json:"id"`
	Payload map[string]interface{} `json:"payload"`
	Vector  interface{}            `json:"vector"`
	Score   interface{}            `json:"score"`
	Version interface{}            `json:"version"`
}

type qdrantScrollResponse struct {
	Result struct {
		Points         []qdrantPoint `json:"points"`
		NextPageOffset interface{}   `json:"next_page_offset"`
	} `json:"result"`
}

type qdrantSearchResponse struct {
	Result []qdrantPoint `json:"result"`
}

type qdrantCountResponse struct {
	Result struct {
		Count int64 `json:"count"`
	} `json:"result"`
}
