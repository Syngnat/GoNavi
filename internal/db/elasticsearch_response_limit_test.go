//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"net/http"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestElasticsearchMetadataResponsesRejectOversizedBodies(t *testing.T) {
	testCases := []struct {
		name string
		path string
		call func(*ElasticsearchDB) error
	}{
		{
			name: "create statement",
			path: "/test-index",
			call: func(db *ElasticsearchDB) error {
				_, err := db.GetCreateStatement("test-index", "")
				return err
			},
		},
		{
			name: "settings",
			path: "/test-index/_settings",
			call: func(db *ElasticsearchDB) error {
				_, err := db.GetIndexes("test-index", "")
				return err
			},
		},
		{
			name: "mapping",
			path: "/test-index/_mapping",
			call: func(db *ElasticsearchDB) error {
				_, err := db.esFetchIndexMapping("test-index")
				return err
			},
		},
		{
			name: "bulk",
			path: "/_bulk",
			call: func(db *ElasticsearchDB) error {
				return db.ApplyChanges("test-index", connection.ChangeSet{
					Inserts: []map[string]interface{}{{"message": "hello"}},
				})
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
				if testCase.name == "bulk" && r.URL.Path == "/_alias/test-index" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if r.URL.Path == testCase.path {
					if testCase.name == "bulk" {
						// The alias probe treats a missing alias as a direct index.
						w.WriteHeader(http.StatusOK)
						_, _ = w.Write([]byte(strings.Repeat("x", maxRemoteJSONResponseBytes+1)))
						return
					}
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(strings.Repeat("x", maxRemoteJSONResponseBytes+1)))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			})

			db := newTestESDB(t, server.URL, "test-index")
			err := testCase.call(db)
			if err == nil || !strings.Contains(err.Error(), "32 MiB 上限") {
				t.Fatalf("oversized %s response error = %v", testCase.name, err)
			}
		})
	}
}
