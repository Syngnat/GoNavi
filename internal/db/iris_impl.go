//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"database/sql"
	"strings"
	"time"

	"GoNavi-Wails/internal/ssh"

	_ "github.com/caretdev/go-irisnative"
)

const (
	defaultIRISPort      = 1972
	defaultIRISNamespace = "USER"
)

type interSystemsProduct string

const (
	interSystemsProductIRIS  interSystemsProduct = "iris"
	interSystemsProductCache interSystemsProduct = "cache"
)

type IrisDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	namespace   string
	forwarder   *ssh.LocalForwarder
	product     interSystemsProduct
}

// CacheDB exposes InterSystems Caché as an independent data-source type while
// reusing the wire-compatible InterSystems SQL implementation. Keeping a
// dedicated wrapper preserves Caché connection identity, driver lifecycle and
// UI state instead of silently rewriting saved connections to IRIS.
type CacheDB struct {
	IrisDB
}

// productName/productType intentionally shadow the embedded IrisDB methods so
// a zero-value CacheDB already reports its stable Caché identity. This keeps
// connection identity independent even before Connect initializes the
// embedded implementation state.
func (c *CacheDB) productName() string {
	return "InterSystems Caché"
}

func (c *CacheDB) productType() string {
	return string(interSystemsProductCache)
}

var _ Database = (*IrisDB)(nil)
var _ Database = (*CacheDB)(nil)
var _ BatchApplierContext = (*IrisDB)(nil)
var _ BatchApplierContext = (*CacheDB)(nil)

type irisTableRef struct {
	Schema string
	Table  string
}

func normalizeIRISNamespace(namespace string) string {
	trimmed := strings.Trim(strings.TrimSpace(namespace), "/")
	if trimmed == "" {
		return defaultIRISNamespace
	}
	return trimmed
}

func (i *IrisDB) productName() string {
	if i != nil && i.product == interSystemsProductCache {
		return "InterSystems Caché"
	}
	return "InterSystems IRIS"
}

func (i *IrisDB) productType() string {
	if i != nil && i.product == interSystemsProductCache {
		return string(interSystemsProductCache)
	}
	return string(interSystemsProductIRIS)
}
