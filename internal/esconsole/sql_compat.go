package esconsole

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// SimplifiedSelect is the deliberately small SQL compatibility surface that
// GoNavi exposes for Elasticsearch. It is converted to a classified REST
// request before execution; the SQL text is never passed to an HTTP client.
type SimplifiedSelect struct {
	Target  string
	Columns string
	Where   string
	OrderBy string
	Limit   int
	Offset  int
	Count   bool
}

var (
	esSQLFromKeyword = regexp.MustCompile(`(?i)\bFROM\s+`)
	esSQLTarget      = regexp.MustCompile(`^[A-Za-z0-9_*][A-Za-z0-9_.\-*]*$`)
	esSQLLimit       = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?`)
	esSQLOffset      = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)
	esSQLOrderBy     = regexp.MustCompile(`(?i)\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|\bOFFSET\b|$)`)
	esSQLWhere       = regexp.MustCompile(`(?i)\bWHERE\s+(.+?)(?:\bORDER\b|\bLIMIT\b|\bOFFSET\b|$)`)
	esSQLCount       = regexp.MustCompile(`(?i)\bCOUNT\s*\(`)
)

// ParseSimplifiedSelect parses the legacy SELECT compatibility syntax while
// applying an intentionally narrow index grammar. In particular, URL syntax,
// remote-cluster targets, encoded separators and control characters cannot be
// represented by this grammar.
func ParseSimplifiedSelect(source string) (SimplifiedSelect, error) {
	sql := strings.TrimSpace(source)
	if len(sql) < len("SELECT") || !strings.EqualFold(sql[:len("SELECT")], "SELECT") {
		return SimplifiedSelect{}, parseError(CodeInvalidHeader, "only simplified SELECT is supported by the Elasticsearch SQL compatibility mode", nil)
	}
	if len(sql) > len("SELECT") && !isESSQLSpace(sql[len("SELECT")]) {
		return SimplifiedSelect{}, parseError(CodeInvalidHeader, "invalid simplified SELECT statement", nil)
	}

	from := esSQLFromKeyword.FindStringIndex(sql)
	if from == nil || from[0] <= len("SELECT") {
		return SimplifiedSelect{}, parseError(CodeInvalidHeader, "simplified SELECT requires one FROM index", nil)
	}
	target, consumed, err := parseESSQLTarget(sql[from[1]:])
	if err != nil {
		return SimplifiedSelect{}, err
	}
	afterTarget := sql[from[1]+consumed:]
	if trimmed := strings.TrimSpace(afterTarget); strings.HasPrefix(trimmed, ".") || strings.HasPrefix(trimmed, `"`) {
		return SimplifiedSelect{}, parseError(CodeUnsafePath, "invalid Elasticsearch index in simplified SELECT", nil)
	}

	parsed := SimplifiedSelect{
		Target:  target,
		Columns: trimESSQLClause(sql[len("SELECT"):from[0]]),
	}
	if parsed.Columns == "" {
		parsed.Columns = "*"
	}
	parsed.Count = esSQLCount.MatchString(parsed.Columns)

	if match := esSQLWhere.FindStringSubmatch(sql); len(match) >= 2 {
		parsed.Where = trimESSQLClause(match[1])
	}
	if match := esSQLOrderBy.FindStringSubmatch(sql); len(match) >= 2 {
		parsed.OrderBy = trimESSQLClause(match[1])
	}
	if match := esSQLLimit.FindStringSubmatch(sql); len(match) >= 2 {
		parsed.Limit, _ = strconv.Atoi(match[1])
		if len(match) >= 3 && match[2] != "" {
			parsed.Offset, _ = strconv.Atoi(match[2])
		}
	}
	if parsed.Offset == 0 {
		if match := esSQLOffset.FindStringSubmatch(sql); len(match) >= 2 {
			parsed.Offset, _ = strconv.Atoi(match[1])
		}
	}
	return parsed, nil
}

func parseESSQLTarget(rest string) (string, int, error) {
	leading := len(rest) - len(strings.TrimLeft(rest, " \t\r\n"))
	value := rest[leading:]
	if value == "" {
		return "", 0, parseError(CodeUnsafePath, "simplified SELECT requires an Elasticsearch index", nil)
	}
	if value[0] != '"' {
		end := 0
		for end < len(value) && !isESSQLSpace(value[end]) && value[end] != ';' {
			end++
		}
		target := value[:end]
		if !esSQLTarget.MatchString(target) {
			return "", 0, parseError(CodeUnsafePath, "invalid Elasticsearch index in simplified SELECT", nil)
		}
		return target, leading + end, nil
	}

	var parts []string
	position := 0
	for {
		if position >= len(value) || value[position] != '"' {
			return "", 0, parseError(CodeUnsafePath, "invalid quoted Elasticsearch index in simplified SELECT", nil)
		}
		end := strings.IndexByte(value[position+1:], '"')
		if end < 0 {
			return "", 0, parseError(CodeUnsafePath, "unterminated quoted Elasticsearch index", nil)
		}
		end += position + 1
		part := value[position+1 : end]
		if !esSQLTarget.MatchString(part) {
			return "", 0, parseError(CodeUnsafePath, "invalid quoted Elasticsearch index in simplified SELECT", nil)
		}
		parts = append(parts, part)
		position = end + 1
		if position >= len(value) || value[position] != '.' {
			break
		}
		position++
	}
	if position < len(value) && !isESSQLSpace(value[position]) && value[position] != ';' {
		return "", 0, parseError(CodeUnsafePath, "invalid Elasticsearch index suffix in simplified SELECT", nil)
	}
	return strings.Join(parts, "."), leading + position, nil
}

func isESSQLSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func trimESSQLClause(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimRight(value, " \t\r\n;；")
	return strings.TrimSpace(value)
}

func buildSimplifiedSelectRequest(source string, serverMajor int) (Batch, error) {
	parsed, err := ParseSimplifiedSelect(source)
	if err != nil {
		return Batch{}, err
	}
	query := convertESSQLWhere(parsed.Where)
	if query == nil {
		query = map[string]interface{}{"match_all": map[string]interface{}{}}
	}
	payload := map[string]interface{}{"query": query}
	route := "_search"
	if parsed.Count {
		route = "_count"
	} else {
		if parsed.Limit > 0 {
			payload["size"] = parsed.Limit
		} else {
			payload["size"] = 200
		}
		if parsed.Offset > 0 {
			payload["from"] = parsed.Offset
		}
		if sorts := convertESSQLOrderBy(parsed.OrderBy); len(sorts) > 0 {
			payload["sort"] = sorts
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Batch{}, parseError(CodeInvalidJSON, "unable to encode simplified SELECT request", err)
	}
	requestPath, _, err := normalizeRequestTarget("/" + parsed.Target + "/" + route)
	if err != nil {
		return Batch{}, err
	}
	batch := Batch{Requests: []Request{{
		Method:   "POST",
		Path:     requestPath,
		Body:     string(body),
		Kind:     KindREST,
		BodyKind: BodyJSON,
	}}}
	if err := prepareBatch(&batch, serverMajor); err != nil {
		return Batch{}, err
	}
	finalizeBatch(&batch)
	if batch.Blocked {
		return Batch{}, parseError(CodeUnsafePath, batch.Requests[0].BlockReason, nil)
	}
	return batch, nil
}

func convertESSQLWhere(where string) map[string]interface{} {
	where = strings.TrimSpace(where)
	if where == "" {
		return nil
	}
	for len(where) >= 2 && where[0] == '(' && where[len(where)-1] == ')' && balancedESSQLParens(where[1:len(where)-1]) {
		where = strings.TrimSpace(where[1 : len(where)-1])
	}
	if parts := splitESSQLTopLevel(where, "AND"); len(parts) > 1 {
		clauses := make([]map[string]interface{}, 0, len(parts))
		for _, part := range parts {
			if query := convertESSQLWhere(part); query != nil {
				clauses = append(clauses, query)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"must": clauses}}
		}
		return nil
	}
	if parts := splitESSQLTopLevel(where, "OR"); len(parts) > 1 {
		clauses := make([]map[string]interface{}, 0, len(parts))
		for _, part := range parts {
			if query := convertESSQLWhere(part); query != nil {
				clauses = append(clauses, query)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"should": clauses}}
		}
		return nil
	}
	return parseESSQLCondition(where)
}

func parseESSQLCondition(condition string) map[string]interface{} {
	condition = strings.TrimSpace(strings.Trim(strings.TrimSpace(condition), "()"))
	if condition == "" {
		return nil
	}
	patterns := []struct {
		expression string
		build      func(string) map[string]interface{}
	}{
		{`(?i)^"?(.+?)"?\s+IS\s+NOT\s+NULL$`, func(field string) map[string]interface{} {
			return map[string]interface{}{"exists": map[string]interface{}{"field": cleanESSQLIdentifier(field)}}
		}},
		{`(?i)^"?(.+?)"?\s+IS\s+NULL$`, func(field string) map[string]interface{} {
			return map[string]interface{}{"bool": map[string]interface{}{"must_not": []map[string]interface{}{{"exists": map[string]interface{}{"field": cleanESSQLIdentifier(field)}}}}}
		}},
	}
	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern.expression)
		if match := re.FindStringSubmatch(condition); len(match) == 2 {
			return pattern.build(match[1])
		}
	}
	for _, spec := range []struct {
		expression string
		negated    bool
	}{
		{`(?i)^"?(.+?)"?\s+NOT\s+LIKE\s+'(.+)'$`, true},
		{`(?i)^"?(.+?)"?\s+LIKE\s+'(.+)'$`, false},
	} {
		re := regexp.MustCompile(spec.expression)
		if match := re.FindStringSubmatch(condition); len(match) == 3 {
			pattern := strings.NewReplacer("%", "*", "_", "?").Replace(match[2])
			query := map[string]interface{}{"wildcard": map[string]interface{}{cleanESSQLIdentifier(match[1]): pattern}}
			if spec.negated {
				return map[string]interface{}{"bool": map[string]interface{}{"must_not": []map[string]interface{}{query}}}
			}
			return query
		}
	}
	for _, operator := range []string{"!=", "<>", ">=", "<=", ">", "<", "="} {
		if position := findESSQLOperator(condition, operator); position >= 0 {
			field := cleanESSQLIdentifier(condition[:position])
			value := parseESSQLValue(condition[position+len(operator):])
			if field == "" {
				break
			}
			switch operator {
			case "!=", "<>":
				return map[string]interface{}{"bool": map[string]interface{}{"must_not": []map[string]interface{}{{"term": map[string]interface{}{field: value}}}}}
			case ">=", "<=", ">", "<":
				comparison := map[string]string{">=": "gte", "<=": "lte", ">": "gt", "<": "lt"}[operator]
				return map[string]interface{}{"range": map[string]interface{}{field: map[string]interface{}{comparison: value}}}
			default:
				return map[string]interface{}{"term": map[string]interface{}{field: value}}
			}
		}
	}
	return map[string]interface{}{"query_string": map[string]interface{}{"query": condition}}
}

func cleanESSQLIdentifier(value string) string {
	return strings.Trim(strings.TrimSpace(value), `"'`)
}

func parseESSQLValue(value string) interface{} {
	value = strings.Trim(strings.TrimSpace(value), `"'`)
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	if strings.EqualFold(value, "true") {
		return true
	}
	if strings.EqualFold(value, "false") {
		return false
	}
	return value
}

func findESSQLOperator(condition, operator string) int {
	quote := byte(0)
	depth := 0
	for index := 0; index+len(operator) <= len(condition); index++ {
		character := condition[index]
		if character == '\'' || character == '"' {
			if quote == 0 {
				quote = character
			} else if quote == character {
				quote = 0
			}
			continue
		}
		if quote != 0 {
			continue
		}
		if character == '(' {
			depth++
			continue
		}
		if character == ')' {
			depth--
			continue
		}
		if depth == 0 && condition[index:index+len(operator)] == operator {
			if (operator == ">" || operator == "<") && index+1 < len(condition) && (condition[index+1] == '=' || condition[index+1] == '>') {
				continue
			}
			return index
		}
	}
	return -1
}

func splitESSQLTopLevel(value, keyword string) []string {
	upper := strings.ToUpper(value)
	quote := byte(0)
	depth := 0
	start := 0
	var parts []string
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character == '\'' || character == '"' {
			if quote == 0 {
				quote = character
			} else if quote == character {
				quote = 0
			}
			continue
		}
		if quote != 0 {
			continue
		}
		if character == '(' {
			depth++
			continue
		}
		if character == ')' {
			depth--
			continue
		}
		end := index + len(keyword)
		if depth == 0 && end <= len(value) && upper[index:end] == keyword {
			beforeOK := index == 0 || strings.ContainsRune(" ()\t\r\n", rune(value[index-1]))
			afterOK := end == len(value) || strings.ContainsRune(" ()\t\r\n", rune(value[end]))
			if beforeOK && afterOK {
				parts = append(parts, strings.TrimSpace(value[start:index]))
				start = end
			}
		}
	}
	parts = append(parts, strings.TrimSpace(value[start:]))
	return parts
}

func balancedESSQLParens(value string) bool {
	depth := 0
	quote := byte(0)
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character == '\'' || character == '"' {
			if quote == 0 {
				quote = character
			} else if quote == character {
				quote = 0
			}
			continue
		}
		if quote != 0 {
			continue
		}
		if character == '(' {
			depth++
		} else if character == ')' {
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return depth == 0 && quote == 0
}

func convertESSQLOrderBy(orderBy string) []map[string]interface{} {
	var sorts []map[string]interface{}
	for _, raw := range strings.Split(orderBy, ",") {
		fields := strings.Fields(strings.TrimSpace(raw))
		if len(fields) == 0 {
			continue
		}
		field := cleanESSQLIdentifier(fields[0])
		if field == "" {
			continue
		}
		order := "asc"
		if len(fields) >= 2 && strings.EqualFold(fields[1], "DESC") {
			order = "desc"
		}
		sorts = append(sorts, map[string]interface{}{field: order})
	}
	return sorts
}

// CompactSimplifiedSelectBody is used by legacy DB tests and adapters that
// need the exact normalized REST body without exposing parser internals.
func CompactSimplifiedSelectBody(source string) (SimplifiedSelect, string, error) {
	parsed, err := ParseSimplifiedSelect(source)
	if err != nil {
		return SimplifiedSelect{}, "", err
	}
	batch, err := buildSimplifiedSelectRequest(source, 0)
	if err != nil {
		return SimplifiedSelect{}, "", err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(batch.Requests[0].Body)); err != nil {
		return SimplifiedSelect{}, "", err
	}
	return parsed, compact.String(), nil
}
