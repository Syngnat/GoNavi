package app

import (
	"os"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestImportSavedQueriesPersistsSQLWhenNameUnchanged 覆盖「同 ID 同名、只改 SQL」的导入回灌。
//
// 回归背景：Import 原先用 `existing := file.Queries` 直接引用底层数组，随后的下标原地写
// 同时污染了 file.Queries。replaceQueries 于是拿到一份「已含新 SQL 的旧快照」，
// 比较 previous.SQL == query.SQL 时成立而跳过写盘：接口返回新 SQL、saved_queries.json
// 元数据也被重写，但 <savedQueryDir>/<Name>.sql 仍是旧内容，下次读回旧 SQL，新 SQL 永久丢失且无报错。
//
// 既有的 TestImportSavedQueriesUpsertsAndSkipsInvalidItems 同时改了 Name，
// 会走「文件名变化 → 必然写盘」的分支，因此覆盖不到这条路径。
func TestImportSavedQueriesPersistsSQLWhenNameUnchanged(t *testing.T) {
	app := newSavedQueryTestApp(t)

	const id = "saved-alias"
	const name = "Orders"

	if _, err := app.SaveQuery(connection.SavedQuery{
		ID:           id,
		Name:         name,
		SQL:          "select 1",
		ConnectionID: "conn-1",
		DBName:       "app",
		CreatedAt:    100,
	}); err != nil {
		t.Fatalf("seed SaveQuery returned error: %v", err)
	}

	// 只改 SQL，Name 保持不变。
	imported, err := app.ImportSavedQueries(connection.SavedQueryImportPayload{
		Queries: []connection.SavedQuery{{
			ID:           id,
			Name:         name,
			SQL:          "select 2",
			ConnectionID: "conn-1",
			DBName:       "app",
			CreatedAt:    100,
		}},
	})
	if err != nil {
		t.Fatalf("ImportSavedQueries returned error: %v", err)
	}
	if len(imported) != 1 || imported[0].SQL != "select 2" {
		t.Fatalf("接口返回的 SQL 不是新值：%#v", imported)
	}

	// 关键断言：磁盘上的 .sql 必须真的被更新。
	diskFile, _ := readSavedQueriesDiskFile(t, app)
	if len(diskFile.Queries) != 1 {
		t.Fatalf("元数据条目数 = %d，期望 1", len(diskFile.Queries))
	}
	sqlPath := savedQuerySQLPath(t, app, diskFile.Queries[0].FileName)
	content, err := os.ReadFile(sqlPath)
	if err != nil {
		t.Fatalf("读取托管 SQL 文件失败：%v", err)
	}
	if got := string(content); got != "select 2" {
		t.Fatalf("磁盘 SQL = %q，期望 %q（同名改 SQL 的更新被静默丢弃）", got, "select 2")
	}

	// 再读一次，确认后续读取拿到的也是新 SQL。
	queries, err := app.GetSavedQueries()
	if err != nil {
		t.Fatalf("GetSavedQueries returned error: %v", err)
	}
	if len(queries) != 1 || queries[0].SQL != "select 2" {
		t.Fatalf("重新读取得到的 SQL 不是新值：%#v", queries)
	}
}
