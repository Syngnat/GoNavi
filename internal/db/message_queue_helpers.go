package db

// Kafka 与 RocketMQ 驱动代理共用的小工具；两者各自带构建标签，公共部分放在无标签文件里。

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
