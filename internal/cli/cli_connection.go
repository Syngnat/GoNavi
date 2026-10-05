package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
)

func runListConnections(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("list-connections")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeListConnectionsUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("list-connections does not accept positional arguments"))
	}
	connections, err := runtime.GetSavedConnections()
	if err != nil {
		return fail(stderr, ExitConnection, "connections_unavailable", err)
	}
	for _, item := range connections {
		if code := emitOutput(stdout, stderr, item); code != ExitSuccess {
			return code
		}
	}
	return ExitSuccess
}

func runConnection(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("connection requires a subcommand"))
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "list":
		return runListConnections(args[1:], runtime, stdout, stderr)
	case "add":
		return runConnectionAdd(args[1:], runtime, stdout, stderr)
	case "import":
		return runConnectionImport(args[1:], runtime, stdout, stderr)
	case "help", "--help", "-h":
		writeConnectionUsage(stdout)
		return ExitSuccess
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown connection command %q", args[0]))
	}
}

func runConnectionAdd(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("connection add")
	var (
		inputFile   string
		name        string
		id          string
		environment string
		dbType      string
		host        string
		port        int
		user        string
		database    string
		params      string
		paramsEnv   string
		passwordEnv string
		dsnEnv      string
		uriEnv      string
		readOnly    bool
	)
	fs.StringVar(&inputFile, "file", "", "JSON SavedConnectionInput file")
	fs.StringVar(&id, "id", "", "connection ID")
	fs.StringVar(&name, "name", "", "connection name")
	fs.StringVar(&environment, "environment", "", "connection environment")
	fs.StringVar(&dbType, "type", "", "database type")
	fs.StringVar(&host, "host", "", "database host")
	fs.IntVar(&port, "port", 0, "database port")
	fs.StringVar(&user, "user", "", "database user")
	fs.StringVar(&database, "database", "", "default database")
	fs.StringVar(&params, "connection-params", "", "connection parameters")
	fs.StringVar(&paramsEnv, "connection-params-env", "", "environment variable containing complete connection parameters")
	fs.StringVar(&passwordEnv, "password-env", "", "environment variable containing the password")
	fs.StringVar(&dsnEnv, "dsn-env", "", "environment variable containing the DSN")
	fs.StringVar(&uriEnv, "uri-env", "", "environment variable containing the URI")
	fs.BoolVar(&readOnly, "read-only", false, "save the connection as read-only")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeConnectionAddUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("connection add does not accept positional arguments"))
	}

	input := connection.SavedConnectionInput{}
	if strings.TrimSpace(inputFile) != "" {
		loaded, err := loadSingleConnectionInput(inputFile)
		if err != nil {
			return fail(stderr, ExitUsage, "invalid_connection_input", err)
		}
		input = loaded
	}
	visited := visitedFlags(fs)
	if visited["id"] {
		input.ID = strings.TrimSpace(id)
		input.Config.ID = input.ID
	}
	if visited["name"] {
		input.Name = strings.TrimSpace(name)
	}
	if visited["environment"] {
		input.EnvironmentType = strings.TrimSpace(environment)
	}
	if visited["type"] {
		input.Config.Type = strings.TrimSpace(dbType)
	}
	if visited["host"] {
		input.Config.Host = strings.TrimSpace(host)
	}
	if visited["port"] {
		input.Config.Port = port
	}
	if visited["user"] {
		input.Config.User = strings.TrimSpace(user)
	}
	if visited["database"] {
		input.Config.Database = strings.TrimSpace(database)
	}
	if visited["connection-params"] && visited["connection-params-env"] {
		return fail(stderr, ExitUsage, "usage", errors.New("use either --connection-params or --connection-params-env"))
	}
	if visited["connection-params"] {
		if appcore.HasSensitiveConnectionParams(params) {
			return fail(stderr, ExitUsage, "usage", errors.New("sensitive connection parameters must be supplied with --connection-params-env"))
		}
		input.Config.ConnectionParams = strings.TrimSpace(params)
	}
	if visited["connection-params-env"] {
		if err := assignConnectionEnvSecret(&input.Config.ConnectionParams, paramsEnv); err != nil {
			return fail(stderr, ExitUsage, "missing_secret_environment", err)
		}
	}
	if visited["read-only"] {
		input.Config.ReadOnly = readOnly
	}
	if err := assignConnectionEnvSecret(&input.Config.Password, passwordEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if err := assignConnectionEnvSecret(&input.Config.DSN, dsnEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if err := assignConnectionEnvSecret(&input.Config.URI, uriEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if strings.TrimSpace(input.Name) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection name is required"))
	}
	if strings.TrimSpace(input.Config.Type) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection type is required"))
	}

	saved, err := runtime.SaveConnection(input)
	if err != nil {
		return fail(stderr, ExitConnection, "connection_save_failed", err)
	}
	return emitOutput(stdout, stderr, saved)
}

func runConnectionImport(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("connection import")
	filePath := fs.String("file", "", "JSON file containing connection inputs")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeConnectionImportUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 || strings.TrimSpace(*filePath) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection import requires --file"))
	}
	inputs, err := loadConnectionInputs(*filePath)
	if err != nil {
		return fail(stderr, ExitUsage, "invalid_connection_input", err)
	}
	if len(inputs) == 0 {
		return fail(stderr, ExitUsage, "invalid_connection_input", errors.New("connection import file is empty"))
	}
	saved, err := runtime.ImportLegacyConnections(inputs)
	if err != nil {
		return fail(stderr, ExitConnection, "connection_import_failed", err)
	}
	for _, item := range saved {
		if code := emitOutput(stdout, stderr, item); code != ExitSuccess {
			return code
		}
	}
	return ExitSuccess
}

func resolveCommandConnection(runtime backend, selector string, filePath string) (connection.ConnectionConfig, error) {
	selector = strings.TrimSpace(selector)
	filePath = strings.TrimSpace(filePath)
	if selector != "" && filePath != "" {
		return connection.ConnectionConfig{}, errConnectionSourceConflict
	}
	if filePath != "" {
		return loadTemporaryConnectionConfig(filePath)
	}
	if selector == "" {
		return connection.ConnectionConfig{}, errConnectionSourceMissing
	}
	view, err := runtime.ResolveSavedConnection(selector)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	return view.Config, nil
}

func resolveSQLInput(sqlText string, sqlFile string, positional []string) (string, error) {
	provided := 0
	if strings.TrimSpace(sqlText) != "" {
		provided++
	}
	if strings.TrimSpace(sqlFile) != "" {
		provided++
	}
	if len(positional) > 0 {
		provided++
	}
	if provided != 1 {
		return "", errors.New("provide SQL with one of --sql, --sql-file, or a single positional argument")
	}
	if strings.TrimSpace(sqlText) != "" {
		return strings.TrimSpace(sqlText), nil
	}
	if strings.TrimSpace(sqlFile) != "" {
		return readSQLFile(sqlFile)
	}
	if len(positional) != 1 {
		return "", errors.New("SQL must be one positional argument")
	}
	return strings.TrimSpace(positional[0]), nil
}

func readSQLFile(filePath string) (string, error) {
	const maxSQLTextBytes = 64 << 20
	file, err := os.Open(strings.TrimSpace(filePath))
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := io.LimitReader(file, maxSQLTextBytes+1)
	contents, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	if len(contents) > maxSQLTextBytes {
		return "", fmt.Errorf("SQL text file exceeds %d bytes", maxSQLTextBytes)
	}
	text := strings.TrimSpace(string(contents))
	if text == "" {
		return "", errors.New("SQL text is empty")
	}
	return text, nil
}

func loadSingleConnectionInput(filePath string) (connection.SavedConnectionInput, error) {
	data, err := os.ReadFile(strings.TrimSpace(filePath))
	if err != nil {
		return connection.SavedConnectionInput{}, err
	}
	var input connection.SavedConnectionInput
	if err := json.Unmarshal(data, &input); err != nil {
		return connection.SavedConnectionInput{}, err
	}
	return input, nil
}

func loadConnectionInputs(filePath string) ([]connection.LegacySavedConnection, error) {
	data, err := os.ReadFile(strings.TrimSpace(filePath))
	if err != nil {
		return nil, err
	}
	var list []connection.LegacySavedConnection
	if err := json.Unmarshal(data, &list); err == nil {
		return list, nil
	}
	var wrapped struct {
		Connections []connection.LegacySavedConnection `json:"connections"`
	}
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Connections == nil {
		return nil, errors.New("expected a JSON array or an object with a connections array")
	}
	return wrapped.Connections, nil
}

func assignConnectionEnvSecret(target *string, envName string) error {
	envName = strings.TrimSpace(envName)
	if envName == "" {
		return nil
	}
	value, ok := os.LookupEnv(envName)
	if !ok {
		return fmt.Errorf("environment variable %s is not set", envName)
	}
	if target == nil {
		return errors.New("secret target is unavailable")
	}
	*target = value
	return nil
}
