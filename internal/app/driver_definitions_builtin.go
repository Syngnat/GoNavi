package app

func builtInDriverDefinitions() []driverDefinition {
	return []driverDefinition{
		{Type: "mysql", Name: "MySQL", Engine: driverEngineGo, BuiltIn: true},
		{Type: "goldendb", Name: "GoldenDB", Engine: driverEngineGo, BuiltIn: true},
		{Type: "oracle", Name: "Oracle", Engine: driverEngineGo, BuiltIn: true},
		{Type: "redis", Name: "Redis", Engine: driverEngineGo, BuiltIn: true},
		{Type: "postgres", Name: "PostgreSQL", Engine: driverEngineGo, BuiltIn: true},
		{Type: "mqtt", Name: "MQTT", Engine: driverEngineGo, BuiltIn: true},
		{Type: "rabbitmq", Name: "RabbitMQ", Engine: driverEngineGo, BuiltIn: true},
	}
}
