package app

import "strings"

// 实测会真正执行查询。只读事务加回滚挡得住普通写入，但挡不住这些：
//   - 序列取号（SQL Server NEXT VALUE FOR、Oracle NEXTVAL、MariaDB NEXTVAL/SETVAL）不随事务回滚；
//   - SQL Server 的 OPENQUERY / OPENROWSET / OPENDATASOURCE 在远端执行，本地回滚管不到；
//     SQL Server 也没有只读事务，只能靠这里拦。
// PostgreSQL 的 nextval/setval 在只读事务里直接报错，不需要拦。

// explainAnalyzeIrreversible returns the construct in query whose effect a
// rolled-back transaction cannot undo on dbType, or "" when there is none.
func explainAnalyzeIrreversible(dbType, query string) string {
	words := sqlWordsOutsideLiterals(dbType, query)
	for index, word := range words {
		nextValueFor := word == "next" && index+2 < len(words) && words[index+1] == "value" && words[index+2] == "for"
		switch dbType {
		case "sqlserver":
			if nextValueFor {
				return "NEXT VALUE FOR"
			}
			switch word {
			case "openquery", "openrowset", "opendatasource":
				return strings.ToUpper(word)
			}
		case "oracle":
			if word == "nextval" {
				return "NEXTVAL"
			}
		case "mysql", "mariadb":
			// A "mysql" connection may point at MariaDB, which has sequences.
			if nextValueFor {
				return "NEXT VALUE FOR"
			}
			if word == "nextval" || word == "setval" {
				return strings.ToUpper(word)
			}
		}
	}
	return ""
}

// sqlWordsOutsideLiterals lists the lower-cased words of a statement, skipping
// string literals, quoted identifiers and comments.
func sqlWordsOutsideLiterals(dbType, text string) []string {
	var words []string
	for pos := 0; pos < len(text); {
		if next, ok := skipSQLQuotedOrComment(text, pos, dbType); ok {
			pos = next
			continue
		}
		if isSQLKeywordByte(text[pos]) {
			end := pos + 1
			for end < len(text) && isSQLKeywordByte(text[end]) {
				end++
			}
			words = append(words, strings.ToLower(text[pos:end]))
			pos = end
			continue
		}
		pos++
	}
	return words
}
