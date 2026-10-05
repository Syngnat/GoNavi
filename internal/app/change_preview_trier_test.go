package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// fakePreviewTrierDB 模拟驱动代理：supported 为 false 时相当于旧版代理或驱动没有自己的预览。
type fakePreviewTrierDB struct {
	*fakeBatchWriteDB
	supported bool
}

func (f *fakePreviewTrierDB) TryPreviewChanges(string, connection.ChangeSet) ([]string, []string, []string, bool) {
	if !f.supported {
		return nil, nil, nil, false
	}
	return []string{"DELETE /collections/books/documents/1"}, []string{"PATCH /collections/books/documents/2"}, []string{"POST /collections/books/documents"}, true
}

func TestBuildChangePreviewPrefersDriverPreviewAndFallsBackToSQL(t *testing.T) {
	changes := connection.ChangeSet{Updates: []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": "2"},
		Values: map[string]interface{}{"title": "x"},
	}}}
	config := connection.ConnectionConfig{Type: "typesense"}

	driver := buildChangePreview(&fakePreviewTrierDB{fakeBatchWriteDB: &fakeBatchWriteDB{}, supported: true}, config, "books", changes)
	if len(driver.Updates) != 1 || driver.Updates[0] != "PATCH /collections/books/documents/2" || len(driver.Deletes) != 1 || len(driver.Inserts) != 1 {
		t.Fatalf("driver preview = %#v", driver)
	}

	fallback := buildChangePreview(&fakePreviewTrierDB{fakeBatchWriteDB: &fakeBatchWriteDB{}}, config, "books", changes)
	if len(fallback.Updates) != 1 || fallback.Updates[0] != `UPDATE "books" SET "title" = 'x' WHERE "id" = '2';` {
		t.Fatalf("fallback preview = %#v", fallback)
	}
}
