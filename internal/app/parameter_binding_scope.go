package app

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/sqlparam"
)

// 参数绑定路由：Oracle 家族的存储程序定义（触发器/过程/函数/包）体内出现的
// :NEW、:OLD 伪记录引用与 PL/SQL 赋值冒号不是查询编辑器的绑定参数，绑定
// 语义在 DDL 上也不成立（PLS-00049 / ORA-01027）。此类语句按原文执行，
// 不进入参数扫描与占位符重写；判定口径与前端 containsOraclePlsqlDefinition
// （useQueryEditorResultSetModel.ts）保持一致——正则应用在掩掉注释与
// 字符串字面量之后的文本上，CREATE 与对象关键词之间夹注释同样能识别。

var oracleStoredProgramDDLRe = regexp.MustCompile(
	`(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b`)

// statementQualifiesForParameterBinding 报告一条拆分后的语句是否参与参数
// 扫描与重写。仅 Oracle 家族的存储程序定义被排除，其余语句照常。
func statementQualifiesForParameterBinding(dbType, statement string) bool {
	if !sqlparam.IsOracleFamilyDBType(dbType) {
		return true
	}
	return !oracleStoredProgramDDLRe.MatchString(maskSQLCommentsAndLiterals(statement))
}

// maskSQLCommentsAndLiterals 把语句中的行/块注释与单引号字符串字面量替换为
// 空格（保留换行与总长度），供前缀正则判定。只做识别用掩码，不改原文。
func maskSQLCommentsAndLiterals(statement string) string {
	var b strings.Builder
	b.Grow(len(statement))
	inLineComment, inBlockComment, inSingle := false, false, false
	for i := 0; i < len(statement); i++ {
		ch := statement[i]
		switch {
		case inLineComment:
			if ch == '\n' {
				inLineComment = false
				b.WriteByte(ch)
			} else {
				b.WriteByte(' ')
			}
		case inBlockComment:
			if ch == '*' && i+1 < len(statement) && statement[i+1] == '/' {
				i++
				inBlockComment = false
				b.WriteString("  ")
			} else {
				b.WriteByte(' ')
			}
		case inSingle:
			if ch == '\'' {
				if i+1 < len(statement) && statement[i+1] == '\'' {
					b.WriteString("  ")
					i++
					continue
				}
				inSingle = false
				b.WriteByte('\'')
				continue
			}
			b.WriteByte(' ')
		default:
			switch {
			case ch == '-' && i+1 < len(statement) && statement[i+1] == '-':
				inLineComment = true
				b.WriteString("  ")
				i++
			case ch == '/' && i+1 < len(statement) && statement[i+1] == '*':
				inBlockComment = true
				b.WriteString("  ")
				i++
			case ch == '\'':
				inSingle = true
				b.WriteByte('\'')
			default:
				b.WriteByte(ch)
			}
		}
	}
	return b.String()
}
