# 可筛选的数据源契约测试

此工具将现有分散在 internal/db 和 internal/app 的边界测试收敛为一个稳定 JSON 报告。它只编排已有的测试 seam；不修改数据源能力注册，也不连接或写入外部服务。

从仓库根目录执行：

~~~
go run ./tools/contract-test
go run ./tools/contract-test --data-source sqlite --capability cancel
go run ./tools/contract-test --source redis --capability cursor --containers
~~~

--data-source（也可使用 --source 或 --datasource）和 --capability 都可重复使用或接收逗号分隔值。每一个筛选组内按“任一匹配”选择，两个筛选组之间同时生效。例如，--source sqlite,redis --capability cancel,cursor 会选择 SQLite 取消/超时和 Redis 游标契约。

默认测试只使用下列本地 fixture：

| 数据源 | 能力 | fixture |
| --- | --- | --- |
| SQLite | 取消、超时 | 内存 SQLite；只执行读取查询 |
| Elasticsearch | 响应体上限 | httptest HTTP 服务 |
| Redis | 游标 | 进程内 cursor/state fixture |
| PostgreSQL 逻辑路径 | 取消、超时、权限 | 进程内 fake driver / HeadlessRuntime |
| OceanBase Oracle 逻辑路径 | 部分结果 | 进程内 metadata fixture |

--containers 会额外启动 fixtures/redis.compose.yml，使用 SCAN 0 COUNT 1 检查 Redis cursor 服务编排后立即清理。Docker、Docker Compose、Docker daemon 或镜像启动不可用时，JSON 会以 skipped 状态和固定 reason（如 docker_unavailable、docker_daemon_unavailable 或 container_start_failed）说明原因；加上 --strict-containers 可将此类跳过转为失败。

报告只包含排序后的矩阵元数据、状态与固定失败原因，不包含运行时长、临时目录或命令输出，因此同一结果的 stdout 可稳定供 CI 与诊断包解析。失败时可附加 --verbose 将原始子命令输出写到 stderr。
