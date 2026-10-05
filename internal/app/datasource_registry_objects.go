package app

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// 未借用方言的描述表数据源（如 GBase 8s）没有对应的历史方言分支，表 / 视图 / 例程的重命名、删除与清空
// 按描述表 ui.objectStatements 里声明的语句执行。

var registrySimpleIdentPattern = regexp.MustCompile(`^[a-z_][a-z0-9_$]*$`)

// registryQuoteIdent 按描述表的 ui.quoting 给标识符加引号。
func registryQuoteIdent(quoting, name string) string {
	switch quoting {
	case "pg":
		if registrySimpleIdentPattern.MatchString(name) {
			return name
		}
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	case "backtick":
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	case "bracket":
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	default:
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

// registryObjectStatement 返回描述表声明的对象操作语句；未声明该操作时返回 false，调用方走历史方言分支。
func registryObjectStatement(driverType, action string, names map[string]string) (string, bool) {
	spec, ok := db.DataSourceSpec(driverType)
	if !ok {
		return "", false
	}
	statement := strings.TrimSpace(spec.UI.ObjectStatements[action])
	if statement == "" {
		return "", false
	}
	for key, value := range names {
		replacement := strings.TrimSpace(value)
		if key != "type" {
			replacement = registryQuoteIdent(spec.UI.Quoting, strings.Trim(replacement, `"`))
		}
		statement = strings.ReplaceAll(statement, "{"+key+"}", replacement)
	}
	return statement, true
}

// registryHasObjectStatement 报告描述表是否声明了某个对象操作。
func registryHasObjectStatement(driverType, action string) bool {
	spec, ok := db.DataSourceSpec(driverType)
	return ok && strings.TrimSpace(spec.UI.ObjectStatements[action]) != ""
}

// execRegistryObjectStatement 在指定库上执行描述表声明的对象操作语句。
func (a *App) execRegistryObjectStatement(config connection.ConnectionConfig, dbName, statement, successKey string) connection.QueryResult {
	dbInst, err := a.getDatabase(buildRunConfigForDDL(config, resolveDDLDBType(config), dbName))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(statement); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText(successKey, nil)}
}
