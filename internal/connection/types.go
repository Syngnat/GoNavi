package connection

// SSHConfig holds SSH connection details
type SSHConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	KeyPath  string `json:"keyPath"`
}

// ConnectionConfig holds database connection details including SSH
type ConnectionConfig struct {
	Type     string    `json:"type"`
	Host     string    `json:"host"`
	Port     int       `json:"port"`
	User     string    `json:"user"`
	Password string    `json:"password"`
	Database string    `json:"database"`
	UseSSH   bool      `json:"useSSH"`
	SSH      SSHConfig `json:"ssh"`
	Driver   string    `json:"driver,omitempty"` // For custom connection
	DSN      string    `json:"dsn,omitempty"`    // For custom connection
}

// QueryResult is the standard response format for Wails methods
type QueryResult struct {
	Success bool        `json:"success"`
	Message string      `json:"message"`
	Data    interface{} `json:"data"`
	Fields  []string    `json:"fields,omitempty"`
}

// ColumnDefinition represents a table column
type ColumnDefinition struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable string  `json:"nullable"` // YES/NO
	Key      string  `json:"key"`      // PRI, UNI, MUL
	Default  *string `json:"default"`
	Extra    string  `json:"extra"` // auto_increment
	Comment  string  `json:"comment"`
}

// IndexDefinition represents a table index
type IndexDefinition struct {
	Name       string `json:"name"`
	ColumnName string `json:"columnName"`
	NonUnique  int    `json:"nonUnique"`
	SeqInIndex int    `json:"seqInIndex"`
	IndexType  string `json:"indexType"`
}

// ForeignKeyDefinition represents a foreign key
type ForeignKeyDefinition struct {
	Name           string `json:"name"`
	ColumnName     string `json:"columnName"`
	RefTableName   string `json:"refTableName"`
	RefColumnName  string `json:"refColumnName"`
	ConstraintName string `json:"constraintName"`
}

// TriggerDefinition represents a trigger
type TriggerDefinition struct {
	Name      string `json:"name"`
	Timing    string `json:"timing"` // BEFORE/AFTER
	Event     string `json:"event"`  // INSERT/UPDATE/DELETE
	Statement string `json:"statement"`
}

// ColumnDefinitionWithTable represents a column with its table name (for search/autocomplete)
type ColumnDefinitionWithTable struct {
	TableName string `json:"tableName"`
	Name      string `json:"name"`
	Type      string `json:"type"`
}

// UpdateRow represents a row update with keys (WHERE) and values (SET)
type UpdateRow struct {
	Keys   map[string]interface{} `json:"keys"`
	Values map[string]interface{} `json:"values"`
}

// ChangeSet represents a batch of changes
type ChangeSet struct {
	Inserts []map[string]interface{} `json:"inserts"`
	Updates []UpdateRow              `json:"updates"`
	Deletes []map[string]interface{} `json:"deletes"`
}
