package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func hashImportJobContract(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func buildImportTargetFingerprint(config connection.ConnectionConfig, dbName, tableName string) string {
	return hashImportJobContract(struct {
		Type      string   `json:"type"`
		Host      string   `json:"host"`
		Hosts     []string `json:"hosts,omitempty"`
		Port      int      `json:"port"`
		User      string   `json:"user"`
		Database  string   `json:"database"`
		DBName    string   `json:"dbName"`
		TableName string   `json:"tableName,omitempty"`
	}{
		Type:      strings.ToLower(strings.TrimSpace(config.Type)),
		Host:      strings.ToLower(strings.TrimSpace(config.Host)),
		Hosts:     append([]string(nil), config.Hosts...),
		Port:      config.Port,
		User:      strings.TrimSpace(config.User),
		Database:  strings.TrimSpace(config.Database),
		DBName:    strings.TrimSpace(dbName),
		TableName: strings.TrimSpace(tableName),
	})
}

func buildImportFileOptionsHash(options ImportFileOptions) string {
	continueOnError := true
	if options.ContinueOnError != nil {
		continueOnError = *options.ContinueOnError
	}
	encoding := strings.ToLower(strings.TrimSpace(options.Encoding))
	if encoding == "" {
		encoding = importTextEncodingAuto
	}
	delimiter := strings.ToLower(strings.TrimSpace(options.Delimiter))
	if delimiter == "" {
		delimiter = importDelimiterAuto
	}
	headerRow := options.HeaderRow
	if headerRow == 0 {
		headerRow = 1
	}
	conflictPolicy := strings.ToLower(strings.TrimSpace(options.ConflictPolicy))
	if conflictPolicy == "" {
		conflictPolicy = importConflictPolicyStop
	}
	return hashImportJobContract(struct {
		ColumnMappings     map[string]string `json:"columnMappings,omitempty"`
		ContinueOnError    bool              `json:"continueOnError"`
		Encoding           string            `json:"encoding,omitempty"`
		Delimiter          string            `json:"delimiter,omitempty"`
		HeaderRow          int               `json:"headerRow,omitempty"`
		NullToken          *string           `json:"nullToken,omitempty"`
		EmptyStringAsNull  bool              `json:"emptyStringAsNull,omitempty"`
		SheetName          string            `json:"sheetName,omitempty"`
		ConflictPolicy     string            `json:"conflictPolicy,omitempty"`
		ConflictKeyColumns []string          `json:"conflictKeyColumns,omitempty"`
	}{
		ColumnMappings:     options.ColumnMappings,
		ContinueOnError:    continueOnError,
		Encoding:           encoding,
		Delimiter:          delimiter,
		HeaderRow:          headerRow,
		NullToken:          options.NullToken,
		EmptyStringAsNull:  options.EmptyStringAsNull,
		SheetName:          options.SheetName,
		ConflictPolicy:     conflictPolicy,
		ConflictKeyColumns: append([]string(nil), options.ConflictKeyColumns...),
	})
}

func buildSQLImportOptionsHash(continueOnError bool, maxStatementBytes int64) string {
	return buildSQLImportOptionsHashWithTransactionMode(continueOnError, maxStatementBytes, sqlFileTransactionModeOff)
}

func buildSQLImportOptionsHashWithTransactionMode(continueOnError bool, maxStatementBytes int64, transactionMode sqlFileTransactionMode) string {
	if maxStatementBytes <= 0 {
		maxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if transactionMode != sqlFileTransactionModeSingle {
		transactionMode = sqlFileTransactionModeOff
	}
	return hashImportJobContract(struct {
		ContinueOnError   bool   `json:"continueOnError"`
		MaxStatementBytes int64  `json:"maxStatementBytes"`
		TransactionMode   string `json:"transactionMode"`
	}{
		ContinueOnError:   continueOnError,
		MaxStatementBytes: maxStatementBytes,
		TransactionMode:   string(transactionMode),
	})
}

func buildSQLImportOptionsHashWithGTIDMode(continueOnError bool, maxStatementBytes int64, transactionMode sqlFileTransactionMode, gtidMode mysqlGTIDImportMode) string {
	if gtidMode == "" {
		return buildSQLImportOptionsHashWithTransactionMode(continueOnError, maxStatementBytes, transactionMode)
	}
	if maxStatementBytes <= 0 {
		maxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if transactionMode != sqlFileTransactionModeSingle {
		transactionMode = sqlFileTransactionModeOff
	}
	return hashImportJobContract(struct {
		ContinueOnError   bool   `json:"continueOnError"`
		MaxStatementBytes int64  `json:"maxStatementBytes"`
		TransactionMode   string `json:"transactionMode"`
		MySQLGTIDMode     string `json:"mysqlGTIDMode"`
	}{
		ContinueOnError:   continueOnError,
		MaxStatementBytes: maxStatementBytes,
		TransactionMode:   string(transactionMode),
		MySQLGTIDMode:     string(gtidMode),
	})
}
