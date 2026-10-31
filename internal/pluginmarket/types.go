// Package pluginmarket provides a bounded, offline-safe client for reviewed plugin catalogs.
package pluginmarket

import (
	"encoding/json"
	"net/http"
	"time"
)

// Options supplies host-owned configuration; TrustedOfficialURL must never come from marketplace metadata.
type Options struct {
	Root               string
	Client             *http.Client
	HostVersion        string
	TrustedOfficialURL string
}

// Settings describes the selected source. SourceID binds cached and installed data to one API base.
type Settings struct {
	BaseURL         string `json:"baseUrl"`
	SourceID        string `json:"sourceId"`
	TrustedOfficial bool   `json:"trustedOfficial"`
}

// Item is a published catalog entry. Manifest is declarative JSON, never executed by this package.
type Item struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Author         string          `json:"author"`
	PublisherID    string          `json:"publisherId"`
	Official       bool            `json:"official"`
	Version        string          `json:"version"`
	Category       string          `json:"category,omitempty"`
	MinHostVersion string          `json:"minHostVersion,omitempty"`
	SourceURL      string          `json:"sourceUrl,omitempty"`
	Platforms      []string        `json:"platforms"`
	RatingAverage  float64         `json:"ratingAverage"`
	RatingCount    int64           `json:"ratingCount"`
	DownloadCount  int64           `json:"downloadCount"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	Manifest       json.RawMessage `json:"manifest,omitempty"`
	Artifact       *Artifact       `json:"artifact,omitempty"`
	SourceID       string          `json:"sourceId"`
}

// Artifact identifies archive transport bytes, not the runtime's canonical installed-content digest.
type Artifact struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	Platform  string `json:"platform"`
	Version   string `json:"version"`
}

// CatalogPage marks cached fallback explicitly and is returned alongside a nonnil error on fetch failure.
type CatalogPage struct {
	FilterVersion int        `json:"filterVersion,omitempty"`
	Items         []Item     `json:"items"`
	NextCursor    string     `json:"nextCursor,omitempty"`
	Stale         bool       `json:"stale"`
	Error         string     `json:"error,omitempty"`
	CachedAt      *time.Time `json:"cachedAt,omitempty"`
	SourceID      string     `json:"sourceId"`
}

// Rating is the service-owned, mutable rating for one user and plugin.
type Rating struct {
	UserID    string    `json:"userId"`
	PluginID  string    `json:"pluginId"`
	Stars     int       `json:"stars"`
	Body      string    `json:"body"`
	Version   string    `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}
