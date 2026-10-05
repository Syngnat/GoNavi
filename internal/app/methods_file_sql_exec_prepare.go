package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// ExecuteSQLFile 在后端流式读取并执行大 SQL 文件，通过事件推送进度。
// 前端通过 EventsOn("sqlfile:progress", ...) 监听进度。
const sqlFileExecutionPreambleBytes = 64 * 1024

const sqlFileFullPreflightMaxRawBytes int64 = 64 << 20

type preparedSQLFileExecutionSource struct {
	source   *SQLImportSource
	reader   io.Reader
	preamble []byte
	rawSize  int64
}

type sqlImportContextReader struct {
	ctx        context.Context
	reader     io.Reader
	beforeRead func(context.Context)
}

type sqlFileRawProgressObserver struct {
	bytesRead    int64
	lastReported int64
	lastReportAt time.Time
	report       func(int64) error
}

func (observer *sqlFileRawProgressObserver) Write(buffer []byte) (int, error) {
	observer.bytesRead += int64(len(buffer))
	shouldReport := observer.lastReportAt.IsZero() ||
		observer.bytesRead-observer.lastReported >= 1<<20 ||
		time.Since(observer.lastReportAt) >= 250*time.Millisecond
	if shouldReport && observer.report != nil {
		observer.lastReported = observer.bytesRead
		observer.lastReportAt = time.Now()
		if err := observer.report(observer.bytesRead); err != nil {
			return len(buffer), err
		}
	}
	return len(buffer), nil
}

func (reader *sqlImportContextReader) Read(buffer []byte) (int, error) {
	if reader == nil || reader.reader == nil {
		return 0, io.EOF
	}
	if reader.ctx != nil {
		if err := reader.ctx.Err(); err != nil {
			return 0, err
		}
	}
	if reader.beforeRead != nil {
		reader.beforeRead(reader.ctx)
		if reader.ctx != nil {
			if err := reader.ctx.Err(); err != nil {
				return 0, err
			}
		}
	}
	read, err := reader.reader.Read(buffer)
	if reader.ctx != nil {
		if contextErr := reader.ctx.Err(); contextErr != nil {
			return read, contextErr
		}
	}
	return read, err
}

var sqlFilePreflightReadHook func(context.Context)

func (prepared *preparedSQLFileExecutionSource) Close() error {
	if prepared == nil || prepared.source == nil {
		return nil
	}
	return prepared.source.Close()
}

func readSQLFileExecutionPreambleStream(reader io.Reader) ([]byte, io.Reader, error) {
	buffer := make([]byte, sqlFileExecutionPreambleBytes)
	read, err := io.ReadFull(reader, buffer)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, nil, err
	}
	preamble := buffer[:read]
	return preamble, io.MultiReader(bytes.NewReader(preamble), reader), nil
}

func shouldFullyPreflightSQLFile(rawSize int64) bool {
	return rawSize >= 0 && rawSize <= sqlFileFullPreflightMaxRawBytes
}

func prepareSQLFileExecutionSource(filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer) (*preparedSQLFileExecutionSource, error) {
	return prepareSQLFileExecutionSourceWithContext(context.Background(), filePath, dbType, maxStatementBytes, rawObserver, nil)
}

func prepareSQLFileExecutionSourceWithContext(ctx context.Context, filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer, preflightRawObserver io.Writer) (*preparedSQLFileExecutionSource, error) {
	return prepareSQLFileExecutionSourceWithPolicyContext(ctx, filePath, dbType, maxStatementBytes, rawObserver, preflightRawObserver, sqlFileExecutionPolicy{})
}

func preflightSQLFileExecutionSourceWithPolicy(reader io.Reader, dbType string, maxStatementBytes int64, statementGuard func(index int, stmt string) error) (SQLImportPreflightResult, error) {
	if statementGuard == nil {
		return PreflightSQLImportWithOptions(reader, SQLStreamOptions{
			DBType:            dbType,
			MaxStatementBytes: maxStatementBytes,
		})
	}

	result := SQLImportPreflightResult{Safe: true}
	normalizedType := normalizeExplainLexicalDBType(dbType)
	_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            normalizedType,
		MaxStatementBytes: maxStatementBytes,
	}, func(index int, stmt string) error {
		statementResult := PreflightSQLStatement(stmt, normalizedType, index)
		if !statementResult.Safe {
			result = statementResult
			return errSQLImportPreflightRejected
		}
		if err := statementGuard(index, strings.TrimSpace(stmt)); err != nil {
			return &sqlFilePolicyRejectedError{err: err}
		}
		return nil
	})
	if errors.Is(err, errSQLImportPreflightRejected) {
		return result, nil
	}
	if err != nil {
		return SQLImportPreflightResult{}, err
	}
	return result, nil
}

func prepareSQLFileExecutionSourceWithPolicyContext(ctx context.Context, filePath, dbType string, maxStatementBytes int64, rawObserver io.Writer, preflightRawObserver io.Writer, policy sqlFileExecutionPolicy) (*preparedSQLFileExecutionSource, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("SQL import source is a directory")
	}
	fullPreflight := policy.ForceFullPreflight || shouldFullyPreflightSQLFile(info.Size())
	var preamble []byte
	if fullPreflight {
		preflightSource, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{RawObserver: preflightRawObserver})
		if err != nil {
			return nil, err
		}
		preflightPreamble, preflightReader, readErr := readSQLFileExecutionPreambleStream(&sqlImportContextReader{
			ctx:        ctx,
			reader:     preflightSource,
			beforeRead: sqlFilePreflightReadHook,
		})
		if readErr == nil {
			var preflightResult SQLImportPreflightResult
			preflightResult, readErr = preflightSQLFileExecutionSourceWithPolicy(preflightReader, dbType, maxStatementBytes, policy.StatementGuard)
			if readErr == nil && !preflightResult.Safe && preflightResult.Reason != nil {
				readErr = &sqlFilePreflightRejectedError{reason: *preflightResult.Reason}
			}
		}
		closeErr := preflightSource.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		preamble = preflightPreamble
	}

	executionSource, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{RawObserver: rawObserver})
	if err != nil {
		return nil, err
	}
	executionReader := io.Reader(&sqlImportContextReader{ctx: ctx, reader: executionSource})
	if !fullPreflight {
		preamble, executionReader, err = readSQLFileExecutionPreambleStream(executionReader)
		if err != nil {
			_ = executionSource.Close()
			return nil, err
		}
	}
	return &preparedSQLFileExecutionSource{
		source:   executionSource,
		reader:   executionReader,
		preamble: preamble,
		rawSize:  info.Size(),
	}, nil
}

func readSQLFileExecutionPreamble(reader io.ReadSeeker) ([]byte, error) {
	buffer := make([]byte, sqlFileExecutionPreambleBytes)
	read, err := io.ReadFull(reader, buffer)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return buffer[:read], nil
}

type goNaviMySQLDatabaseBackupPreamble struct {
	databaseName           string
	includesCreateDatabase bool
}

func parseGoNaviMySQLDatabaseBackupPreamble(preamble []byte) (goNaviMySQLDatabaseBackupPreamble, bool) {
	text := strings.TrimPrefix(string(preamble), "\ufeff")
	if !strings.HasPrefix(strings.TrimSpace(text), "-- GoNavi SQL Export") {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}

	databaseName := ""
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "-- Database:") {
			databaseName = strings.TrimSpace(strings.TrimPrefix(trimmed, "-- Database:"))
			break
		}
	}
	if databaseName == "" {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}

	quotedDatabase := quoteIdentByType("mysql", databaseName)
	if !strings.Contains(text, "USE "+quotedDatabase+";") {
		return goNaviMySQLDatabaseBackupPreamble{}, false
	}
	return goNaviMySQLDatabaseBackupPreamble{
		databaseName:           databaseName,
		includesCreateDatabase: strings.Contains(text, "CREATE DATABASE IF NOT EXISTS "+quotedDatabase+";"),
	}, true
}

func buildGoNaviMySQLDatabaseBackupBootstrapSQL(backup goNaviMySQLDatabaseBackupPreamble) string {
	if backup.includesCreateDatabase || strings.TrimSpace(backup.databaseName) == "" {
		return ""
	}
	return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", quoteIdentByType("mysql", backup.databaseName))
}

func resolveSQLFileExecutionProgressPercent(status string, bytesRead, totalSize int64) float64 {
	if totalSize <= 0 {
		return 0
	}
	percent := float64(bytesRead) / float64(totalSize) * 100
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		percent = 100
	}
	// The SQL splitter reads ahead before executing the statements found in that
	// chunk. Reaching EOF therefore means parsing is complete, not execution.
	// Reserve 100% for the successful terminal event.
	if !strings.EqualFold(strings.TrimSpace(status), "done") && percent >= 100 {
		return 99
	}
	return percent
}

func resolveSQLFileExecutionRunConfig(config connection.ConnectionConfig, dbName string, preamble []byte) connection.ConnectionConfig {
	runConfig := normalizeRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "mysql") {
		_, isGoNaviDatabaseBackup := parseGoNaviMySQLDatabaseBackupPreamble(preamble)
		if !isGoNaviDatabaseBackup {
			return runConfig
		}
		// A GoNavi database backup creates and selects its source database itself.
		// Connect at server level so restoring into a deleted database can start.
		runConfig.Database = ""
	}
	return runConfig
}

func buildSQLFileExecutionPayload(executed, failed int, outcome string) map[string]interface{} {
	outcome = strings.ToLower(strings.TrimSpace(outcome))
	completed := outcome == "completed" || outcome == "partial"
	stoppedOnError := outcome == "stopped"
	cancelled := outcome == "cancelled"
	return map[string]interface{}{
		"executed":       executed,
		"failed":         failed,
		"completed":      completed,
		"stoppedOnError": stoppedOnError,
		"cancelled":      cancelled,
		"outcome":        outcome,
	}
}
