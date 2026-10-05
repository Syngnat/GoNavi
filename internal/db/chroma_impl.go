package db

import (
	"net/http"
	"time"

	"GoNavi-Wails/internal/ssh"
)

const (
	defaultChromaPort           = 8000
	defaultChromaTenant         = "default_tenant"
	defaultChromaDatabase       = "default_database"
	defaultChromaQueryTimeout   = 30 * time.Second
	chromaFilteredCountPageSize = 10_000
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

var _ BatchApplierContext = (*ChromaDB)(nil)

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
