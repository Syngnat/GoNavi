package connection

// MetadataDiscoveryScope restricts catalog discovery without changing query permissions or connection identity.
type MetadataDiscoveryScope struct {
	Schemas *MetadataSchemaScope `json:"schemas,omitempty"`
}

// MetadataSchemaScope selects or excludes schema identifiers within one database.
type MetadataSchemaScope struct {
	Mode          string   `json:"mode"`
	Names         []string `json:"names"`
	CaseSensitive bool     `json:"caseSensitive"`
}
