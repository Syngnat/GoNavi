package app

import (
	"regexp"
	"strings"
)

// Read-only SQL can still lock rows or call functions with server-side effects.
// The shared classifier proves "does not write"; the page bridge additionally
// rejects the common lock clauses and state-changing functions that plugins
// have no legitimate reason to use in v1. This is deliberately conservative:
// a rejected statement only loses the capability call, never data.
var pluginPageSQLSideEffectPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\bfor\s+(?:no\s+key\s+)?update\b`),
	regexp.MustCompile(`\bfor\s+(?:key\s+)?share\b`),
	regexp.MustCompile(`\block\s+in\s+share\s+mode\b`),
	regexp.MustCompile(`\bupdlock\b`),
	regexp.MustCompile(`\bholdlock\b`),
	regexp.MustCompile(`\bnextval\s*\(`),
	regexp.MustCompile(`\bsetval\s*\(`),
	regexp.MustCompile(`\bpg_terminate_backend\s*\(`),
	regexp.MustCompile(`\bpg_read_file\s*\(`),
}

// pluginPageSQLHasSideEffects tokenizes away literals and comments, then looks
// for lock clauses and high-risk function calls. Quoted identifiers keep their
// content so a quoted function name cannot slip through; this can reject a
// column literally named like a lock clause, which is the intended trade-off.
func pluginPageSQLHasSideEffects(query, dbType string) bool {
	normalized := strings.ToLower(pluginPageSQLTokens(query, dbType))
	for _, pattern := range pluginPageSQLSideEffectPatterns {
		if pattern.MatchString(normalized) {
			return true
		}
	}
	return false
}

func pluginPageSQLTokens(query, dbType string) string {
	var tokens strings.Builder
	for pos := 0; pos < len(query); {
		if query[pos] == '"' || query[pos] == '`' {
			if end := skipSQLDelimited(query, pos, query[pos]); end > pos+1 {
				tokens.WriteString(query[pos+1 : end-1])
				pos = end
				continue
			}
		}
		if query[pos] == '[' && supportsSQLBracketIdentifier(dbType) {
			if end := skipSQLBracketIdentifier(query, pos); end > pos+1 {
				tokens.WriteString(query[pos+1 : end-1])
				pos = end
				continue
			}
		}
		if next, ok := skipSQLQuotedOrComment(query, pos, dbType); ok {
			// String literals and comments are inert data, not SQL syntax.
			tokens.WriteByte(' ')
			pos = next
			continue
		}
		tokens.WriteByte(query[pos])
		pos++
	}
	return tokens.String()
}
