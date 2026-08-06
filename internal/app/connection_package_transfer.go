package app

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"

	"github.com/google/uuid"
)

func newConnectionPackageItem(view connection.SavedConnectionView, bundle connectionSecretBundle, redisDbAliases map[string]string) connectionPackageItem {
	return connectionPackageItem{
		ID:                         view.ID,
		Name:                       view.Name,
		EnvironmentType:            view.EnvironmentType,
		IncludeDatabases:           cloneStringSlice(view.IncludeDatabases),
		IncludeDatabasePatterns:    cloneStringSlice(view.IncludeDatabasePatterns),
		ExcludeDatabasePatterns:    cloneStringSlice(view.ExcludeDatabasePatterns),
		IncludeRedisDatabases:      cloneIntSlice(view.IncludeRedisDatabases),
		SchemaVisibilityByDatabase: cloneSchemaVisibilityByDatabase(view.SchemaVisibilityByDatabase),
		RedisDbAliases:             cloneStringMap(redisDbAliases),
		IconType:                   view.IconType,
		IconColor:                  view.IconColor,
		Config:                     stripConnectionSecretFields(view.Config),
		Secrets:                    bundle,
	}
}

func sanitizeConnectionPackageRedisDbAliases(value map[string]map[string]string) map[string]map[string]string {
	if len(value) == 0 {
		return nil
	}
	result := make(map[string]map[string]string, len(value))
	for connectionID, aliases := range value {
		id := strings.TrimSpace(connectionID)
		if id == "" || len(aliases) == 0 {
			continue
		}
		cleaned := make(map[string]string, len(aliases))
		for dbIndex, alias := range aliases {
			dbKey := strings.TrimSpace(dbIndex)
			if dbKey == "" {
				continue
			}
			// 仅接受数字下标，与前端 redisDbAlias 一致
			if _, err := strconv.Atoi(dbKey); err != nil {
				continue
			}
			label := strings.Join(strings.Fields(strings.TrimSpace(alias)), " ")
			if label == "" {
				continue
			}
			if len(label) > 64 {
				label = label[:64]
			}
			cleaned[dbKey] = label
		}
		if len(cleaned) > 0 {
			result[id] = cleaned
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func collectRedisDbAliasesFromPackagePayload(payload connectionPackagePayload) map[string]map[string]string {
	merged := make(map[string]map[string]string)
	// 顶层字段（若有）
	for connectionID, aliases := range sanitizeConnectionPackageRedisDbAliases(payload.RedisDbAliases) {
		merged[connectionID] = cloneStringMap(aliases)
	}
	// 连接项内嵌字段优先覆盖（导出时与连接同级，更可靠）
	for _, item := range payload.Connections {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		cleaned := sanitizeConnectionPackageRedisDbAliases(map[string]map[string]string{id: item.RedisDbAliases})
		if aliases, ok := cleaned[id]; ok && len(aliases) > 0 {
			merged[id] = aliases
		}
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func normalizeConnectionExportIDFilter(connectionIDs []string) map[string]struct{} {
	if len(connectionIDs) == 0 {
		return nil
	}
	filter := make(map[string]struct{}, len(connectionIDs))
	for _, rawID := range connectionIDs {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		filter[id] = struct{}{}
	}
	if len(filter) == 0 {
		return nil
	}
	return filter
}

func filterRedisDbAliasesByConnectionIDs(
	aliases map[string]map[string]string,
	filter map[string]struct{},
) map[string]map[string]string {
	if filter == nil || len(aliases) == 0 {
		return aliases
	}
	filtered := make(map[string]map[string]string, len(filter))
	for connectionID, itemAliases := range aliases {
		id := strings.TrimSpace(connectionID)
		if _, ok := filter[id]; !ok {
			continue
		}
		filtered[id] = itemAliases
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}

func (a *App) buildConnectionPackagePayload(
	redisDbAliases map[string]map[string]string,
	connectionIDs []string,
) (connectionPackagePayload, error) {
	repo := a.savedConnectionRepository()
	items, err := repo.List()
	if err != nil {
		return connectionPackagePayload{}, err
	}

	idFilter := normalizeConnectionExportIDFilter(connectionIDs)
	aliasesByConnection := filterRedisDbAliasesByConnectionIDs(
		sanitizeConnectionPackageRedisDbAliases(redisDbAliases),
		idFilter,
	)
	connections := make([]connectionPackageItem, 0, len(items))
	for _, item := range items {
		itemID := strings.TrimSpace(item.ID)
		if idFilter != nil {
			if _, ok := idFilter[itemID]; !ok {
				continue
			}
		}
		bundle, bundleErr := repo.loadSecretBundle(item)
		if bundleErr != nil {
			return connectionPackagePayload{}, bundleErr
		}
		var itemAliases map[string]string
		if aliasesByConnection != nil {
			itemAliases = aliasesByConnection[itemID]
		}
		connections = append(connections, newConnectionPackageItem(item, bundle, itemAliases))
	}
	if idFilter != nil && len(connections) == 0 {
		return connectionPackagePayload{}, errors.New(a.appText("app.connection_package.error.no_selected_connections", nil))
	}

	return connectionPackagePayload{
		ExportedAt:     time.Now().UTC().Format(time.RFC3339),
		Connections:    connections,
		RedisDbAliases: aliasesByConnection,
	}, nil
}

func (a *App) buildExportedConnectionPackage(options ConnectionExportOptions) ([]byte, error) {
	payload, err := a.buildConnectionPackagePayload(options.RedisDbAliases, options.ConnectionIDs)
	if err != nil {
		return nil, err
	}

	if !options.IncludeSecrets {
		for index := range payload.Connections {
			payload.Connections[index].Secrets = connectionSecretBundle{}
		}
	}

	normalizedPassword := normalizeConnectionPackagePassword(options.FilePassword)
	if !options.IncludeSecrets || normalizedPassword == "" {
		file, err := encryptConnectionPackageV2AppManaged(payload)
		if err != nil {
			return nil, err
		}
		return json.MarshalIndent(file, "", "  ")
	}

	file, err := encryptConnectionPackageV2Protected(payload, normalizedPassword)
	if err != nil {
		return nil, err
	}
	return json.MarshalIndent(file, "", "  ")
}

func newSavedConnectionInputFromPackageItem(item connectionPackageItem) connection.SavedConnectionInput {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		id = strings.TrimSpace(item.Config.ID)
	}

	config := item.Config
	config.ID = id
	config.SavePassword = false

	secrets := item.Secrets
	config.Password = secrets.Password
	config.SSH.Password = secrets.SSHPassword
	config.Proxy.Password = secrets.ProxyPassword
	config.HTTPTunnel.Password = secrets.HTTPTunnelPassword
	config.MySQLReplicaPassword = secrets.MySQLReplicaPassword
	config.MongoReplicaPassword = secrets.MongoReplicaPassword
	config.RedisSentinelPassword = secrets.RedisSentinelPassword
	config.URI = secrets.OpaqueURI
	config.DSN = secrets.OpaqueDSN

	return connection.SavedConnectionInput{
		ID:                         id,
		Name:                       item.Name,
		EnvironmentType:            item.EnvironmentType,
		Config:                     config,
		IncludeDatabases:           cloneStringSlice(item.IncludeDatabases),
		IncludeDatabasePatterns:    cloneStringSlice(item.IncludeDatabasePatterns),
		ExcludeDatabasePatterns:    cloneStringSlice(item.ExcludeDatabasePatterns),
		IncludeRedisDatabases:      cloneIntSlice(item.IncludeRedisDatabases),
		SchemaVisibilityByDatabase: cloneSchemaVisibilityByDatabase(item.SchemaVisibilityByDatabase),
		IconType:                   item.IconType,
		IconColor:                  item.IconColor,
		// 连接恢复包以最新导入文件为准；载荷中缺失的密文字段需要显式清空旧值。
		ClearPrimaryPassword:       strings.TrimSpace(secrets.Password) == "",
		ClearSSHPassword:           strings.TrimSpace(secrets.SSHPassword) == "",
		ClearProxyPassword:         strings.TrimSpace(secrets.ProxyPassword) == "",
		ClearHTTPTunnelPassword:    strings.TrimSpace(secrets.HTTPTunnelPassword) == "",
		ClearMySQLReplicaPassword:  strings.TrimSpace(secrets.MySQLReplicaPassword) == "",
		ClearMongoReplicaPassword:  strings.TrimSpace(secrets.MongoReplicaPassword) == "",
		ClearRedisSentinelPassword: strings.TrimSpace(secrets.RedisSentinelPassword) == "",
		ClearOpaqueURI:             strings.TrimSpace(secrets.OpaqueURI) == "",
		ClearOpaqueDSN:             strings.TrimSpace(secrets.OpaqueDSN) == "",
	}
}

func dedupeImportedSavedConnectionViews(views []connection.SavedConnectionView) []connection.SavedConnectionView {
	if len(views) < 2 {
		return views
	}

	lastIndexByID := make(map[string]int, len(views))
	for index, view := range views {
		id := strings.TrimSpace(view.ID)
		if id == "" {
			continue
		}
		lastIndexByID[id] = index
	}

	result := make([]connection.SavedConnectionView, 0, len(views))
	for index, view := range views {
		id := strings.TrimSpace(view.ID)
		if id != "" && lastIndexByID[id] != index {
			continue
		}
		result = append(result, view)
	}
	return result
}

func dedupeImportedSavedConnectionInputs(inputs []connection.SavedConnectionInput) []connection.SavedConnectionInput {
	if len(inputs) < 2 {
		return inputs
	}

	lastIndexByID := make(map[string]int, len(inputs))
	for index, input := range inputs {
		id := strings.TrimSpace(input.ID)
		if id == "" {
			continue
		}
		lastIndexByID[id] = index
	}

	result := make([]connection.SavedConnectionInput, 0, len(inputs))
	for index, input := range inputs {
		id := strings.TrimSpace(input.ID)
		if id != "" && lastIndexByID[id] != index {
			continue
		}
		result = append(result, input)
	}
	return result
}

func normalizeImportedSavedConnectionInput(input connection.SavedConnectionInput) connection.SavedConnectionInput {
	if strings.TrimSpace(input.ID) == "" && strings.TrimSpace(input.Config.ID) == "" {
		input.ID = "conn-" + uuid.New().String()[:8]
	}
	if strings.TrimSpace(input.ID) == "" {
		input.ID = strings.TrimSpace(input.Config.ID)
	}
	input.Config.ID = input.ID
	return input
}

func (a *App) importSavedConnectionsAtomically(inputs []connection.SavedConnectionInput) ([]connection.SavedConnectionView, error) {
	repo := a.savedConnectionRepository()
	normalizedInputs := make([]connection.SavedConnectionInput, 0, len(inputs))
	for _, input := range inputs {
		normalizedInputs = append(normalizedInputs, normalizeImportedSavedConnectionInput(input))
	}
	finalInputs := dedupeImportedSavedConnectionInputs(normalizedInputs)
	rollbackSnapshot, err := captureConnectionImportRollbackSnapshot(a, finalInputs)
	if err != nil {
		return nil, err
	}

	result := make([]connection.SavedConnectionView, 0, len(finalInputs))
	for _, input := range finalInputs {
		view, err := repo.Save(input)
		if err != nil {
			if rollbackErr := rollbackSnapshot.restore(a); rollbackErr != nil {
				return nil, errors.Join(err, fmt.Errorf("restore connection import rollback: %w", rollbackErr))
			}
			return nil, err
		}
		result = append(result, view)
	}
	return dedupeImportedSavedConnectionViews(result), nil
}

func (a *App) importConnectionPackagePayload(payload connectionPackagePayload) ([]connection.SavedConnectionView, error) {
	inputs := make([]connection.SavedConnectionInput, 0, len(payload.Connections))
	for _, item := range payload.Connections {
		inputs = append(inputs, newSavedConnectionInputFromPackageItem(item))
	}
	return a.importSavedConnectionsAtomically(inputs)
}

func connectionPackageImportResultFromViews(views []connection.SavedConnectionView, redisDbAliases map[string]map[string]string) ConnectionPackageImportResult {
	return ConnectionPackageImportResult{
		Connections:    sanitizeSavedConnectionViews(views),
		RedisDbAliases: sanitizeConnectionPackageRedisDbAliases(redisDbAliases),
	}
}

func (a *App) ImportConnectionsPayload(raw string, password string) (ConnectionPackageImportResult, error) {
	localizeError := func(err error) error {
		return localizeConnectionPackageError(a.appText, err)
	}
	mysqlWorkbenchError := func(key string, params map[string]any) error {
		return errors.New(a.appText(key, params))
	}

	empty := ConnectionPackageImportResult{}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return empty, localizeError(errConnectionPackageUnsupported)
	}
	if len(trimmed) > connectionImportMaxFileBytes {
		return empty, localizeError(errConnectionImportFileTooLarge)
	}

	if isConnectionPackageV2AppManaged(trimmed) {
		var file connectionPackageFileV2
		if err := json.Unmarshal([]byte(trimmed), &file); err != nil {
			return empty, localizeError(errConnectionPackageUnsupported)
		}
		payload, err := decryptConnectionPackageV2AppManaged(file)
		if err != nil {
			return empty, localizeError(err)
		}
		views, err := a.importConnectionPackagePayload(payload)
		if err != nil {
			return empty, localizeError(err)
		}
		return connectionPackageImportResultFromViews(views, collectRedisDbAliasesFromPackagePayload(payload)), nil
	}

	if isConnectionPackageV2Protected(trimmed) {
		var file connectionPackageFileV2Protected
		if err := json.Unmarshal([]byte(trimmed), &file); err != nil {
			return empty, localizeError(errConnectionPackageUnsupported)
		}
		payload, err := decryptConnectionPackageV2Protected(file, password)
		if err != nil {
			return empty, localizeError(err)
		}
		views, err := a.importConnectionPackagePayload(payload)
		if err != nil {
			return empty, localizeError(err)
		}
		return connectionPackageImportResultFromViews(views, collectRedisDbAliasesFromPackagePayload(payload)), nil
	}

	if isConnectionPackageEnvelope(trimmed) {
		var file connectionPackageFile
		if err := json.Unmarshal([]byte(trimmed), &file); err != nil {
			return empty, localizeError(errConnectionPackageUnsupported)
		}
		payload, err := decryptConnectionPackage(file, password)
		if err != nil {
			return empty, localizeError(err)
		}
		views, err := a.importConnectionPackagePayload(payload)
		if err != nil {
			return empty, localizeError(err)
		}
		return connectionPackageImportResultFromViews(views, collectRedisDbAliasesFromPackagePayload(payload)), nil
	}

	if isMySQLWorkbenchXML(trimmed) {
		inputs, err := parseMySQLWorkbenchXML(trimmed)
		if err != nil {
			return empty, mysqlWorkbenchError("file.backend.error.mysql_workbench_parse_failed", map[string]any{"detail": err.Error()})
		}
		if len(inputs) == 0 {
			return empty, mysqlWorkbenchError("file.backend.error.mysql_workbench_no_connections", nil)
		}
		views, err := a.importSavedConnectionsAtomically(inputs)
		if err != nil {
			return empty, err
		}
		return connectionPackageImportResultFromViews(views, nil), nil
	}

	if isNavicatNCX(trimmed) {
		inputs, err := parseNavicatNCXWithText(trimmed, a.appText)
		if err != nil {
			return empty, navicatWrapError(a.appText, "file.backend.error.navicat_ncx_parse_failed", nil, err)
		}
		if len(inputs) == 0 {
			return empty, navicatError(a.appText, "file.backend.error.navicat_ncx_no_connections", nil)
		}
		views, err := a.importSavedConnectionsAtomically(inputs)
		if err != nil {
			return empty, err
		}
		return connectionPackageImportResultFromViews(views, nil), nil
	}

	var legacy []connection.LegacySavedConnection
	if err := json.Unmarshal([]byte(trimmed), &legacy); err != nil {
		return empty, localizeError(errConnectionPackageUnsupported)
	}
	views, err := a.ImportLegacyConnections(legacy)
	if err != nil {
		return empty, err
	}
	return connectionPackageImportResultFromViews(views, nil), nil
}

type connectionPackageImportRollbackSnapshot struct {
	connectionsFileExists bool
	connectionsFileData   []byte
	connectionSecrets     map[string]securityUpdateSecretSnapshot
	connectionCleanupRefs []string
}

func captureConnectionImportRollbackSnapshot(a *App, inputs []connection.SavedConnectionInput) (connectionPackageImportRollbackSnapshot, error) {
	snapshot := connectionPackageImportRollbackSnapshot{
		connectionSecrets: make(map[string]securityUpdateSecretSnapshot),
	}

	repo := a.savedConnectionRepository()
	connectionFileData, connectionFileExists, err := readOptionalFile(repo.connectionsPath())
	if err != nil {
		return snapshot, err
	}
	snapshot.connectionsFileExists = connectionFileExists
	snapshot.connectionsFileData = connectionFileData

	existingConnections, err := repo.load()
	if err != nil {
		return snapshot, err
	}
	existingConnectionsByID := make(map[string]connection.SavedConnectionView, len(existingConnections))
	for _, item := range existingConnections {
		existingConnectionsByID[item.ID] = item
	}

	cleanupSet := make(map[string]struct{})
	seenIDs := make(map[string]struct{})
	for _, input := range inputs {
		connectionID := strings.TrimSpace(input.ID)
		if connectionID == "" {
			connectionID = strings.TrimSpace(input.Config.ID)
		}
		if connectionID == "" {
			continue
		}
		if _, alreadySeen := seenIDs[connectionID]; alreadySeen {
			continue
		}
		seenIDs[connectionID] = struct{}{}

		defaultRef, refErr := secretstore.BuildRef(savedConnectionSecretKind, connectionID)
		if refErr == nil {
			cleanupSet[defaultRef] = struct{}{}
		}

		existing, ok := existingConnectionsByID[connectionID]
		if !ok || !savedConnectionViewHasSecrets(existing) {
			continue
		}

		ref := strings.TrimSpace(existing.SecretRef)
		if ref == "" {
			ref = defaultRef
		}
		if ref == "" {
			continue
		}

		secretSnapshot, captureErr := captureSecurityUpdateSecretSnapshot(a.secretStore, ref)
		if captureErr != nil {
			return snapshot, captureErr
		}
		snapshot.connectionSecrets[ref] = secretSnapshot
		cleanupSet[ref] = struct{}{}
	}

	snapshot.connectionCleanupRefs = make([]string, 0, len(cleanupSet))
	for ref := range cleanupSet {
		snapshot.connectionCleanupRefs = append(snapshot.connectionCleanupRefs, ref)
	}
	return snapshot, nil
}

func (s connectionPackageImportRollbackSnapshot) restore(a *App) error {
	repo := a.savedConnectionRepository()
	if err := restoreOptionalFile(repo.connectionsPath(), s.connectionsFileExists, s.connectionsFileData); err != nil {
		return err
	}
	for ref, secretSnapshot := range s.connectionSecrets {
		if err := restoreSecurityUpdateSecretSnapshot(a.secretStore, ref, secretSnapshot); err != nil {
			return err
		}
	}
	for _, ref := range s.connectionCleanupRefs {
		if _, alreadyRestored := s.connectionSecrets[ref]; alreadyRestored {
			continue
		}
		if err := deleteSecurityUpdateSecretRef(a.secretStore, ref); err != nil {
			return err
		}
	}
	return nil
}

// --- MySQL Workbench XML import ---

func isMySQLWorkbenchXML(content string) bool {
	return strings.Contains(content, "<data") && strings.Contains(content, "grt_format") && strings.Contains(content, "db.mgmt.Connection")
}

// mysqlWorkbenchData is the root XML element.
type mysqlWorkbenchData struct {
	XMLName xml.Name               `xml:"data"`
	Value   mysqlWorkbenchTopValue `xml:"value"`
}

type mysqlWorkbenchTopValue struct {
	Values []mysqlWorkbenchConnection `xml:"value"`
}

type mysqlWorkbenchConnection struct {
	StructName string                    `xml:"struct-name,attr"`
	Values     []mysqlWorkbenchValue     `xml:"value"`
	Links      []mysqlWorkbenchLinkValue `xml:"link"`
}

type mysqlWorkbenchValue struct {
	Type       string                `xml:"type,attr"`
	Key        string                `xml:"key,attr"`
	StructName string                `xml:"struct-name,attr"`
	Content    string                `xml:",chardata"`
	Children   []mysqlWorkbenchValue `xml:"value"`
}

type mysqlWorkbenchLinkValue struct {
	Key     string `xml:"key,attr"`
	Content string `xml:",chardata"`
}

func parseMySQLWorkbenchXML(content string) ([]connection.SavedConnectionInput, error) {
	var data mysqlWorkbenchData
	if err := xml.Unmarshal([]byte(content), &data); err != nil {
		return nil, err
	}

	var inputs []connection.SavedConnectionInput
	for _, conn := range data.Value.Values {
		if conn.StructName != "db.mgmt.Connection" {
			continue
		}

		input := parseMySQLWorkbenchConnection(conn)
		inputs = append(inputs, input)
	}
	return inputs, nil
}

func parseMySQLWorkbenchConnection(conn mysqlWorkbenchConnection) connection.SavedConnectionInput {
	params := make(map[string]string)
	connName := ""
	driverKey := ""

	for _, v := range conn.Values {
		key := strings.TrimSpace(v.Key)
		switch {
		case key == "name" && v.Type == "string":
			connName = strings.TrimSpace(v.Content)
		case key == "parameterValues" && v.Type == "dict":
			for _, child := range v.Children {
				childKey := strings.TrimSpace(child.Key)
				if childKey == "" {
					continue
				}
				params[childKey] = strings.TrimSpace(child.Content)
			}
		}
	}

	for _, link := range conn.Links {
		if strings.TrimSpace(link.Key) == "driver" {
			driverKey = strings.TrimSpace(link.Content)
		}
	}

	host := params["hostName"]
	port := 3306
	if p, err := strconv.Atoi(params["port"]); err == nil && p > 0 {
		port = p
	}
	user := params["userName"]
	schema := params["schema"]
	password := params["password"]

	useSSL := false
	if v, err := strconv.Atoi(params["useSSL"]); err == nil && v > 0 {
		useSSL = true
	}

	dbType := "mysql"
	if strings.Contains(driverKey, "mariadb") {
		dbType = "mariadb"
	}

	connID := "conn-" + uuid.New().String()[:8]

	config := connection.ConnectionConfig{
		ID:       connID,
		Type:     dbType,
		Host:     host,
		Port:     port,
		User:     user,
		Password: password,
		Database: schema,
		UseSSL:   useSSL,
	}

	if connName == "" {
		connName = fmt.Sprintf("%s@%s:%d", user, host, port)
	}

	return connection.SavedConnectionInput{
		ID:     connID,
		Name:   connName,
		Config: config,
	}
}
