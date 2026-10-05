package db

import (
	"errors"
	"fmt"
	"strings"
)

func navicatMySQLTransactionCommand(query string) string {
	tokens := navicatMySQLLeadingTokens(query, 4)
	if len(tokens) == 0 {
		return ""
	}
	switch tokens[0] {
	case "BEGIN":
		return "begin"
	case "COMMIT", "ROLLBACK":
		return "finish"
	case "SAVEPOINT":
		return "savepoint"
	case "START":
		if len(tokens) > 1 && tokens[1] == "TRANSACTION" {
			return "begin"
		}
	case "RELEASE":
		if len(tokens) > 1 && tokens[1] == "SAVEPOINT" {
			return "savepoint"
		}
	case "SET":
		for _, token := range tokens[1:] {
			if token == "AUTOCOMMIT" {
				return "autocommit"
			}
		}
	case "XA":
		if len(tokens) < 2 {
			return ""
		}
		switch tokens[1] {
		case "START", "BEGIN", "END", "PREPARE", "COMMIT", "ROLLBACK":
			return "xa"
		}
	}
	return ""
}

func navicatMySQLLeadingTokens(query string, limit int) []string {
	tokens := make([]string, 0, limit)
	var scan func(string)
	scan = func(sqlText string) {
		for index := 0; index < len(sqlText) && len(tokens) < limit; {
			for index < len(sqlText) && sqlText[index] <= ' ' {
				index++
			}
			if index >= len(sqlText) {
				return
			}
			if sqlText[index] == '#' {
				if newline := strings.IndexByte(sqlText[index:], '\n'); newline >= 0 {
					index += newline + 1
					continue
				}
				return
			}
			if strings.HasPrefix(sqlText[index:], "--") && index+2 < len(sqlText) && sqlText[index+2] <= ' ' {
				if newline := strings.IndexByte(sqlText[index:], '\n'); newline >= 0 {
					index += newline + 1
					continue
				}
				return
			}
			if strings.HasPrefix(sqlText[index:], "/*") {
				end := strings.Index(sqlText[index+2:], "*/")
				if end < 0 {
					return
				}
				comment := sqlText[index+2 : index+2+end]
				if strings.HasPrefix(comment, "!") {
					executable := strings.TrimSpace(strings.TrimPrefix(comment, "!"))
					for len(executable) > 0 && executable[0] >= '0' && executable[0] <= '9' {
						executable = executable[1:]
					}
					scan(executable)
				}
				index += 2 + end + 2
				continue
			}
			if (sqlText[index] >= 'a' && sqlText[index] <= 'z') || (sqlText[index] >= 'A' && sqlText[index] <= 'Z') || sqlText[index] == '_' {
				start := index
				for index < len(sqlText) && ((sqlText[index] >= 'a' && sqlText[index] <= 'z') || (sqlText[index] >= 'A' && sqlText[index] <= 'Z') || (sqlText[index] >= '0' && sqlText[index] <= '9') || sqlText[index] == '_') {
					index++
				}
				tokens = append(tokens, strings.ToUpper(sqlText[start:index]))
				continue
			}
			if sqlText[index] == '=' {
				tokens = append(tokens, "=")
				index++
				continue
			}
			if sqlText[index] == '@' || sqlText[index] == '.' {
				index++
				continue
			}
			return
		}
	}
	scan(query)
	return tokens
}

func validateNavicatMySQLTransactionBatch(queries []string) error {
	transactionOpen := false
	for index, query := range queries {
		switch navicatMySQLTransactionCommand(query) {
		case "begin":
			if transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条语句重复开启事务", index+1)
			}
			transactionOpen = true
		case "finish":
			if !transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条事务结束语句没有同请求内的事务起点", index+1)
			}
			transactionOpen = false
		case "savepoint":
			if !transactionOpen {
				return fmt.Errorf("Navicat HTTP 隧道第 %d 条保存点语句没有同请求内的事务", index+1)
			}
		case "autocommit":
			return fmt.Errorf("Navicat HTTP 隧道不支持跨请求保留 autocommit 状态；请在同一批次使用 START TRANSACTION 和 COMMIT/ROLLBACK")
		case "xa":
			return errors.New("Navicat HTTP 隧道不支持可能跨请求存续的 XA 事务")
		}
	}
	if transactionOpen {
		return errors.New("Navicat HTTP 隧道事务必须在同一请求内以 COMMIT 或 ROLLBACK 结束")
	}
	return nil
}
