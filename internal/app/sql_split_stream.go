package app

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const DefaultSQLImportMaxStatementBytes int64 = 64 << 20

type SQLStreamOptions struct {
	DBType string
	// MaxStatementBytes must be positive to enforce a limit. SQL import
	// execution should use DefaultSQLImportMaxStatementBytes unless explicitly
	// configured otherwise.
	MaxStatementBytes int64
}

// SQLStatementTooLargeError identifies the statement and one-based source
// byte at which the configured in-memory statement limit was exceeded.
type SQLStatementTooLargeError struct {
	StatementIndex int
	SourceByte     int64
	MaxBytes       int64
}

func (err *SQLStatementTooLargeError) Error() string {
	return fmt.Sprintf("SQL statement %d exceeded %d bytes at source byte %d", err.StatementIndex, err.MaxBytes, err.SourceByte)
}

type sqlStatementBuilder struct {
	strings.Builder
	maxBytes       int64
	sourceOffset   int64
	statementIndex int
	limitErr       *SQLStatementTooLargeError
}

func (builder *sqlStatementBuilder) prepareWrite(sourceOffset int64, statementIndex int) {
	builder.sourceOffset = sourceOffset
	builder.statementIndex = statementIndex
}

func (builder *sqlStatementBuilder) WriteByte(value byte) error {
	if builder.limitErr != nil {
		builder.sourceOffset++
		return nil
	}
	if builder.maxBytes > 0 && int64(builder.Len()) >= builder.maxBytes {
		builder.limitErr = &SQLStatementTooLargeError{
			StatementIndex: builder.statementIndex,
			SourceByte:     builder.sourceOffset + 1,
			MaxBytes:       builder.maxBytes,
		}
		builder.sourceOffset++
		return nil
	}
	err := builder.Builder.WriteByte(value)
	builder.sourceOffset++
	return err
}

func (builder *sqlStatementBuilder) WriteString(value string) (int, error) {
	if builder.limitErr != nil {
		builder.sourceOffset += int64(len(value))
		return 0, nil
	}
	allowed := len(value)
	if builder.maxBytes > 0 {
		remaining := builder.maxBytes - int64(builder.Len())
		if remaining < int64(allowed) {
			if remaining < 0 {
				remaining = 0
			}
			allowed = int(remaining)
			builder.limitErr = &SQLStatementTooLargeError{
				StatementIndex: builder.statementIndex,
				SourceByte:     builder.sourceOffset + int64(allowed) + 1,
				MaxBytes:       builder.maxBytes,
			}
		}
	}
	written, err := builder.Builder.WriteString(value[:allowed])
	builder.sourceOffset += int64(len(value))
	return written, err
}

func (builder *sqlStatementBuilder) Reset() {
	builder.Builder.Reset()
	builder.limitErr = nil
}

// sqlStreamSplitter 是一个流式 SQL 语句拆分器，适用于处理大文件。
// 调用方通过 Feed(chunk) 逐块喂入数据，通过 Flush() 获取最后一条残余语句。
// 内部维护与 splitSQLStatements 完全一致的状态机逻辑。
type sqlStreamSplitter struct {
	dbType                 string
	delimiter              string
	cur                    sqlStatementBuilder
	pending                string
	inputBytes             int64
	statementIndex         int
	inSingle               bool
	inDouble               bool
	inBacktick             bool
	escaped                bool
	inLineComment          bool
	inBlockComment         bool
	dollarTag              string
	plsqlDepth             int
	declareSkips           int
	plsqlCaseDepth         int
	skipCaseEnd            bool
	closedPLSQL            bool
	sqlServerBatch         []string
	preserveSQLServerBatch bool
	sqlServerGoSeen        bool
}

func (s *sqlStreamSplitter) takeStatement() string {
	stmt := strings.TrimSpace(s.cur.String())
	s.cur.Reset()
	if !hasExecutableSQLStatementContent(s.dbType, stmt) {
		return ""
	}
	return stmt
}

func (s *sqlStreamSplitter) activeDelimiter() string {
	if s.delimiter == "" {
		return ";"
	}
	return s.delimiter
}

func (s *sqlStreamSplitter) appendCompletedStatement(statements *[]string, stmt string) {
	if stmt == "" {
		return
	}
	*statements = append(*statements, stmt)
	s.statementIndex++
	if normalizeExplainLexicalDBType(s.dbType) == "sqlserver" {
		s.sqlServerBatch = append(s.sqlServerBatch, stmt)
	}
}

func (s *sqlStreamSplitter) finishSQLServerBatch(statements *[]string, repeat int) {
	if repeat < 1 {
		repeat = 1
	}
	batch := append([]string(nil), s.sqlServerBatch...)
	for iteration := 1; iteration < repeat; iteration++ {
		*statements = append(*statements, batch...)
		s.statementIndex += len(batch)
	}
	s.sqlServerBatch = nil
}

// Feed 将一个 chunk 喂入拆分器，返回在此 chunk 中完成的 SQL 语句列表。
func (s *sqlStreamSplitter) Feed(chunk []byte) []string {
	var statements []string
	textSourceOffset := s.inputBytes
	if s.pending != "" {
		textSourceOffset -= int64(len(s.pending))
	}
	s.inputBytes += int64(len(chunk))
	text := s.pending + string(chunk)
	s.pending = ""

	for i := 0; i < len(text); i++ {
		if s.cur.limitErr != nil {
			break
		}
		s.cur.prepareWrite(textSourceOffset+int64(i), s.statementIndex)
		ch := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}

		// 行注释
		if s.inLineComment {
			if ch == '\n' {
				s.inLineComment = false
			}
			s.cur.WriteByte(ch)
			continue
		}

		// 块注释
		if s.inBlockComment {
			if ch == '*' && i+1 >= len(text) {
				s.pending = text[i:]
				break
			}
			s.cur.WriteByte(ch)
			if ch == '*' && next == '/' {
				s.cur.WriteByte('/')
				i++
				s.inBlockComment = false
			}
			continue
		}

		// Dollar-quoting
		if s.dollarTag != "" {
			if strings.HasPrefix(text[i:], s.dollarTag) {
				s.cur.WriteString(s.dollarTag)
				i += len(s.dollarTag) - 1
				s.dollarTag = ""
			} else if ch == '$' && len(text[i:]) < len(s.dollarTag) && strings.HasPrefix(s.dollarTag, text[i:]) {
				s.pending = text[i:]
				break
			} else {
				s.cur.WriteByte(ch)
			}
			continue
		}

		// 转义字符
		if s.escaped {
			s.escaped = false
			s.cur.WriteByte(ch)
			continue
		}
		if (s.inSingle || s.inDouble) && ch == '\\' {
			s.escaped = true
			s.cur.WriteByte(ch)
			continue
		}

		// 字符串开闭
		if !s.inDouble && !s.inBacktick && ch == '\'' {
			if s.inSingle && i+1 >= len(text) {
				s.pending = text[i:]
				break
			}
			if s.inSingle && next == '\'' {
				// SQL 标准转义：两个连续单引号
				s.cur.WriteByte(ch)
				s.cur.WriteByte(next)
				i++
				continue
			}
			s.inSingle = !s.inSingle
			s.cur.WriteByte(ch)
			continue
		}
		if !s.inSingle && !s.inBacktick && ch == '"' {
			s.inDouble = !s.inDouble
			s.cur.WriteByte(ch)
			continue
		}
		if !s.inSingle && !s.inDouble && ch == '`' {
			s.inBacktick = !s.inBacktick
			s.cur.WriteByte(ch)
			continue
		}

		// 在引号/反引号内部不做任何判断
		if s.inSingle || s.inDouble || s.inBacktick {
			s.cur.WriteByte(ch)
			continue
		}

		if isSQLStreamMySQLClientDialect(s.dbType) && s.canConsumeClientDirective() {
			delimiter, lineEnd, matched, incomplete := scanSQLStreamDelimiterDirective(text, i, false)
			if incomplete {
				s.pending = text[i:]
				break
			}
			if matched {
				s.cur.Reset()
				s.delimiter = delimiter
				i = lineEnd - 1
				continue
			}
		}

		if normalizeExplainLexicalDBType(s.dbType) == "sqlserver" && sqlStreamCurrentLineWhitespaceOnly(&s.cur) {
			repeat, lineEnd, matched, incomplete := scanSQLStreamGoDirective(text, i, false)
			if incomplete {
				s.pending = text[i:]
				break
			}
			if matched {
				s.sqlServerGoSeen = true
				s.appendCompletedStatement(&statements, s.takeStatement())
				s.finishSQLServerBatch(&statements, repeat)
				s.closedPLSQL = false
				i = lineEnd - 1
				continue
			}
		}

		if delimiter := s.activeDelimiter(); delimiter != ";" {
			remaining := text[i:]
			if strings.HasPrefix(remaining, delimiter) {
				stmt := s.takeStatement()
				s.appendCompletedStatement(&statements, stmt)
				s.closedPLSQL = false
				i += len(delimiter) - 1
				continue
			}
			if len(remaining) < len(delimiter) && strings.HasPrefix(delimiter, remaining) {
				s.pending = remaining
				break
			}
		}

		if isSQLIdentifierStart(ch) {
			tokenStart := i
			tokenEnd := i + 1
			for tokenEnd < len(text) && isSQLIdentifierPart(text[tokenEnd]) && !s.delimiterStartsAt(text, tokenEnd) {
				tokenEnd++
			}
			token := strings.ToLower(text[tokenStart:tokenEnd])
			if shouldDeferPLSQLKeywordPrefixInStream(text, tokenStart, tokenEnd, token) {
				s.pending = text[tokenStart:]
				break
			}
			if shouldDeferPLSQLKeywordInStream(text, tokenStart, tokenEnd, token) {
				s.pending = text[tokenStart:]
				break
			}
			if token == "case" && s.plsqlDepth > 0 {
				if s.skipCaseEnd {
					s.skipCaseEnd = false
				} else {
					s.plsqlCaseDepth++
					s.closedPLSQL = false
				}
			} else if token != "case" {
				s.skipCaseEnd = false
			}
			if token == "begin" && s.declareSkips > 0 {
				s.declareSkips--
				s.closedPLSQL = false
			} else if token == "begin" && shouldEnterPLSQLBlockForDialect(s.dbType, text, tokenEnd) {
				s.plsqlDepth++
				s.closedPLSQL = false
			} else if token == "declare" && shouldEnterPLSQLDeclareBlock(text, tokenEnd) {
				s.plsqlDepth++
				s.declareSkips++
				s.closedPLSQL = false
			} else if s.plsqlDepth == 0 && shouldEnterPLSQLCreateRoutineBlock(text, s.cur.String(), token, tokenEnd) {
				s.plsqlDepth++
				if !isCreatePackageHeaderPrefix(s.cur.String()) {
					s.declareSkips++
				}
				s.closedPLSQL = false
			} else if token == "end" && s.plsqlDepth > 0 && s.plsqlCaseDepth > 0 {
				s.plsqlCaseDepth--
				if nextSQLSignificantToken(text, tokenEnd) == "case" {
					s.skipCaseEnd = true
				}
				s.closedPLSQL = false
			} else if token == "end" && s.plsqlDepth > 0 && !isPLSQLControlEnd(text, tokenEnd) {
				s.plsqlDepth--
				if s.declareSkips > s.plsqlDepth {
					s.declareSkips = s.plsqlDepth
				}
				if s.plsqlCaseDepth > s.plsqlDepth {
					s.plsqlCaseDepth = s.plsqlDepth
				}
				s.closedPLSQL = s.plsqlDepth == 0
			}
			s.cur.WriteString(text[tokenStart:tokenEnd])
			i = tokenEnd - 1
			continue
		}

		// 行注释开始
		if ch == '-' && i+1 >= len(text) {
			s.pending = text[i:]
			break
		}
		if ch == '-' && next == '-' && isSQLFileMySQLDashCommentDecisionIncomplete(s.dbType, text, i) {
			s.pending = text[i:]
			break
		}
		if ch == '-' && next == '-' && isSQLDashLineCommentStart(s.dbType, text, i) {
			s.inLineComment = true
			s.cur.WriteByte(ch)
			continue
		}
		if ch == '#' && supportsSQLHashLineComment(s.dbType) {
			s.inLineComment = true
			s.cur.WriteByte(ch)
			continue
		}

		if ch == '/' && (s.closedPLSQL || strings.TrimSpace(s.cur.String()) == "") && sqlStreamCurrentLineWhitespaceOnly(&s.cur) {
			lineEnd, standalone, complete := scanSQLStandaloneSlashLineSuffix(text, i)
			if standalone {
				if !complete {
					s.pending = text[i:]
					break
				}
				stmt := s.takeStatement()
				s.appendCompletedStatement(&statements, stmt)
				s.closedPLSQL = false
				i = lineEnd
				continue
			}
		}

		// 块注释开始
		if ch == '/' && i+1 >= len(text) {
			s.pending = text[i:]
			break
		}
		if ch == '/' && next == '*' {
			s.inBlockComment = true
			s.cur.WriteString("/*")
			i++
			continue
		}

		// Dollar-quoting 开始
		if ch == '$' && supportsSQLDollarQuote(s.dbType) {
			if tag := parseSQLDollarTagAt(text, i); tag != "" {
				s.dollarTag = tag
				s.cur.WriteString(tag)
				i += len(tag) - 1
				continue
			}
			if isIncompleteSQLDollarTagAt(text, i) {
				s.pending = text[i:]
				break
			}
		}

		// 分号分隔
		if ch == ';' {
			if s.preserveSQLServerBatch {
				s.cur.WriteByte(ch)
				continue
			}
			if s.plsqlDepth > 0 {
				s.cur.WriteByte(ch)
				continue
			}
			if s.closedPLSQL {
				s.cur.WriteByte(ch)
				stmt := s.takeStatement()
				s.appendCompletedStatement(&statements, stmt)
				s.closedPLSQL = false
				continue
			}
			stmt := s.takeStatement()
			s.appendCompletedStatement(&statements, stmt)
			continue
		}
		// 全角分号
		if ch == 0xEF && i+2 >= len(text) {
			s.pending = text[i:]
			break
		}
		if ch == 0xEF && i+2 < len(text) && text[i+1] == 0xBC && text[i+2] == 0x9B {
			if s.preserveSQLServerBatch {
				s.cur.WriteString("；")
				i += 2
				continue
			}
			if s.plsqlDepth > 0 {
				s.cur.WriteString("；")
				i += 2
				continue
			}
			if s.closedPLSQL {
				s.cur.WriteString("；")
				stmt := s.takeStatement()
				s.appendCompletedStatement(&statements, stmt)
				s.closedPLSQL = false
				i += 2
				continue
			}
			stmt := s.takeStatement()
			s.appendCompletedStatement(&statements, stmt)
			i += 2
			continue
		}

		s.cur.WriteByte(ch)
	}

	return statements
}

func (s *sqlStreamSplitter) delimiterStartsAt(text string, start int) bool {
	delimiter := s.activeDelimiter()
	if delimiter == ";" || start < 0 || start >= len(text) {
		return false
	}
	remaining := text[start:]
	return strings.HasPrefix(remaining, delimiter) || (len(remaining) < len(delimiter) && strings.HasPrefix(delimiter, remaining))
}

func isSQLFileMySQLDashCommentDecisionIncomplete(dbType, text string, index int) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		return index >= 0 && index+2 >= len(text)
	default:
		return false
	}
}

func (s *sqlStreamSplitter) flushStatements() []string {
	var statements []string
	if s.pending != "" {
		if normalizeExplainLexicalDBType(s.dbType) == "sqlserver" && sqlStreamCurrentLineWhitespaceOnly(&s.cur) {
			if repeat, _, matched, _ := scanSQLStreamGoDirective(s.pending, 0, true); matched {
				s.pending = ""
				s.sqlServerGoSeen = true
				s.appendCompletedStatement(&statements, s.takeStatement())
				s.finishSQLServerBatch(&statements, repeat)
				s.closedPLSQL = false
				return statements
			}
		}
		if isSQLStreamMySQLClientDialect(s.dbType) && s.canConsumeClientDirective() {
			if delimiter, _, matched, _ := scanSQLStreamDelimiterDirective(s.pending, 0, true); matched {
				s.pending = ""
				s.cur.Reset()
				s.delimiter = delimiter
				return statements
			}
		}
		if (s.closedPLSQL || strings.TrimSpace(s.cur.String()) == "") && sqlStreamCurrentLineWhitespaceOnly(&s.cur) {
			if _, standalone, _ := scanSQLStandaloneSlashLineSuffix(s.pending, 0); standalone {
				s.pending = ""
				stmt := s.takeStatement()
				s.closedPLSQL = false
				s.appendCompletedStatement(&statements, stmt)
				return statements
			}
		}
		s.cur.prepareWrite(s.inputBytes-int64(len(s.pending)), s.statementIndex)
		s.cur.WriteString(s.pending)
		s.pending = ""
		if s.cur.limitErr != nil {
			return statements
		}
	}
	if s.preserveSQLServerBatch && normalizeExplainLexicalDBType(s.dbType) == "sqlserver" && !s.sqlServerGoSeen {
		rawBatch := strings.TrimSpace(s.cur.String())
		s.cur.Reset()
		for _, stmt := range splitSQLStatementsForDialect(s.dbType, rawBatch) {
			s.appendCompletedStatement(&statements, stmt)
		}
		return statements
	}
	stmt := s.takeStatement()
	if stmt != "/" {
		s.appendCompletedStatement(&statements, stmt)
	}
	return statements
}

// Flush 返回缓冲区中剩余的不完整语句（文件结束时调用）。
// 多语句结果仅用于兼容直接调用；流式入口使用 flushStatements 保留 GO n 的逐条回调语义。
func (s *sqlStreamSplitter) Flush() string {
	return strings.Join(s.flushStatements(), ";\n")
}

func isSQLStreamMySQLClientDialect(dbType string) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "mysql", "mariadb":
		return true
	default:
		return false
	}
}

func (s *sqlStreamSplitter) canConsumeClientDirective() bool {
	return sqlStreamCurrentLineWhitespaceOnly(&s.cur) && !hasExecutableSQLStatementContent(s.dbType, s.cur.String())
}

func scanSQLStreamDelimiterDirective(text string, start int, eof bool) (delimiter string, lineEnd int, matched bool, incomplete bool) {
	const keyword = "delimiter"
	if start < 0 || start >= len(text) {
		return "", start, false, false
	}
	remaining := text[start:]
	prefixLength := len(remaining)
	if prefixLength > len(keyword) {
		prefixLength = len(keyword)
	}
	if !strings.EqualFold(remaining[:prefixLength], keyword[:prefixLength]) {
		return "", start, false, false
	}
	if len(remaining) < len(keyword) {
		return "", start, false, !eof
	}
	if len(remaining) == len(keyword) {
		return "", start, false, !eof
	}
	if !isSQLHorizontalWhitespace(remaining[len(keyword)]) {
		return "", start, false, false
	}

	newline := strings.IndexByte(remaining, '\n')
	if newline < 0 && !eof {
		return "", start, false, true
	}
	line := remaining
	lineEnd = len(text)
	if newline >= 0 {
		line = remaining[:newline]
		lineEnd = start + newline + 1
	}
	value := strings.TrimSpace(line[len(keyword):])
	if value == "" || strings.IndexFunc(value, func(r rune) bool { return r == ' ' || r == '\t' || r == '\r' || r == '\n' }) >= 0 {
		return "", start, false, false
	}
	return value, lineEnd, true, false
}

func scanSQLStreamGoDirective(text string, start int, eof bool) (repeat int, lineEnd int, matched bool, incomplete bool) {
	const keyword = "go"
	if start < 0 || start >= len(text) {
		return 0, start, false, false
	}
	remaining := text[start:]
	prefixLength := len(remaining)
	if prefixLength > len(keyword) {
		prefixLength = len(keyword)
	}
	if !strings.EqualFold(remaining[:prefixLength], keyword[:prefixLength]) {
		return 0, start, false, false
	}
	if len(remaining) < len(keyword) {
		return 0, start, false, !eof
	}
	if len(remaining) > len(keyword) && !isSQLHorizontalWhitespace(remaining[len(keyword)]) && remaining[len(keyword)] != '\n' {
		return 0, start, false, false
	}

	newline := strings.IndexByte(remaining, '\n')
	if newline < 0 && !eof {
		return 0, start, false, true
	}
	line := remaining
	lineEnd = len(text)
	if newline >= 0 {
		line = remaining[:newline]
		lineEnd = start + newline + 1
	}
	remainder := strings.TrimSpace(line[len(keyword):])
	if comment := strings.Index(remainder, "--"); comment >= 0 {
		remainder = strings.TrimSpace(remainder[:comment])
	}
	if remainder == "" {
		return 1, lineEnd, true, false
	}
	parsed, err := strconv.Atoi(remainder)
	if err != nil || parsed <= 0 {
		return 0, start, false, false
	}
	return parsed, lineEnd, true, false
}

func sqlStreamCurrentLineWhitespaceOnly(builder interface{ String() string }) bool {
	text := builder.String()
	for i := len(text) - 1; i >= 0; i-- {
		if text[i] == '\n' {
			return true
		}
		if !isSQLHorizontalWhitespace(text[i]) {
			return false
		}
	}
	return true
}

func isIncompleteSQLDollarTag(s string) bool {
	if len(s) == 0 || s[0] != '$' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if c == '$' {
			return false
		}
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

func isIncompleteSQLDollarTagAt(text string, start int) bool {
	if start < 0 || start >= len(text) || text[start] != '$' {
		return false
	}
	if start > 0 && isSQLIdentifierPart(text[start-1]) {
		return false
	}
	return isIncompleteSQLDollarTag(text[start:])
}

func shouldDeferPLSQLKeywordInStream(text string, tokenStart int, tokenEnd int, token string) bool {
	switch token {
	case "begin", "declare", "end", "create", "or", "replace", "editionable", "noneditionable", "procedure", "function", "package", "body", "is", "as":
	default:
		return false
	}
	if tokenEnd >= len(text) {
		return true
	}
	next := skipSQLTrivia(text, tokenEnd)
	if next >= len(text) {
		return true
	}
	if isSQLIdentifierStart(text[next]) {
		nextEnd := next + 1
		for nextEnd < len(text) && isSQLIdentifierPart(text[nextEnd]) {
			nextEnd++
		}
		if nextEnd >= len(text) {
			return true
		}
		if token == "begin" {
			nextToken := strings.ToLower(text[next:nextEnd])
			if nextToken == "not" || nextToken == "distributed" {
				following := skipSQLTrivia(text, nextEnd)
				if following >= len(text) {
					return true
				}
				if isSQLIdentifierStart(text[following]) {
					followingEnd := following + 1
					for followingEnd < len(text) && isSQLIdentifierPart(text[followingEnd]) {
						followingEnd++
					}
					return followingEnd >= len(text)
				}
			}
		}
	}
	return false
}

func shouldDeferPLSQLKeywordPrefixInStream(text string, tokenStart int, tokenEnd int, token string) bool {
	if tokenEnd < len(text) {
		return false
	}
	for _, keyword := range []string{"begin", "declare", "end", "create", "or", "replace", "editionable", "noneditionable", "procedure", "function", "package", "body", "is", "as"} {
		if strings.HasPrefix(keyword, token) && token != keyword {
			if tokenStart > 0 && isSQLIdentifierPart(text[tokenStart-1]) {
				return false
			}
			return true
		}
	}
	return false
}

// streamSQLFile 从 reader 中流式读取 SQL 并逐条回调。
// onStatement 返回 error 时停止读取并返回该 error。
// 返回总处理语句数和可能的错误。
func streamSQLFile(reader io.Reader, onStatement func(index int, stmt string) error) (int, error) {
	return streamSQLFileForDialect(reader, "", onStatement)
}

func streamSQLFileForDialect(reader io.Reader, dbType string, onStatement func(index int, stmt string) error) (int, error) {
	return streamSQLFileWithOptions(reader, SQLStreamOptions{DBType: dbType}, onStatement)
}

func streamSQLFileWithOptions(reader io.Reader, options SQLStreamOptions, onStatement func(index int, stmt string) error) (int, error) {
	splitter := &sqlStreamSplitter{dbType: normalizeSQLClassifierDBType(options.DBType)}
	splitter.preserveSQLServerBatch = normalizeExplainLexicalDBType(splitter.dbType) == "sqlserver"
	splitter.cur.maxBytes = options.MaxStatementBytes
	bufferedReader := bufio.NewReaderSize(reader, 1024*1024)
	buffer := make([]byte, 1024*1024)

	count := 0
	for {
		n, err := bufferedReader.Read(buffer)
		if n > 0 {
			stmts := splitter.Feed(buffer[:n])
			for _, stmt := range stmts {
				if err := onStatement(count, stmt); err != nil {
					return count, err
				}
				count++
			}
			if splitter.cur.limitErr != nil {
				return count, splitter.cur.limitErr
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return count, err
		}
		if n == 0 {
			continue
		}
	}

	// 处理文件末尾不以分号结尾的最后一条语句或 GO n 重复批次。
	for _, last := range splitter.flushStatements() {
		if err := onStatement(count, last); err != nil {
			return count, err
		}
		count++
	}
	if splitter.cur.limitErr != nil {
		return count, splitter.cur.limitErr
	}

	return count, nil
}

// StreamSQLFileWithOptions streams statements without loading the full source.
func StreamSQLFileWithOptions(reader io.Reader, options SQLStreamOptions, onStatement func(index int, stmt string) error) (int, error) {
	return streamSQLFileWithOptions(reader, options, onStatement)
}
