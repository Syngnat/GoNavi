package sqlparam

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func loadFixtureLines(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/issue-1326-oracle11g.sql")
	if err != nil {
		t.Fatalf("read sql: %v", err)
	}
	return strings.Split(string(raw), "\n")
}

func hasDatefr(names []string) bool {
	for _, n := range names {
		if n == "datefr" {
			return true
		}
	}
	return false
}

// 完整 SQL 必须找全 6 个参数（用户实测只显示 4 个，datefr/dateto 丢失）。
// mysql 因 BackslashEscapes=true 语义上将 \' 视为转义引号，datefr/dateto
// 确实会丢失（MySQL 语义的合理行为），故只测 oracle 系。
func TestReproUserFullSQLFromFixture(t *testing.T) {
	sql := strings.Join(loadFixtureLines(t), "\n")
	for _, dbType := range []string{"oracle", "dameng", "kingbase"} {
		t.Run(dbType, func(t *testing.T) {
			names := Names(sql, OptionsForDBType(dbType))
			if !hasDatefr(names) {
				t.Fatalf("[%s] datefr/dateto lost. names=%v", dbType, names)
			}
		})
	}
}

// 探针：每行行尾插入 ${probeN}，扫描后标记哪些行的探针丢失。
// `--` 注释行的探针在注释内被吞属正常行为。
func TestReproUserPoisonedZones(t *testing.T) {
	lines := loadFixtureLines(t)
	probes := map[int]string{}
	for i := range lines {
		probes[i] = "probe" + strconv.Itoa(i)
		lines[i] = lines[i] + " ${" + probes[i] + "}"
	}
	sql := strings.Join(lines, "\n")
	got := map[string]bool{}
	for _, n := range Names(sql, OptionsForDBType("oracle")) {
		got[n] = true
	}
	poisoned := []int{}
	for i := range lines {
		if !got[probes[i]] {
			poisoned = append(poisoned, i+1)
		}
	}
	t.Logf("poisoned lines (1-based, comment-line hits are expected): %v", poisoned)
}

// 最终 SELECT 单独扫描：datefr 应当存在。
func TestReproUserFinalStatementAlone(t *testing.T) {
	lines := loadFixtureLines(t)
	jsonIdx := jsonIdxOfFixture(lines)
	selectStart := jsonIdx - 1
	sql := strings.Join(lines[selectStart:], "\n")
	if !hasDatefr(Names(sql, OptionsForDBType("oracle"))) {
		t.Fatal("final statement alone lost datefr")
	}
}

// 语句内部逐行截断（从 datefr 行往后逐行延伸），观察 datefr 何时丢失。
func TestReproUserStatementSuffixBisect(t *testing.T) {
	lines := loadFixtureLines(t)
	datefrLine := -1
	for i, l := range lines {
		if strings.Contains(l, "${datefr}") {
			datefrLine = i
			break
		}
	}
	if datefrLine < 0 {
		t.Fatal("datefr line not found")
	}
	selectStart := jsonIdxOfFixture(lines) - 1
	for suffixEnd := datefrLine + 1; suffixEnd <= len(lines); suffixEnd++ {
		sql3 := strings.Join(lines[selectStart:suffixEnd], "\n")
		if !hasDatefr(Names(sql3, OptionsForDBType("oracle"))) {
			t.Fatalf("[suffix-bisect] datefr lost when statement extended through line %d: %q", suffixEnd, lines[suffixEnd-1])
		}
	}
	t.Log("[suffix-bisect] datefr survived full statement")
}

func jsonIdxOfFixture(lines []string) int {
	for i, l := range lines {
		if strings.Contains(l, `{"o":"`) {
			return i
		}
	}
	return -1
}
