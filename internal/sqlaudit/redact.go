package sqlaudit

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var sqlQueryTypes = map[string]struct{}{
	"mysql": {}, "mariadb": {}, "goldendb": {}, "greatdb": {}, "gdb": {},
	"oceanbase": {}, "doris": {}, "diros": {}, "starrocks": {}, "sphinx": {},
	"postgres": {}, "postgresql": {}, "sqlserver": {}, "mssql": {}, "sqlite": {},
	"duckdb": {}, "oracle": {}, "dameng": {}, "dm": {}, "kingbase": {}, "highgo": {},
	"vastbase": {}, "opengauss": {}, "gaussdb": {}, "iris": {}, "intersystems": {},
	"tdengine": {}, "iotdb": {}, "clickhouse": {}, "trino": {}, "custom": {},
	"gonavi": {},
}

var redisReadCommands = map[string]struct{}{
	"GET": {}, "MGET": {}, "GETDEL": {}, "GETEX": {}, "STRLEN": {}, "TYPE": {},
	"TTL": {}, "PTTL": {}, "EXPIRETIME": {}, "PEXPIRETIME": {}, "EXISTS": {},
	"DEL": {}, "UNLINK": {}, "TOUCH": {}, "DUMP": {}, "OBJECT": {}, "KEYS": {},
	"SCAN": {}, "HGET": {}, "HMGET": {}, "HGETALL": {}, "HEXISTS": {}, "HLEN": {},
	"HKEYS": {}, "HVALS": {}, "HSCAN": {}, "LINDEX": {}, "LLEN": {}, "LRANGE": {},
	"LPOS": {}, "SCARD": {}, "SMEMBERS": {}, "SISMEMBER": {}, "SMISMEMBER": {},
	"SSCAN": {}, "ZCARD": {}, "ZCOUNT": {}, "ZLEXCOUNT": {}, "ZRANGE": {},
	"ZRANGEBYSCORE": {}, "ZRANK": {}, "ZREVRANK": {}, "ZSCORE": {}, "ZMSCORE": {},
	"ZSCAN": {}, "XRANGE": {}, "XREVRANGE": {}, "XLEN": {}, "XREAD": {}, "XINFO": {},
	"PFCOUNT": {}, "BITCOUNT": {}, "GETBIT": {}, "GEODIST": {}, "GEOHASH": {},
	"GEOPOS": {}, "GEOSEARCH": {}, "JSON.GET": {}, "JSON.MGET": {}, "JSON.TYPE": {},
	"JSON.OBJKEYS": {}, "JSON.OBJLEN": {}, "JSON.ARRLEN": {}, "TS.GET": {},
	"TS.RANGE": {}, "TS.REVRANGE": {}, "TS.MGET": {}, "TS.MRANGE": {},
}

var redisMultiKeyCommands = map[string]struct{}{
	"MGET": {}, "DEL": {}, "UNLINK": {}, "EXISTS": {}, "TOUCH": {},
}

// RedactQuery dispatches query sanitization by data-source type. SQL dialects
// use the SQL lexer, Redis retains only commands/keys and replaces values, and
// known non-SQL/message or unknown query languages default to metadata-only.
func RedactQuery(dbType, text string) string {
	normalizedType := normalizeQueryType(dbType)
	if normalizedType == "redis" {
		return redactRedisQuery(text)
	}
	if _, ok := sqlQueryTypes[normalizedType]; ok {
		return RedactSQL(text)
	}
	return ""
}

const (
	maxSQLRunes   = 64 * 1024
	maxErrorRunes = 4 * 1024
)

var (
	sensitiveAssignmentPattern = regexp.MustCompile(`(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\b(\s*(?:=|:)\s*)([^\s,;]+)`)
	identifiedByPattern        = regexp.MustCompile(`(?i)\b(identified\s+by)(\s+)([^\s,;]+)`)
	uriUserInfoPattern         = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^\s/@:]+)(?::[^\s/@]*)?@`)
	bareUserInfoPattern        = regexp.MustCompile(`(?i)\b[^\s:@/]+:[^\s@/]+@(\[[^\]\s]+\]|[a-z0-9.-]+)`)
	slashUserInfoPattern       = regexp.MustCompile(`(?i)\b[^\s/@:]+/[^\s@/]+@([a-z0-9.-]+)(?:/[^\s,;]*)?`)
	bearerPattern              = regexp.MustCompile(`(?i)\bbearer\s+[a-z0-9._~+/=-]+`)
	basicAuthPattern           = regexp.MustCompile(`(?i)\bbasic\s+[a-z0-9+/=]+`)
	postgresKeyDetailPattern   = regexp.MustCompile(`(?i)(\bkey\s*\([^\)\r\n]*\)\s*=\s*)\([^\)\r\n]*\)`)
	duplicateKeyValuePattern   = regexp.MustCompile(`(?i)(\bduplicate\s+key\s+value\s+(?:is|was)\s*)\([^\)\r\n]*\)`)
	failingRowPattern          = regexp.MustCompile(`(?i)(\bfailing\s+row\s+contains\s*)\([^\)\r\n]*\)`)
)

// RedactSQL removes comments and literal values while retaining enough SQL
// structure for local diagnostics. It intentionally favors confidentiality
// over perfectly preserving dialect-specific quoted identifiers.
func RedactSQL(sqlText string) string {
	if strings.TrimSpace(sqlText) == "" {
		return ""
	}

	var out strings.Builder
	out.Grow(len(sqlText))
	for index := 0; index < len(sqlText); {
		if hasPrefixAt(sqlText, index, "--") || sqlText[index] == '#' {
			index = skipLineComment(sqlText, index)
			if index < len(sqlText) && (sqlText[index] == '\r' || sqlText[index] == '\n') {
				out.WriteByte('\n')
			}
			continue
		}
		if hasPrefixAt(sqlText, index, "/*") {
			index = skipBlockComment(sqlText, index+2)
			out.WriteByte(' ')
			continue
		}
		if next, ok := skipOracleQuotedLiteral(sqlText, index); ok {
			out.WriteByte('?')
			index = next
			continue
		}
		if sqlText[index] == '$' {
			if next, ok := skipDollarQuotedLiteral(sqlText, index); ok {
				out.WriteByte('?')
				index = next
				continue
			}
		}
		if sqlText[index] == '\'' || sqlText[index] == '"' {
			quote := sqlText[index]
			out.WriteByte(quote)
			out.WriteByte('?')
			out.WriteByte(quote)
			index = skipQuoted(sqlText, index, quote)
			continue
		}
		if isNumberStart(sqlText, index) {
			out.WriteByte('?')
			index = skipNumber(sqlText, index)
			continue
		}

		r, size := utf8.DecodeRuneInString(sqlText[index:])
		if r == utf8.RuneError && size == 1 {
			out.WriteRune(unicode.ReplacementChar)
			index++
			continue
		}
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			out.WriteByte(' ')
		} else {
			out.WriteRune(r)
		}
		index += size
	}

	redacted := sensitiveAssignmentPattern.ReplaceAllString(out.String(), `${1}${2}?`)
	redacted = identifiedByPattern.ReplaceAllString(redacted, `${1}${2}?`)
	redacted = uriUserInfoPattern.ReplaceAllString(redacted, `${1}***:***@`)
	redacted = bearerPattern.ReplaceAllString(redacted, "Bearer ***")
	return truncateRunes(strings.TrimSpace(redacted), maxSQLRunes)
}

// RedactError removes common credential forms and quoted values from a driver
// error before it enters the audit database.
func RedactError(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return ""
	}
	message = uriUserInfoPattern.ReplaceAllString(message, `${1}***:***@`)
	message = bareUserInfoPattern.ReplaceAllString(message, `***:***@$1`)
	message = slashUserInfoPattern.ReplaceAllString(message, `***/***@$1`)
	message = bearerPattern.ReplaceAllString(message, "Bearer ***")
	message = basicAuthPattern.ReplaceAllString(message, "Basic ***")
	message = postgresKeyDetailPattern.ReplaceAllString(message, `${1}(?)`)
	message = duplicateKeyValuePattern.ReplaceAllString(message, `${1}(?)`)
	message = failingRowPattern.ReplaceAllString(message, `${1}(?)`)
	message = sensitiveAssignmentPattern.ReplaceAllString(message, `${1}${2}***`)
	message = identifiedByPattern.ReplaceAllString(message, `${1}${2}***`)
	message = redactQuotedSegments(message)
	message = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, message)
	return truncateRunes(strings.TrimSpace(message), maxErrorRunes)
}

func normalizeQueryType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "redis-cluster", "redis_cluster", "redis-sentinel", "redis_sentinel":
		return "redis"
	case "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
		return "rocketmq"
	case "apache-kafka", "apache_kafka":
		return "kafka"
	case "rabbit-mq", "rabbit_mq":
		return "rabbitmq"
	case "elastic":
		return "elasticsearch"
	case "chromadb", "chroma-db":
		return "chroma"
	case "qdrantdb", "qdrant-db":
		return "qdrant"
	case "milvusdb", "milvus-db":
		return "milvus"
	default:
		return normalized
	}
}

func redactRedisQuery(text string) string {
	tokens, ok := tokenizeRedisQuery(text)
	if !ok || len(tokens) == 0 {
		return ""
	}
	command := strings.ToUpper(tokens[0])
	switch command {
	case "AUTH":
		if len(tokens) >= 3 {
			return "AUTH ? ?"
		}
		if len(tokens) == 2 {
			return "AUTH ?"
		}
		return "AUTH"
	case "HELLO":
		return redactRedisHello(tokens)
	case "CONFIG":
		return redactRedisConfig(tokens)
	case "ACL":
		return redactRedisACL(tokens)
	case "CLIENT":
		return redactRedisClient(tokens)
	case "SCRIPT":
		return redactRedisScript(tokens)
	case "FUNCTION":
		return redactRedisFunction(tokens)
	case "PING", "ECHO":
		if len(tokens) > 1 {
			return command + " ?"
		}
		return command
	case "MSET", "MSETNX":
		return redactRedisAlternatingPairs(command, tokens, 1)
	case "HSET", "HMSET":
		return redactRedisHashPairs(command, tokens)
	case "SET", "SETNX", "GETSET", "APPEND", "SETRANGE", "INCRBY", "INCRBYFLOAT",
		"DECRBY", "SETBIT", "SETEX", "PSETEX", "RESTORE", "LSET", "LINSERT",
		"HSETNX", "HINCRBY", "HINCRBYFLOAT", "LPUSH", "LPUSHX", "RPUSH", "RPUSHX",
		"LREM", "SADD", "SREM", "SMOVE",
		"ZADD", "ZINCRBY", "ZREM", "GEOADD", "PFADD", "PUBLISH", "SPUBLISH",
		"XADD", "XACK", "XCLAIM", "XAUTOCLAIM", "XDEL", "XGROUP", "XTRIM",
		"JSON.SET", "JSON.MERGE", "JSON.ARRAPPEND", "JSON.ARRINSERT", "JSON.ARRTRIM",
		"JSON.NUMINCRBY", "JSON.NUMMULTBY", "JSON.STRAPPEND", "TS.ADD", "TS.INCRBY",
		"TS.DECRBY":
		return redactRedisKeyAndPayload(command, tokens)
	case "EVAL", "EVALSHA", "FCALL", "FCALL_RO":
		return redactRedisScriptInvocation(command, tokens)
	case "MIGRATE", "MODULE":
		return command + " ?"
	case "SELECT", "SWAPDB":
		return command + redactRedisSafeArguments(tokens[1:])
	default:
		if _, ok := redisReadCommands[command]; !ok {
			return ""
		}
		if len(tokens) == 1 {
			return command
		}
		if _, ok := redisMultiKeyCommands[command]; ok {
			return command + redactRedisSafeArguments(tokens[1:])
		}
		// Retain the first key/pattern only. Later arguments can be members,
		// payloads or dialect-specific options and are omitted conservatively.
		return command + " " + formatRedisToken(tokens[1])
	}
}

func redactRedisHello(tokens []string) string {
	parts := []string{"HELLO"}
	index := 1
	if index < len(tokens) {
		if _, err := strconv.Atoi(tokens[index]); err == nil {
			parts = append(parts, tokens[index])
		} else {
			parts = append(parts, "?")
		}
		index++
	}
	for index < len(tokens) {
		switch strings.ToUpper(tokens[index]) {
		case "AUTH":
			parts = append(parts, "AUTH", "?", "?")
			index += 3
		case "SETNAME":
			parts = append(parts, "SETNAME", "?")
			index += 2
		default:
			// Unknown HELLO options may carry data; retain no further text.
			index = len(tokens)
		}
	}
	return strings.Join(parts, " ")
}

func redactRedisConfig(tokens []string) string {
	if len(tokens) < 2 {
		return "CONFIG"
	}
	subcommand := strings.ToUpper(tokens[1])
	switch subcommand {
	case "SET":
		if len(tokens) >= 3 {
			return "CONFIG SET " + formatRedisToken(tokens[2]) + " ?"
		}
		return "CONFIG SET ?"
	case "GET":
		if len(tokens) >= 3 {
			return "CONFIG GET " + formatRedisToken(tokens[2])
		}
		return "CONFIG GET"
	case "RESETSTAT", "REWRITE":
		return "CONFIG " + subcommand
	default:
		return "CONFIG"
	}
}

func redactRedisACL(tokens []string) string {
	if len(tokens) < 2 {
		return "ACL"
	}
	subcommand := strings.ToUpper(tokens[1])
	switch subcommand {
	case "SETUSER":
		if len(tokens) >= 3 {
			return "ACL SETUSER " + formatRedisToken(tokens[2]) + " ?"
		}
		return "ACL SETUSER ?"
	case "GETUSER", "DELUSER":
		if len(tokens) >= 3 {
			return "ACL " + subcommand + " " + formatRedisToken(tokens[2])
		}
		return "ACL " + subcommand
	case "LIST", "USERS", "WHOAMI", "CAT", "GENPASS", "LOG", "SAVE":
		return "ACL " + subcommand
	default:
		return "ACL"
	}
}

func redactRedisClient(tokens []string) string {
	if len(tokens) < 2 {
		return "CLIENT"
	}
	subcommand := strings.ToUpper(tokens[1])
	switch subcommand {
	case "SETNAME", "SETINFO", "KILL", "UNBLOCK":
		return "CLIENT " + subcommand + " ?"
	case "GETNAME", "ID", "INFO", "LIST", "PAUSE", "UNPAUSE", "REPLY", "TRACKING", "CACHING":
		return "CLIENT " + subcommand
	default:
		return "CLIENT"
	}
}

func redactRedisScript(tokens []string) string {
	if len(tokens) < 2 {
		return "SCRIPT"
	}
	subcommand := strings.ToUpper(tokens[1])
	switch subcommand {
	case "LOAD", "DEBUG":
		return "SCRIPT " + subcommand + " ?"
	case "EXISTS", "FLUSH", "KILL", "HELP":
		return "SCRIPT " + subcommand
	default:
		return "SCRIPT"
	}
}

func redactRedisFunction(tokens []string) string {
	if len(tokens) < 2 {
		return "FUNCTION"
	}
	subcommand := strings.ToUpper(tokens[1])
	switch subcommand {
	case "LOAD", "RESTORE":
		return "FUNCTION " + subcommand + " ?"
	case "DELETE":
		if len(tokens) >= 3 {
			return "FUNCTION DELETE " + formatRedisToken(tokens[2])
		}
		return "FUNCTION DELETE"
	case "DUMP", "FLUSH", "KILL", "LIST", "STATS", "HELP":
		return "FUNCTION " + subcommand
	default:
		return "FUNCTION"
	}
}

func redactRedisAlternatingPairs(command string, tokens []string, start int) string {
	if len(tokens) <= start || (len(tokens)-start)%2 != 0 {
		return command + " ?"
	}
	parts := []string{command}
	for index := start; index < len(tokens); index += 2 {
		parts = append(parts, formatRedisToken(tokens[index]))
		if index+1 < len(tokens) {
			parts = append(parts, "?")
		}
	}
	return strings.Join(parts, " ")
}

func redactRedisHashPairs(command string, tokens []string) string {
	if len(tokens) < 2 {
		return command
	}
	if (len(tokens)-2)%2 != 0 {
		return command + " " + formatRedisToken(tokens[1]) + " ?"
	}
	parts := []string{command, formatRedisToken(tokens[1])}
	for index := 2; index < len(tokens); index += 2 {
		parts = append(parts, formatRedisToken(tokens[index]))
		if index+1 < len(tokens) {
			parts = append(parts, "?")
		}
	}
	return strings.Join(parts, " ")
}

func redactRedisKeyAndPayload(command string, tokens []string) string {
	if len(tokens) < 2 {
		return command
	}
	result := command + " " + formatRedisToken(tokens[1])
	if len(tokens) > 2 {
		result += " ?"
	}
	return result
}

func redactRedisScriptInvocation(command string, tokens []string) string {
	if len(tokens) < 3 {
		return command + " ?"
	}
	numKeys, err := strconv.Atoi(tokens[2])
	if err != nil || numKeys < 0 {
		return command + " ?"
	}
	parts := []string{command, "?", strconv.Itoa(numKeys)}
	for index := 0; index < numKeys && 3+index < len(tokens); index++ {
		parts = append(parts, formatRedisToken(tokens[3+index]))
	}
	if 3+numKeys < len(tokens) {
		parts = append(parts, "?")
	}
	return strings.Join(parts, " ")
}

func redactRedisSafeArguments(tokens []string) string {
	if len(tokens) == 0 {
		return ""
	}
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		parts = append(parts, formatRedisToken(token))
	}
	return " " + strings.Join(parts, " ")
}

func tokenizeRedisQuery(text string) ([]string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, true
	}
	var tokens []string
	var current strings.Builder
	var quote rune
	escaped := false
	tokenStarted := false
	flush := func() {
		if !tokenStarted {
			return
		}
		tokens = append(tokens, current.String())
		current.Reset()
		tokenStarted = false
	}
	for _, r := range text {
		if escaped {
			current.WriteRune(r)
			escaped = false
			tokenStarted = true
			continue
		}
		if r == '\\' {
			escaped = true
			tokenStarted = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
			tokenStarted = true
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			tokenStarted = true
			continue
		}
		if unicode.IsSpace(r) {
			flush()
			continue
		}
		current.WriteRune(r)
		tokenStarted = true
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, false
	}
	flush()
	return tokens, true
}

func formatRedisToken(token string) string {
	token = truncateRunes(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, token), 512)
	if token == "" {
		return `""`
	}
	if strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return strconv.Quote(token)
	}
	return token
}

func queryFingerprintSeed(dbType, redactedText string) string {
	if redactedText != "" {
		return redactedText
	}
	// Metadata-only query languages intentionally do not include raw input in
	// their fingerprint. Payload-derived hashes can be dictionary-guessed when
	// messages contain low-entropy tokens, card numbers or common credentials.
	return "metadata:" + normalizeQueryType(dbType)
}

func sanitizeEvent(event Event, settings Settings) Event {
	event.Sequence = 0
	event.PrevHash = ""
	event.Hash = ""
	event.EventType = strings.ToLower(sanitizeLabel(event.EventType, 64))
	event.Status = strings.ToLower(sanitizeLabel(event.Status, 64))
	event.ConnectionID = sanitizeLabel(event.ConnectionID, 256)
	event.DBType = strings.ToLower(sanitizeLabel(event.DBType, 64))
	event.Database = sanitizeLabel(event.Database, 512)
	event.QueryID = sanitizeLabel(event.QueryID, 256)
	event.TransactionID = sanitizeLabel(event.TransactionID, 256)
	event.Source = strings.ToLower(sanitizeLabel(event.Source, 64))
	event.BoundaryMode = normalizeBoundaryMode(event.BoundaryMode)
	event.CommitMode = normalizeCommitMode(event.CommitMode)

	rawSQL := event.SQLText
	redactedSQL := RedactQuery(event.DBType, rawSQL)
	fingerprintSeed := queryFingerprintSeed(event.DBType, redactedSQL)
	event.SQLFingerprint = versionedDigest("sqlaudit-sql-fingerprint-v1", fingerprintSeed)
	event.SQLRedacted = true
	if settings.CaptureMode == CaptureModeMetadata {
		event.SQLText = ""
	} else {
		event.SQLText = redactedSQL
	}

	fingerprintSeed = strings.TrimSpace(event.ConnectionFingerprint)
	if fingerprintSeed == "" {
		fingerprintSeed = strings.Join([]string{event.ConnectionID, event.DBType, event.Database}, "\x00")
	}
	event.ConnectionFingerprint = versionedDigest("sqlaudit-connection-fingerprint-v1", fingerprintSeed)
	event.Error = RedactError(event.Error)
	if event.StatementIndex < 0 {
		event.StatementIndex = 0
	}
	if event.StatementCount < 0 {
		event.StatementCount = 0
	}
	if event.ExecutedCount < 0 {
		event.ExecutedCount = 0
	}
	if event.FailedIndex < 0 {
		event.FailedIndex = 0
	}
	if event.DurationMs < 0 {
		event.DurationMs = 0
	}
	if event.RowsAffected < 0 {
		event.RowsAffected = 0
	}
	if event.RowsReturned < 0 {
		event.RowsReturned = 0
	}
	return event
}

func normalizeBoundaryMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case BoundaryModeDriverAPI:
		return BoundaryModeDriverAPI
	case BoundaryModeTextSQL:
		return BoundaryModeTextSQL
	case BoundaryModeImplicit:
		return BoundaryModeImplicit
	default:
		return BoundaryModeUnknown
	}
}

func normalizeCommitMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case CommitModeAuto:
		return CommitModeAuto
	case CommitModeManual:
		return CommitModeManual
	case CommitModePending:
		return CommitModePending
	default:
		return ""
	}
}

func versionedDigest(version, value string) string {
	digest := sha256.Sum256([]byte(version + "\x00" + value))
	return hex.EncodeToString(digest[:])
}

func sanitizeLabel(value string, maxRunes int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.TrimSpace(value))
	return truncateRunes(value, maxRunes)
}

func truncateRunes(value string, max int) string {
	if max <= 0 || utf8.RuneCountInString(value) <= max {
		return value
	}
	runes := []rune(value)
	return string(runes[:max])
}

func redactQuotedSegments(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(value); {
		if value[index] == '\'' || value[index] == '"' {
			quote := value[index]
			out.WriteByte(quote)
			out.WriteByte('?')
			out.WriteByte(quote)
			index = skipQuoted(value, index, quote)
			continue
		}
		out.WriteByte(value[index])
		index++
	}
	return out.String()
}

func skipQuoted(value string, start int, quote byte) int {
	for index := start + 1; index < len(value); index++ {
		if value[index] == '\\' {
			index++
			continue
		}
		if value[index] != quote {
			continue
		}
		if index+1 < len(value) && value[index+1] == quote {
			index++
			continue
		}
		return index + 1
	}
	return len(value)
}

func skipLineComment(value string, start int) int {
	for index := start; index < len(value); index++ {
		if value[index] == '\r' || value[index] == '\n' {
			return index
		}
	}
	return len(value)
}

func skipBlockComment(value string, start int) int {
	depth := 1
	for index := start; index+1 < len(value); {
		switch value[index : index+2] {
		case "/*":
			depth++
			index += 2
		case "*/":
			depth--
			index += 2
			if depth == 0 {
				return index
			}
		default:
			index++
		}
	}
	return len(value)
}

func skipDollarQuotedLiteral(value string, start int) (int, bool) {
	endTag := start + 1
	for endTag < len(value) && (value[endTag] == '_' || isASCIILetterOrDigit(value[endTag])) {
		endTag++
	}
	if endTag >= len(value) || value[endTag] != '$' {
		return start, false
	}
	tag := value[start : endTag+1]
	contentEnd := strings.Index(value[endTag+1:], tag)
	if contentEnd < 0 {
		return len(value), true
	}
	return endTag + 1 + contentEnd + len(tag), true
}

func skipOracleQuotedLiteral(value string, start int) (int, bool) {
	if start+3 >= len(value) || (value[start] != 'q' && value[start] != 'Q') || value[start+1] != '\'' {
		return start, false
	}
	opening := value[start+2]
	closing := opening
	switch opening {
	case '[':
		closing = ']'
	case '{':
		closing = '}'
	case '(':
		closing = ')'
	case '<':
		closing = '>'
	}
	for index := start + 3; index+1 < len(value); index++ {
		if value[index] == closing && value[index+1] == '\'' {
			return index + 2, true
		}
	}
	return len(value), true
}

func isNumberStart(value string, index int) bool {
	if index >= len(value) || value[index] < '0' || value[index] > '9' {
		return false
	}
	if index == 0 {
		return true
	}
	previous := value[index-1]
	return !(previous == '_' || previous == '$' || isASCIILetterOrDigit(previous))
}

func skipNumber(value string, start int) int {
	index := start
	if index+2 <= len(value) && index+1 < len(value) && value[index] == '0' && (value[index+1] == 'x' || value[index+1] == 'X') {
		index += 2
		for index < len(value) && isASCIIHex(value[index]) {
			index++
		}
		return index
	}
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		index++
	}
	if index < len(value) && value[index] == '.' {
		index++
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
	}
	if index < len(value) && (value[index] == 'e' || value[index] == 'E') {
		index++
		if index < len(value) && (value[index] == '+' || value[index] == '-') {
			index++
		}
		for index < len(value) && value[index] >= '0' && value[index] <= '9' {
			index++
		}
	}
	return index
}

func hasPrefixAt(value string, index int, prefix string) bool {
	return index >= 0 && index+len(prefix) <= len(value) && value[index:index+len(prefix)] == prefix
}

func isASCIILetterOrDigit(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

func isASCIIHex(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'a' && value <= 'f' || value >= 'A' && value <= 'F'
}
