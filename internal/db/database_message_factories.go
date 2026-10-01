package db

func registerMessageDatabaseFactories() {
	registerDatabaseFactory(func() Database { return &RocketMQDB{} }, "rocketmq")
	registerDatabaseFactory(func() Database { return &MQTTDB{} }, "mqtt")
	registerDatabaseFactory(func() Database { return &KafkaDB{} }, "kafka")
	registerDatabaseFactory(func() Database { return &RabbitMQDB{} }, "rabbitmq")
	registerDatabaseFactory(func() Database { return &PulsarDB{} }, "pulsar")
}
