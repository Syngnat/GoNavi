package app

import (
	"io"
	"os"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

const defaultAppLogTailLineLimit = 80

const maxAppLogTailLineLimit = 200

const appLogTailReadWindowBytes int64 = 256 * 1024

type appLogTailSnapshot struct {
	LogPath               string         `json:"logPath"`
	Keyword               string         `json:"keyword,omitempty"`
	RequestedLineLimit    int            `json:"requestedLineLimit"`
	ReturnedLineCount     int            `json:"returnedLineCount"`
	FileWindowTruncated   bool           `json:"fileWindowTruncated"`
	MatchedLinesTruncated bool           `json:"matchedLinesTruncated"`
	LevelBreakdown        map[string]int `json:"levelBreakdown"`
	Lines                 []string       `json:"lines"`
}

func (a *App) ReadAppLogTail(lineLimit int, keyword string) connection.QueryResult {
	return readAppLogTailByPathWithText(logger.Path(), lineLimit, keyword, a.appText)
}

func normalizeAppLogTailLineLimit(input int) int {
	if input <= 0 {
		return defaultAppLogTailLineLimit
	}
	if input > maxAppLogTailLineLimit {
		return maxAppLogTailLineLimit
	}
	return input
}

func redactAppLogSQLFields(line string) string {
	searchFrom := 0
	for searchFrom < len(line) {
		fieldStart, fieldLength, kind := findAppLogSensitiveField(line, searchFrom)
		if fieldStart < 0 {
			break
		}
		valueStart := fieldStart + fieldLength
		if valueStart >= len(line) {
			break
		}
		valueEnd := valueStart
		var value string
		if line[valueStart] == '"' {
			valueEnd++
			escaped := false
			for valueEnd < len(line) {
				if escaped {
					escaped = false
					valueEnd++
					continue
				}
				if line[valueEnd] == '\\' {
					escaped = true
					valueEnd++
					continue
				}
				if line[valueEnd] == '"' {
					valueEnd++
					break
				}
				valueEnd++
			}
			if valueEnd > len(line) || valueEnd <= valueStart+1 {
				break
			}
			decoded, err := strconv.Unquote(line[valueStart:valueEnd])
			if err != nil {
				break
			}
			redacted := redactAppLogFieldValue(kind, decoded)
			if kind == appLogFieldRedisCommand {
				// Keep the redacted Redis command unquoted so RedactError's
				// quoted-segment pass cannot wipe AUTH/HELLO structure.
				value = redacted
			} else {
				value = strconv.Quote(redacted)
			}
		} else {
			valueEnd = unquotedAppLogFieldEnd(line, valueStart, kind)
			value = redactAppLogFieldValue(kind, line[valueStart:valueEnd])
		}
		line = line[:valueStart] + value + line[valueEnd:]
		searchFrom = valueStart + len(value)
	}
	return sqlaudit.RedactError(line)
}

type appLogSensitiveFieldKind int

const (
	appLogFieldNone appLogSensitiveFieldKind = iota
	appLogFieldSQL
	appLogFieldRedisCommand
)

func redactAppLogFieldValue(kind appLogSensitiveFieldKind, value string) string {
	if kind == appLogFieldRedisCommand {
		return redactRedisCommandForLog(value)
	}
	return sqlaudit.RedactSQL(value)
}

func unquotedAppLogFieldEnd(line string, valueStart int, kind appLogSensitiveFieldKind) int {
	if kind == appLogFieldRedisCommand {
		if terminator := strings.Index(line[valueStart:], "；错误链："); terminator >= 0 {
			return valueStart + terminator
		}
	}
	return len(line)
}

func findAppLogSensitiveField(line string, start int) (int, int, appLogSensitiveFieldKind) {
	lower := strings.ToLower(line)
	bestIndex := -1
	bestLength := 0
	bestKind := appLogFieldNone
	for _, candidate := range []struct {
		marker string
		kind   appLogSensitiveFieldKind
	}{
		{"sql片段=", appLogFieldSQL},
		{"sqltext=", appLogFieldSQL},
		{"sql=", appLogFieldSQL},
		{"command=", appLogFieldRedisCommand},
	} {
		if index := strings.Index(lower[start:], candidate.marker); index >= 0 {
			index += start
			if bestIndex < 0 || index < bestIndex {
				bestIndex = index
				bestLength = len(candidate.marker)
				bestKind = candidate.kind
			}
		}
	}
	return bestIndex, bestLength, bestKind
}

func readAppLogTailWindow(filePath string, maxBytes int64) ([]byte, bool, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	size := fi.Size()
	if size <= 0 {
		return []byte{}, false, nil
	}

	offset := int64(0)
	truncated := false
	if maxBytes > 0 && size > maxBytes {
		offset = size - maxBytes
		truncated = true
	}

	buf := make([]byte, size-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return nil, false, err
	}
	if !truncated {
		return buf, false, nil
	}

	text := string(buf)
	if idx := strings.IndexByte(text, '\n'); idx >= 0 && idx+1 < len(text) {
		return []byte(text[idx+1:]), true, nil
	}
	return []byte{}, true, nil
}

func buildAppLogLevelBreakdown(lines []string) map[string]int {
	breakdown := map[string]int{
		"INFO":  0,
		"WARN":  0,
		"ERROR": 0,
		"OTHER": 0,
	}
	for _, line := range lines {
		switch {
		case strings.Contains(line, "[INFO]"):
			breakdown["INFO"]++
		case strings.Contains(line, "[WARN]"):
			breakdown["WARN"]++
		case strings.Contains(line, "[ERROR]"):
			breakdown["ERROR"]++
		default:
			breakdown["OTHER"]++
		}
	}
	return breakdown
}

func readAppLogTailByPath(filePath string, lineLimit int, keyword string) connection.QueryResult {
	return readAppLogTailByPathWithText(filePath, lineLimit, keyword, nil)
}

func readAppLogTailByPathWithText(filePath string, lineLimit int, keyword string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.app_log_file_not_found", nil)}
	}

	if _, err := os.Stat(target); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	windowBytes, fileWindowTruncated, err := readAppLogTailWindow(target, appLogTailReadWindowBytes)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalizedKeyword := strings.ToLower(strings.TrimSpace(keyword))
	normalizedLineLimit := normalizeAppLogTailLineLimit(lineLimit)
	rawLines := strings.Split(strings.ReplaceAll(string(windowBytes), "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, rawLine := range rawLines {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		lines = append(lines, redactAppLogSQLFields(line))
	}

	filteredLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if normalizedKeyword != "" && !strings.Contains(strings.ToLower(line), normalizedKeyword) {
			continue
		}
		filteredLines = append(filteredLines, line)
	}

	matchedLinesTruncated := len(filteredLines) > normalizedLineLimit
	if matchedLinesTruncated {
		filteredLines = filteredLines[len(filteredLines)-normalizedLineLimit:]
	}

	snapshot := appLogTailSnapshot{
		LogPath:               target,
		Keyword:               strings.TrimSpace(keyword),
		RequestedLineLimit:    normalizedLineLimit,
		ReturnedLineCount:     len(filteredLines),
		FileWindowTruncated:   fileWindowTruncated,
		MatchedLinesTruncated: matchedLinesTruncated,
		LevelBreakdown:        buildAppLogLevelBreakdown(filteredLines),
		Lines:                 filteredLines,
	}
	return connection.QueryResult{Success: true, Data: snapshot}
}
