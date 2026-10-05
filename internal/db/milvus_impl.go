package db

import (
	"net/http"
	"time"

	"GoNavi-Wails/internal/ssh"
)

const (
	defaultMilvusPort         = 19530
	defaultMilvusDatabase     = "default"
	defaultMilvusQueryTimeout = 30 * time.Second

	milvusCollectionsListPath     = "/v2/vectordb/collections/list"
	milvusCollectionsDescribePath = "/v2/vectordb/collections/describe"
	milvusCollectionsCreatePath   = "/v2/vectordb/collections/create"
	milvusCollectionsDropPath     = "/v2/vectordb/collections/drop"
	milvusDatabasesListPath       = "/v2/vectordb/databases/list"
	milvusEntitiesQueryPath       = "/v2/vectordb/entities/query"
	milvusEntitiesDeletePath      = "/v2/vectordb/entities/delete"
	milvusEntitiesInsertPath      = "/v2/vectordb/entities/insert"
	milvusEntitiesUpsertPath      = "/v2/vectordb/entities/upsert"
	milvusEntitiesSearchPath      = "/v2/vectordb/entities/search"
	milvusIndexesCreatePath       = "/v2/vectordb/indexes/create"
	milvusIndexesDropPath         = "/v2/vectordb/indexes/drop"
)

// MilvusDB adapts the Milvus REST v2 API to GoNavi's generic database surface.
// Collections are exposed as tables and entity rows as query results.
type MilvusDB struct {
	client      *http.Client
	baseURL     string
	database    string
	authHeaders map[string]string
	forwarder   *ssh.LocalForwarder
}

var _ BatchApplierContext = (*MilvusDB)(nil)
