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
	Type                 string    `json:"type"`
	Host                 string    `json:"host"`
	Port                 int       `json:"port"`
	User                 string    `json:"user"`
	Password             string    `json:"password"`
	SavePassword         bool      `json:"savePassword,omitempty"` // Persist password in saved connection
	Database             string    `json:"database"`
	UseSSH               bool      `json:"useSSH"`
	SSH                  SSHConfig `json:"ssh"`
	Driver               string    `json:"driver,omitempty"`               // For custom connection
	DSN                  string    `json:"dsn,omitempty"`                  // For custom connection
	Timeout              int       `json:"timeout,omitempty"`              // Connection timeout in seconds (default: 30)
	RedisDB              int       `json:"redisDB,omitempty"`              // Redis database index (0-15)
	URI                  string    `json:"uri,omitempty"`                  // Connection URI for copy/paste
	Hosts                []string  `json:"hosts,omitempty"`                // Multi-host addresses: host:port
	Topology             string    `json:"topology,omitempty"`             // single | replica
	MySQLReplicaUser     string    `json:"mysqlReplicaUser,omitempty"`     // MySQL replica auth user
	MySQLReplicaPassword string    `json:"mysqlReplicaPassword,omitempty"` // MySQL replica auth password
	ReplicaSet           string    `json:"replicaSet,omitempty"`           // MongoDB replica set name
	AuthSource           string    `json:"authSource,omitempty"`           // MongoDB authSource
	ReadPreference       string    `json:"readPreference,omitempty"`       // MongoDB readPreference
	MongoSRV             bool      `json:"mongoSrv,omitempty"`             // MongoDB use mongodb+srv URI scheme
	MongoAuthMechanism   string    `json:"mongoAuthMechanism,omitempty"`   // MongoDB authMechanism
	MongoReplicaUser     string    `json:"mongoReplicaUser,omitempty"`     // MongoDB replica auth user
	MongoReplicaPassword string    `json:"mongoReplicaPassword,omitempty"` // MongoDB replica auth password
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

type MongoMemberInfo struct {
	Host      string `json:"host"`
	Role      string `json:"role"`
	State     string `json:"state"`
	StateCode int    `json:"stateCode,omitempty"`
	Healthy   bool   `json:"healthy"`
	IsSelf    bool   `json:"isSelf,omitempty"`
}
