package db

// Kafka、RocketMQ 与 Pulsar 的客户端库体积大（Pulsar 连带引入 k8s/athenz/prometheus），
// 改为按需下载的驱动代理，注册见 database_optional_factories_*.go。
func registerMessageDatabaseFactories() {
	registerDatabaseFactory(func() Database { return &MQTTDB{} }, "mqtt")
	registerDatabaseFactory(func() Database { return &RabbitMQDB{} }, "rabbitmq")
}
