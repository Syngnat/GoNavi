package app

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/xuri/excelize/v2"

	"GoNavi-Wails/internal/connection"
	sharedi18n "GoNavi-Wails/shared/i18n"
)

const (
	connectionExcelDataSheet     = "connections"
	connectionExcelListSheet     = "_lists"
	connectionExcelTemplateRows  = 1000
	connectionExcelBoolTrue      = "true"
	connectionExcelBoolFalse     = "false"
	connectionExcelEnvProduction = "production"
	connectionExcelEnvTest       = "test"
	connectionExcelEnvDev        = "development"
	connectionExcelEnvLocal      = "local"
)

type connectionExcelColumnSpec struct {
	Key       string
	HeaderKey string
	Aliases   []string
	Dropdown  []string
	TypeList  bool
}

var connectionExcelColumns = []connectionExcelColumnSpec{
	{Key: "name", HeaderKey: "connection_modal.field.connection_name", Aliases: []string{"name", "connectionname", "connection name", "连接名", "连接名称", "名称"}},
	{Key: "type", HeaderKey: "app.connection_package.excel.column.type", Aliases: []string{"type", "dbtype", "db type", "databasetype", "database type", "类型", "数据库类型", "数据源类型"}, TypeList: true},
	{Key: "environment", HeaderKey: "app.connection_package.excel.column.environment", Aliases: []string{"environment", "environmenttype", "env", "环境", "环境类型", "本地环境", "生产环境"}, Dropdown: []string{connectionExcelEnvProduction, connectionExcelEnvTest, connectionExcelEnvDev, connectionExcelEnvLocal}},
	{Key: "group", HeaderKey: "app.connection_package.excel.column.group", Aliases: []string{"group", "groupname", "connectiongroup", "分组", "连接分组"}},
	{Key: "host", HeaderKey: "connection_modal.field.host", Aliases: []string{"host", "hostname", "address", "地址", "主机", "主机地址"}},
	{Key: "port", HeaderKey: "connection_modal.field.port", Aliases: []string{"port", "端口"}},
	{Key: "user", HeaderKey: "connection_modal.field.username", Aliases: []string{"user", "username", "用户", "用户名"}},
	{Key: "password", HeaderKey: "connection_modal.field.password", Aliases: []string{"password", "pwd", "密码"}},
	{Key: "database", HeaderKey: "app.connection_package.excel.column.database", Aliases: []string{"database", "dbname", "db", "databaseName", "数据库", "默认数据库"}},
	{Key: "sslmode", HeaderKey: "connection_modal.network.ssl_mode", Aliases: []string{"sslmode", "ssl mode", "ssl模式"}, Dropdown: []string{"preferred", "required", "skip-verify", "disable"}},
	{Key: "timeout", HeaderKey: "connection_modal.field.connection_timeout_seconds", Aliases: []string{"timeout", "连接超时", "超时"}},
	{Key: "querytimeout", HeaderKey: "app.connection_package.excel.column.query_timeout", Aliases: []string{"querytimeout", "query timeout", "查询超时"}},
	{Key: "readonly", HeaderKey: "app.connection_package.excel.column.read_only", Aliases: []string{"readonly", "read only", "只读"}, Dropdown: []string{connectionExcelBoolTrue, connectionExcelBoolFalse}},
	{Key: "usessl", HeaderKey: "app.connection_package.excel.column.use_ssl", Aliases: []string{"usessl", "use ssl", "使用ssl"}, Dropdown: []string{connectionExcelBoolTrue, connectionExcelBoolFalse}},
	{Key: "usessh", HeaderKey: "app.connection_package.excel.column.use_ssh", Aliases: []string{"usessh", "use ssh", "使用ssh"}, Dropdown: []string{connectionExcelBoolTrue, connectionExcelBoolFalse}},
	{Key: "sshhost", HeaderKey: "connection_modal.field.ssh_host", Aliases: []string{"sshhost", "ssh host", "ssh主机"}},
	{Key: "sshport", HeaderKey: "app.connection_package.excel.column.ssh_port", Aliases: []string{"sshport", "ssh port", "ssh端口"}},
	{Key: "sshuser", HeaderKey: "connection_modal.field.ssh_user", Aliases: []string{"sshuser", "ssh user", "ssh用户"}},
	{Key: "sshpassword", HeaderKey: "connection_modal.field.ssh_password", Aliases: []string{"sshpassword", "ssh password", "ssh密码"}},
	{Key: "sshkeypath", HeaderKey: "connection_modal.field.private_key_path_optional", Aliases: []string{"sshkeypath", "ssh key", "私钥路径"}},
	{Key: "connectionparams", HeaderKey: "app.connection_package.excel.column.connection_params", Aliases: []string{"connectionparams", "connection params", "连接参数"}},
	{Key: "dsn", HeaderKey: "connection_modal.field.dsn", Aliases: []string{"dsn"}},
	{Key: "remark", HeaderKey: "app.connection_package.excel.column.remark", Aliases: []string{"remark", "comment", "备注"}},
}

var connectionExcelTypeValues = []string{
	"mysql", "mariadb", "diros", "starrocks", "sphinx", "clickhouse", "trino",
	"postgres", "sqlserver", "iris", "cache", "sqlite", "duckdb", "oracle",
	"oceanbase", "dameng", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "goldendb",
	"mongodb", "redis", "elasticsearch",
	"chroma", "qdrant", "milvus",
	"tdengine", "iotdb",
	"rocketmq", "mqtt", "kafka", "rabbitmq", "pulsar",
	"nacos", "jvm", "custom",
}

var connectionExcelExportColumns []string
var connectionExcelTypeSet map[string]struct{}
var connectionExcelHeaderAliasesOnce sync.Once
var connectionExcelHeaderAliasesValue map[string][]string

func init() {
	connectionExcelExportColumns = make([]string, 0, len(connectionExcelColumns))
	connectionExcelTypeSet = make(map[string]struct{}, len(connectionExcelTypeValues))
	for _, column := range connectionExcelColumns {
		connectionExcelExportColumns = append(connectionExcelExportColumns, column.Key)
	}
	for _, driverType := range connectionExcelTypeValues {
		connectionExcelTypeSet[driverType] = struct{}{}
	}
}

func connectionExcelHeaderAliases() map[string][]string {
	connectionExcelHeaderAliasesOnce.Do(func() {
		aliases := make(map[string][]string, len(connectionExcelColumns))
		for _, column := range connectionExcelColumns {
			seen := make(map[string]struct{}, len(column.Aliases)+8)
			values := make([]string, 0, len(column.Aliases)+8)
			add := func(value string) {
				normalized := normalizeConnectionExcelHeaderCell(value)
				if normalized == "" {
					return
				}
				if _, exists := seen[normalized]; exists {
					return
				}
				seen[normalized] = struct{}{}
				values = append(values, value)
			}
			add(column.Key)
			for _, alias := range column.Aliases {
				add(alias)
			}
			aliases[column.Key] = values
		}
		catalogs, err := sharedi18n.LoadCatalogs()
		if err == nil {
			for _, column := range connectionExcelColumns {
				if column.HeaderKey == "" {
					continue
				}
				for _, catalog := range catalogs {
					addLocalizedExcelHeaderAlias(aliases, column.Key, catalog[column.HeaderKey])
				}
			}
		}
		connectionExcelHeaderAliasesValue = aliases
	})
	return connectionExcelHeaderAliasesValue
}

func addLocalizedExcelHeaderAlias(aliases map[string][]string, key string, value string) {
	normalized := normalizeConnectionExcelHeaderCell(value)
	if normalized == "" {
		return
	}
	for _, existing := range aliases[key] {
		if normalizeConnectionExcelHeaderCell(existing) == normalized {
			return
		}
	}
	aliases[key] = append(aliases[key], value)
}

func isConnectionExcelType(driverType string) bool {
	_, ok := connectionExcelTypeSet[normalizeDriverType(driverType)]
	return ok
}

func connectionExcelAllowsEmptyHost(driverType string) bool {
	switch normalizeDriverType(driverType) {
	case "sqlite", "duckdb", "custom":
		return true
	default:
		return false
	}
}

// 连接导入结果中的分组归属：按连接名回指 Excel 行声明的分组路径。
type ConnectionExcelGroupAssignment struct {
	ConnectionName string `json:"connectionName"`
	GroupPath      string `json:"groupPath"`
}

type ConnectionExcelParseResult struct {
	Inputs    []connection.SavedConnectionInput
	Groups    []ConnectionExcelGroupAssignment
	RemarkMap map[string]string
}

var errConnectionExcelHeaderRequired = fmt.Errorf("excel connection import requires at least name and type columns")

func normalizeConnectionExcelHeaderCell(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(value))), "")
}

func buildConnectionExcelHeaderIndex(columns []string) (map[string]string, error) {
	aliases := connectionExcelHeaderAliases()
	index := make(map[string]string, len(columns))
	for _, column := range columns {
		normalized := normalizeConnectionExcelHeaderCell(column)
		if normalized == "" {
			continue
		}
		for canonical, names := range aliases {
			matched := false
			for _, alias := range names {
				if normalizeConnectionExcelHeaderCell(alias) == normalized {
					matched = true
					break
				}
			}
			if matched {
				if existing, exists := index[canonical]; exists && existing != column {
					return nil, fmt.Errorf("duplicate excel column %q maps to %s (first seen as %q)", column, canonical, existing)
				}
				index[canonical] = column
				break
			}
		}
	}
	for _, required := range []string{"name", "type"} {
		if _, ok := index[required]; !ok {
			return nil, errConnectionExcelHeaderRequired
		}
	}
	return index, nil
}

type connectionExcelRowConsumer struct {
	headerIndex map[string]string
	columns     []string
	rowNumber   int
	result      *ConnectionExcelParseResult
	parseError  error
}

func (c *connectionExcelRowConsumer) SetColumns(columns []string) error {
	index, err := buildConnectionExcelHeaderIndex(columns)
	if err != nil {
		return err
	}
	c.headerIndex = index
	c.columns = columns
	return nil
}

func (c *connectionExcelRowConsumer) ConsumeRow(row map[string]interface{}) error {
	c.rowNumber++
	if c.parseError != nil {
		return nil
	}
	cell := func(canonical string) (string, bool) {
		column, ok := c.headerIndex[canonical]
		if !ok {
			return "", false
		}
		value, ok := row[column]
		if !ok || value == nil {
			return "", true
		}
		return strings.TrimSpace(fmt.Sprintf("%v", value)), true
	}

	name, _ := cell("name")
	typeRaw, _ := cell("type")
	host, _ := cell("host")
	portRaw, _ := cell("port")
	user, _ := cell("user")
	password, _ := cell("password")
	database, _ := cell("database")
	group, _ := cell("group")
	remark, _ := cell("remark")
	sslMode, _ := cell("sslmode")
	timeoutRaw, _ := cell("timeout")
	queryTimeoutRaw, _ := cell("querytimeout")
	environmentRaw, _ := cell("environment")
	readOnlyRaw, _ := cell("readonly")
	useSSLRaw, _ := cell("usessl")
	useSSHRaw, _ := cell("usessh")
	sshHost, _ := cell("sshhost")
	sshPortRaw, _ := cell("sshport")
	sshUser, _ := cell("sshuser")
	sshPassword, _ := cell("sshpassword")
	sshKeyPath, _ := cell("sshkeypath")
	connectionParams, _ := cell("connectionparams")
	dsn, _ := cell("dsn")

	rowNumber := c.rowNumber
	invalid := func(field, value string) error {
		return fmt.Errorf("excel row %d: %s %q is invalid", rowNumber, field, value)
	}

	if name == "" && typeRaw == "" && host == "" {
		return nil
	}
	if name == "" {
		c.parseError = invalid("name", name)
		return nil
	}

	normalizedType := normalizeDriverType(typeRaw)
	if !isConnectionExcelType(normalizedType) {
		c.parseError = invalid("type", typeRaw)
		return nil
	}

	port := 0
	if portRaw == "" {
		port = defaultPortByType(normalizedType)
	} else {
		parsed, err := strconv.Atoi(portRaw)
		if err != nil || parsed < 0 || parsed > 65535 {
			c.parseError = invalid("port", portRaw)
			return nil
		}
		port = parsed
	}

	if host == "" && !connectionExcelAllowsEmptyHost(normalizedType) {
		c.parseError = invalid("host", host)
		return nil
	}

	readOnly, err := parseExcelOptionalBool(readOnlyRaw)
	if err != nil {
		c.parseError = invalid("readonly", readOnlyRaw)
		return nil
	}
	useSSL, err := parseExcelOptionalBool(useSSLRaw)
	if err != nil {
		c.parseError = invalid("usessl", useSSLRaw)
		return nil
	}
	useSSH, err := parseExcelOptionalBool(useSSHRaw)
	if err != nil {
		c.parseError = invalid("usessh", useSSHRaw)
		return nil
	}

	sshPort := 0
	if sshPortRaw != "" {
		parsed, err := strconv.Atoi(sshPortRaw)
		if err != nil || parsed < 0 || parsed > 65535 {
			c.parseError = invalid("sshport", sshPortRaw)
			return nil
		}
		sshPort = parsed
	}

	config := connection.ConnectionConfig{
		Type:             normalizedType,
		Host:             host,
		Port:             port,
		User:             user,
		Password:         password,
		Database:         database,
		SSLMode:          sslMode,
		ReadOnly:         readOnly,
		UseSSL:           useSSL,
		UseSSH:           useSSH,
		DSN:              dsn,
		ConnectionParams: connectionParams,
		SSH: connection.SSHConfig{
			Host:     sshHost,
			Port:     sshPort,
			User:     sshUser,
			Password: sshPassword,
			KeyPath:  sshKeyPath,
		},
	}
	if timeoutRaw != "" {
		parsed, err := strconv.Atoi(timeoutRaw)
		if err != nil || parsed < 0 {
			c.parseError = invalid("timeout", timeoutRaw)
			return nil
		}
		if parsed > 0 {
			config.Timeout = parsed
		}
	}
	if queryTimeoutRaw != "" {
		parsed, err := strconv.Atoi(queryTimeoutRaw)
		if err != nil || parsed < 0 {
			c.parseError = invalid("querytimeout", queryTimeoutRaw)
			return nil
		}
		config.QueryTimeout = parsed
	}

	input := connection.SavedConnectionInput{
		Name:            name,
		EnvironmentType: parseExcelEnvironment(environmentRaw),
		Config:          config,
	}
	c.result.Inputs = append(c.result.Inputs, input)
	if group != "" {
		c.result.Groups = append(c.result.Groups, ConnectionExcelGroupAssignment{
			ConnectionName: name,
			GroupPath:      group,
		})
	}
	if remark != "" {
		if c.result.RemarkMap == nil {
			c.result.RemarkMap = make(map[string]string)
		}
		c.result.RemarkMap[name] = remark
	}
	return nil
}

func parseExcelOptionalBool(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "0", "false", "no", "n", "off", "否", "いいえ":
		return false, nil
	case "1", "true", "yes", "y", "on", "是", "はい":
		return true, nil
	default:
		return false, fmt.Errorf("invalid bool")
	}
}

func parseExcelEnvironment(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	switch strings.ToLower(trimmed) {
	case connectionExcelEnvProduction, connectionExcelEnvTest, connectionExcelEnvDev, connectionExcelEnvLocal:
		return strings.ToLower(trimmed)
	}
	normalizedHeader := normalizeConnectionExcelHeaderCell(trimmed)
	catalogs, err := sharedi18n.LoadCatalogs()
	if err == nil {
		for _, key := range []string{connectionExcelEnvProduction, connectionExcelEnvTest, connectionExcelEnvDev, connectionExcelEnvLocal} {
			headerKey := "connection.environment." + key
			for _, catalog := range catalogs {
				if normalizeConnectionExcelHeaderCell(catalog[headerKey]) == normalizedHeader {
					return key
				}
			}
		}
	}
	return normalizeConnectionEnvironmentType(trimmed)
}

func (c *connectionExcelRowConsumer) finish() (*ConnectionExcelParseResult, error) {
	if c.parseError != nil {
		return nil, c.parseError
	}
	if len(c.result.Inputs) == 0 {
		return nil, fmt.Errorf("excel import contains no connection rows")
	}
	c.result.Inputs = dedupeImportedSavedConnectionInputs(c.result.Inputs)
	return c.result, nil
}

func parseConnectionsExcelFile(filePath string) (*ConnectionExcelParseResult, error) {
	consumer := &connectionExcelRowConsumer{result: &ConnectionExcelParseResult{}}
	if err := streamXLSXImportFileWithOptions(filePath, consumer, ImportFileOptions{SheetName: connectionExcelDataSheet}); err != nil {
		lowered := strings.ToLower(err.Error())
		if strings.Contains(lowered, "worksheet") && strings.Contains(lowered, "not found") {
			consumer = &connectionExcelRowConsumer{result: &ConnectionExcelParseResult{}}
			if err := streamXLSXImportFileWithOptions(filePath, consumer, ImportFileOptions{}); err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	return consumer.finish()
}

// connectionsExcelImportEnvelope 标记 ImportConfigFile 统一入口已完成的 Excel 导入；
// 前端据此跳过文本导入通道，直接把 Result 交给 Excel 分组落位逻辑。
type connectionsExcelImportEnvelope struct {
	GonaviExcelImport bool                          `json:"gonaviExcelImport"`
	Result            ConnectionPackageImportResult `json:"result"`
}

func isConnectionsExcelImportEnvelope(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var envelope connectionsExcelImportEnvelope
	if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
		return false
	}
	return envelope.GonaviExcelImport
}

func (a *App) importConnectionsExcelFile(filePath string) (ConnectionPackageImportResult, error) {
	parsed, err := parseConnectionsExcelFile(filePath)
	if err != nil {
		return ConnectionPackageImportResult{}, err
	}
	views, err := a.importSavedConnectionsAtomically(parsed.Inputs)
	if err != nil {
		return ConnectionPackageImportResult{}, err
	}

	nameToID := make(map[string]string, len(views))
	for _, view := range views {
		nameToID[view.Name] = view.ID
	}
	assignments := make([]ConnectionExcelGroupAssignment, 0, len(parsed.Groups))
	for _, group := range parsed.Groups {
		if _, ok := nameToID[group.ConnectionName]; !ok {
			continue
		}
		assignments = append(assignments, group)
	}
	result := connectionPackageImportResultFromViews(views, nil)
	result.ExcelGroups = assignments
	return result, nil
}

func (a *App) ImportConnectionsExcelFileBase64(base64Content string) connection.QueryResult {
	decoded, err := decodeConnectionsExcelBase64(base64Content)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer os.Remove(decoded.filePath)

	if err := validateConnectionsExcelFileSize(decoded.filePath); err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageMessage(a.appText, err)}
	}

	result, err := a.importConnectionsExcelFile(decoded.filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedExcelImportError(a.appText, err)}
	}
	return connection.QueryResult{Success: true, Data: result}
}

type connectionsExcelTempFile struct {
	filePath string
}

func decodeConnectionsExcelBase64(base64Content string) (connectionsExcelTempFile, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(base64Content))
	if err != nil {
		return connectionsExcelTempFile{}, fmt.Errorf("invalid base64 payload: %w", err)
	}
	if len(decoded) > connectionImportMaxFileBytes {
		return connectionsExcelTempFile{}, errConnectionImportFileTooLarge
	}
	tmp, err := os.CreateTemp("", "gonavi-connections-excel-*.xlsx")
	if err != nil {
		return connectionsExcelTempFile{}, err
	}
	if _, err := tmp.Write(decoded); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return connectionsExcelTempFile{}, err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return connectionsExcelTempFile{}, err
	}
	return connectionsExcelTempFile{filePath: tmp.Name()}, nil
}

func validateConnectionsExcelFileSize(filePath string) error {
	info, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if info.Size() > connectionImportMaxFileBytes {
		return errConnectionImportFileTooLarge
	}
	return nil
}

func localizedExcelImportError(text connectionPackageTextFunc, err error) string {
	if err == nil {
		return ""
	}
	if _, ok := localizedConnectionPackageMessageKey(err); ok {
		return localizedConnectionPackageMessage(text, err)
	}
	return text("app.connection_package.excel.parse_failed", map[string]any{"detail": err.Error()})
}

type connectionExcelExportRow struct {
	Name             string
	Type             string
	Environment      string
	Group            string
	Host             string
	Port             int
	User             string
	Password         string
	Database         string
	SSLMode          string
	Timeout          int
	QueryTimeout     int
	ReadOnly         bool
	UseSSL           bool
	UseSSH           bool
	SSHHost          string
	SSHPort          int
	SSHUser          string
	SSHPassword      string
	SSHKeyPath       string
	ConnectionParams string
	DSN              string
}

func formatExcelBool(value bool) string {
	if value {
		return connectionExcelBoolTrue
	}
	return connectionExcelBoolFalse
}

func formatExcelInt(value int) string {
	if value == 0 {
		return ""
	}
	return strconv.Itoa(value)
}

func connectionExcelHeaderText(text connectionPackageTextFunc, column connectionExcelColumnSpec) string {
	if text == nil {
		text = defaultAppText
	}
	if column.HeaderKey == "" {
		return column.Key
	}
	label := strings.TrimSpace(text(column.HeaderKey, nil))
	if label == "" || label == column.HeaderKey {
		if len(column.Aliases) > 0 {
			return column.Aliases[len(column.Aliases)-1]
		}
		return column.Key
	}
	return label
}

func writeConnectionsExcelBytes(text connectionPackageTextFunc, rows []connectionExcelExportRow) ([]byte, error) {
	if text == nil {
		text = defaultAppText
	}
	workbook := excelize.NewFile()
	defer workbook.Close()

	if err := workbook.SetSheetName("Sheet1", connectionExcelDataSheet); err != nil {
		return nil, err
	}
	if _, err := workbook.NewSheet(connectionExcelListSheet); err != nil {
		return nil, err
	}

	headers := make([]string, 0, len(connectionExcelColumns))
	for _, column := range connectionExcelColumns {
		headers = append(headers, connectionExcelHeaderText(text, column))
	}
	if err := workbook.SetSheetRow(connectionExcelDataSheet, "A1", &headers); err != nil {
		return nil, err
	}
	headerStyle, err := workbook.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	if err != nil {
		return nil, err
	}
	lastCol, err := excelize.ColumnNumberToName(len(connectionExcelColumns))
	if err != nil {
		return nil, err
	}
	if err := workbook.SetCellStyle(connectionExcelDataSheet, "A1", lastCol+"1", headerStyle); err != nil {
		return nil, err
	}

	for index, row := range rows {
		values := []interface{}{
			row.Name,
			row.Type,
			row.Environment,
			row.Group,
			row.Host,
			formatExcelInt(row.Port),
			row.User,
			row.Password,
			row.Database,
			row.SSLMode,
			formatExcelInt(row.Timeout),
			formatExcelInt(row.QueryTimeout),
			formatExcelBool(row.ReadOnly),
			formatExcelBool(row.UseSSL),
			formatExcelBool(row.UseSSH),
			row.SSHHost,
			formatExcelInt(row.SSHPort),
			row.SSHUser,
			row.SSHPassword,
			row.SSHKeyPath,
			row.ConnectionParams,
			row.DSN,
			"",
		}
		cell, err := excelize.CoordinatesToCellName(1, index+2)
		if err != nil {
			return nil, err
		}
		if err := workbook.SetSheetRow(connectionExcelDataSheet, cell, &values); err != nil {
			return nil, err
		}
	}

	if err := writeConnectionExcelListSheet(workbook); err != nil {
		return nil, err
	}
	if err := applyConnectionExcelDropdowns(workbook); err != nil {
		return nil, err
	}
	_ = workbook.SetColWidth(connectionExcelDataSheet, "A", lastCol, 16)
	_ = workbook.SetColWidth(connectionExcelDataSheet, "A", "A", 22)
	_ = workbook.SetColWidth(connectionExcelDataSheet, "E", "E", 24)
	_ = workbook.SetColWidth(connectionExcelDataSheet, "H", "H", 18)
	if err := workbook.SetSheetVisible(connectionExcelListSheet, false); err != nil {
		return nil, err
	}

	buffer, err := workbook.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	content := buffer.Bytes()
	if len(content) > connectionImportMaxFileBytes {
		return nil, errConnectionImportFileTooLarge
	}
	return content, nil
}

func writeConnectionExcelListSheet(workbook *excelize.File) error {
	for index, value := range connectionExcelTypeValues {
		cell, err := excelize.CoordinatesToCellName(1, index+1)
		if err != nil {
			return err
		}
		if err := workbook.SetCellValue(connectionExcelListSheet, cell, value); err != nil {
			return err
		}
	}
	return nil
}

func applyConnectionExcelDropdowns(workbook *excelize.File) error {
	endRow := connectionExcelTemplateRows + 1
	for index, column := range connectionExcelColumns {
		colName, err := excelize.ColumnNumberToName(index + 1)
		if err != nil {
			return err
		}
		sqref := fmt.Sprintf("%s2:%s%d", colName, colName, endRow)
		dv := excelize.NewDataValidation(true)
		dv.Sqref = sqref
		switch {
		case column.TypeList:
			dv.SetSqrefDropList(fmt.Sprintf("%s!$A$1:$A$%d", connectionExcelListSheet, len(connectionExcelTypeValues)))
		case len(column.Dropdown) > 0:
			if err := dv.SetDropList(column.Dropdown); err != nil {
				return err
			}
		default:
			continue
		}
		if err := workbook.AddDataValidation(connectionExcelDataSheet, dv); err != nil {
			return err
		}
	}
	return nil
}

func connectionExcelRowFromPackageItem(item connectionPackageItem, groupPath string, includeSecrets bool) connectionExcelExportRow {
	password := ""
	sshPassword := ""
	dsn := item.Config.DSN
	if includeSecrets {
		password = item.Secrets.Password
		sshPassword = item.Secrets.SSHPassword
		if dsn == "" {
			dsn = item.Secrets.OpaqueDSN
		}
	}
	environment := strings.TrimSpace(item.EnvironmentType)
	if environment == "" {
		environment = defaultConnectionEnvironment
	}
	return connectionExcelExportRow{
		Name:             item.Name,
		Type:             item.Config.Type,
		Environment:      environment,
		Group:            groupPath,
		Host:             item.Config.Host,
		Port:             item.Config.Port,
		User:             item.Config.User,
		Password:         password,
		Database:         item.Config.Database,
		SSLMode:          item.Config.SSLMode,
		Timeout:          item.Config.Timeout,
		QueryTimeout:     item.Config.QueryTimeout,
		ReadOnly:         item.Config.ReadOnly,
		UseSSL:           item.Config.UseSSL,
		UseSSH:           item.Config.UseSSH,
		SSHHost:          item.Config.SSH.Host,
		SSHPort:          item.Config.SSH.Port,
		SSHUser:          item.Config.SSH.User,
		SSHPassword:      sshPassword,
		SSHKeyPath:       item.Config.SSH.KeyPath,
		ConnectionParams: item.Config.ConnectionParams,
		DSN:              dsn,
	}
}

func (a *App) buildConnectionsExcelBytes(connectionIDs []string, includeSecrets bool) ([]byte, error) {
	payload, err := a.buildConnectionPackagePayload(nil, connectionIDs)
	if err != nil {
		return nil, err
	}

	layout, err := a.LoadConnectionSidebarLayout()
	if err != nil {
		return nil, err
	}
	connectionGroupPaths := make(map[string]string, len(layout.ConnectionTags))
	tagByID := make(map[string]connection.ConnectionTag, len(layout.ConnectionTags))
	for _, tag := range layout.ConnectionTags {
		tagByID[tag.ID] = tag
	}
	var resolveTagPath func(tag connection.ConnectionTag, visited map[string]bool) string
	resolveTagPath = func(tag connection.ConnectionTag, visited map[string]bool) string {
		if visited[tag.ID] {
			return tag.Name
		}
		visited[tag.ID] = true
		if tag.ParentTagID == "" {
			return tag.Name
		}
		if parent, ok := tagByID[tag.ParentTagID]; ok {
			return resolveTagPath(parent, visited) + "/" + tag.Name
		}
		return tag.Name
	}
	for _, tag := range layout.ConnectionTags {
		path := resolveTagPath(tag, make(map[string]bool))
		for _, connectionID := range tag.ConnectionIDs {
			if existing, ok := connectionGroupPaths[connectionID]; !ok || len(path) < len(existing) {
				connectionGroupPaths[connectionID] = path
			}
		}
	}

	rows := make([]connectionExcelExportRow, 0, len(payload.Connections))
	for _, item := range payload.Connections {
		rows = append(rows, connectionExcelRowFromPackageItem(item, connectionGroupPaths[item.ID], includeSecrets))
	}
	return writeConnectionsExcelBytes(a.appText, rows)
}

func (a *App) exportConnectionsExcelToPath(filename string, options ConnectionExportOptions) connection.QueryResult {
	if !strings.EqualFold(filepath.Ext(filename), ".xlsx") {
		filename += ".xlsx"
	}
	content, err := a.buildConnectionsExcelBytes(options.ConnectionIDs, options.IncludeSecrets)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	if err := os.WriteFile(filename, content, 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

func (a *App) ExportConnectionsExcel(options ConnectionExportOptions) connection.QueryResult {
	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("app.connection_package.excel.export_dialog_title", nil),
		DefaultFilename: "connections.xlsx",
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("app.connection_package.excel.filter", nil),
				Pattern:     "*.xlsx",
			},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	return a.exportConnectionsExcelToPath(filename, options)
}

func (a *App) ExportConnectionsExcelPayload(options ConnectionExportOptions) connection.QueryResult {
	content, err := a.buildConnectionsExcelBytes(options.ConnectionIDs, options.IncludeSecrets)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data:    base64.StdEncoding.EncodeToString(content),
	}
}
