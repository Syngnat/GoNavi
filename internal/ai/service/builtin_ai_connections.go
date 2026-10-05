package aiservice

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// builtinAIConnection is a saved connection as get_connections describes it (never with secrets).
type builtinAIConnection struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

func (s *Service) builtinAIConnections(ctx context.Context) []builtinAIConnection {
	if s == nil || s.agentToolCatalog == nil {
		return nil
	}
	connections, _ := s.builtinAILookup("connections", func() (any, bool) {
		var listed struct {
			Connections []builtinAIConnection `json:"connections"`
		}
		ok := callBuiltinAITool(ctx, s.agentToolCatalog, "get_connections", map[string]string{}, &listed)
		return listed.Connections, ok
	}).([]builtinAIConnection)
	return connections
}

func (s *Service) builtinAIDatabases(ctx context.Context, connectionID string) []string {
	if s == nil || connectionID == "" || s.agentToolCatalog == nil {
		return nil
	}
	databases, _ := s.builtinAILookup("databases\x00"+connectionID, func() (any, bool) {
		var listed struct {
			Databases []string `json:"databases"`
		}
		ok := callBuiltinAITool(ctx, s.agentToolCatalog, "get_databases", map[string]string{"connectionId": connectionID}, &listed)
		return listed.Databases, ok
	}).([]string)
	return databases
}

// mentionedBuiltinAIConnection is the saved connection the person names in their message ("show
// me some data from kingbase"): exactly one whose name appears in it, or failing that the only
// connection of the one type it mentions. A message that also mentions another kind of database
// ("compare mysql and kingbase") names none: anything less certain is no answer.
func mentionedBuiltinAIConnection(connections []builtinAIConnection, text string) (builtinAIConnection, bool) {
	lower := strings.ToLower(text)
	var byName, byType []builtinAIConnection
	types := map[string]bool{}
	for _, connection := range connections {
		if name := strings.ToLower(strings.TrimSpace(connection.Name)); utf8.RuneCountInString(name) >= 2 && strings.Contains(lower, name) {
			byName = append(byName, connection)
		}
		if kind := strings.ToLower(strings.TrimSpace(connection.Type)); len(kind) >= 4 && strings.Contains(lower, kind) {
			byType = append(byType, connection)
			types[kind] = true
		}
	}
	switch {
	case len(byName) == 1:
		chosen := byName[0]
		for kind := range types {
			if kind != strings.ToLower(strings.TrimSpace(chosen.Type)) {
				return builtinAIConnection{}, false
			}
		}
		return chosen, true
	case len(byName) == 0 && len(types) == 1 && len(byType) == 1:
		return byType[0], true
	}
	return builtinAIConnection{}, false
}

// builtinAIScanDatabases bounds how many of a connection's databases are looked into, and
// builtinAIScanTimeout how long that may take in all, when the person names a connection but
// selects no database. One at a time: each lookup opens its own connection, and an SSH server
// refused three of four tunnels opened at once.
const (
	builtinAIScanDatabases = 6
	builtinAIScanTimeout   = 20 * time.Second
)

// builtinAIContextFor completes the turn's target and returns the lines the model reads about the
// database. With a database selected: its table names. With none: the saved connections and, when
// the message names one of them, that connection's databases. The named connection becomes the
// target, and so does the first of its databases found to hold tables of its own (system ones left
// out), looking first where the person has tabs open and last at the databases the server was
// installed with: "show me some data from kingbase" then works without the model having to find
// the database that has any.
func (s *Service) builtinAIContextFor(ctx context.Context, target builtinAITarget, question string) (builtinAITarget, []string) {
	connections := s.builtinAIConnections(ctx)
	if len(connections) > 0 {
		target.known = make(map[string]bool, len(connections))
		for _, connection := range connections {
			target.known[connection.ID] = true
		}
	}
	if target.connectionID != "" {
		tables := builtinAIUserTables(s.builtinAITables(ctx, target))
		return target, nonEmpty(builtinAITablesLine("Tables in this database", tables, target.schemaName))
	}

	var lines []string
	if len(connections) > 0 {
		described := make([]string, 0, len(connections))
		for _, connection := range connections {
			described = append(described, fmt.Sprintf("%s (%s, id %s)", connection.Name, connection.Type, connection.ID))
		}
		line, shown := builtinAIListLine("No connection is selected. Saved connections: ", described)
		if more := len(described) - shown; more > 0 {
			line += fmt.Sprintf(", and %d more", more)
		}
		lines = append(lines, line)
	}
	connection, ok := mentionedBuiltinAIConnection(connections, question)
	if !ok {
		return target, lines
	}
	target.connectionID = connection.ID
	about := fmt.Sprintf("The user means the connection %s (%s). Connection id (for tools): %s", connection.Name, connection.Type, connection.ID)
	databases := s.builtinAIDatabases(ctx, connection.ID)
	if len(databases) > 0 {
		listed, shown := builtinAIListLine(". Databases: ", databases)
		about += listed
		if more := len(databases) - shown; more > 0 {
			about += fmt.Sprintf(", and %d more", more)
		}
	}
	lines = append(lines, about)

	scan, cancel := context.WithTimeout(ctx, builtinAIScanTimeout)
	defer cancel()
	for _, database := range builtinAIScanOrder(databases, target.opened[connection.ID]) {
		if scan.Err() != nil {
			break
		}
		if own := builtinAIOwnTables(s.builtinAITables(scan, builtinAITarget{connectionID: connection.ID, dbName: database})); len(own) > 0 {
			target.dbName = database
			return target, append(lines, fmt.Sprintf("Database %s holds tables of its own; use it (dbName %s).", database, database),
				builtinAITablesLine("Tables in "+database, own, ""))
		}
	}
	// Nothing found in time. Never the system tables: offered those, the model picked one it may not
	// read. Without a list of databases, the default one is all there is to look at.
	if len(databases) > 0 {
		return target, append(lines, "To see the tables, call get_tables with one of these databases as dbName.")
	}
	if tables := builtinAITablesLine("Tables in its default database", builtinAIOwnTables(s.builtinAITables(ctx, target)), ""); tables != "" {
		lines = append(lines, tables)
	}
	return target, lines
}

// builtinAIScanOrder is the order a connection's databases are looked into: those the person has
// tabs open on, then the others, then the ones the server was installed with; never the server's
// own, and at most builtinAIScanDatabases.
func builtinAIScanOrder(databases, opened []string) []string {
	available := make(map[string]bool, len(databases))
	for _, database := range databases {
		available[database] = !builtinAISystemDatabase(database)
	}
	var order []string
	add := func(database string) {
		if available[database] && len(order) < builtinAIScanDatabases {
			order = append(order, database)
			available[database] = false
		}
	}
	for _, database := range opened {
		add(database)
	}
	for _, database := range databases {
		if !builtinAIStockDatabase(database) {
			add(database)
		}
	}
	for _, database := range databases {
		add(database)
	}
	return order
}

func nonEmpty(line string) []string {
	if line == "" {
		return nil
	}
	return []string{line}
}
