# Hive / HiveServer2

GoNavi 通过可选驱动代理连接 HiveServer2，使用独立 HiveQL 方言，不借用 MySQL 或 PostgreSQL 的事务、索引和分页规则。连接类型位于“大数据”分组；首次使用先在驱动管理中安装 Hive 驱动。

## 连接与驱动家族

| 设置 | 取值与用途 |
|---|---|
| 服务端家族 | Apache Hive、Spark SQL Thrift、Impala；按实际服务选择，不按 JDBC URL 名称猜测 |
| 协议档位 | 自动、Hive 1.x / HS2 V6、Hive 2.x / HS2 V8、Hive 3–4 / HS2 V10；档位与家族独立 |
| 传输 | Thrift binary，或原生 Thrift HTTP / HTTPS |
| 认证 | NONE、NOSASL、LDAP、CUSTOM、PAM、KERBEROS |
| 安全通道 | TLS、CA 与客户端证书、SSH、SOCKS / HTTP CONNECT 代理 |
| 连接地址 | 单个 HiveServer2 端点，或 Hive / Hive2 / JDBC Hive2 URL |

Apache Hive / Spark binary 默认端口为 10000，HTTP 为 10001，HTTP path 默认 `cliservice`；Impala binary 默认 21050、HTTP 默认 28000。网关、负载均衡器和自定义监听端口以服务端配置为准。

**NONE 与 NOSASL 不相同。** NONE 使用 SASL PLAIN；NOSASL 直接传输 Thrift。LDAP / CUSTOM / PAM 使用 PLAIN 凭据；通过 TLS 或 SSH 加密传输。HTTP Kerberos 使用单向、预先发送的 Negotiate/SPNEGO，binary Kerberos 使用带双向校验的 GSSAPI。HTTP 服务端身份由 TLS 校验；SASL QOP=auth 本身不加密查询与结果，生产连接应配置 TLS。连接失败不会自动降级认证或关闭证书校验。

高级选项保存在现有 ConnectionParams，密码仍使用现有凭据存储：

| 参数 | 说明 |
|---|---|
| `hiveFamily` | `hive` / `spark` / `impala` |
| `transportMode`、`httpPath` | `binary` / `http`，及 HTTP 服务路径 |
| `authMode` | 认证枚举；兼容输入的 `auth` 别名，保存时使用非秘密的 `authMode` |
| `principal`、`realm` | 服务端主体及客户端 realm；支持主体中的 `_HOST` |
| `keytab`、`credentialCache`、`krb5Config` | 客户端本地文件引用；keytab 与 FILE credential cache 二选一，也可用密码获取票据 |
| `fetchSize` | 每次 HS2 拉取 1–10000 行；不等于查询结果总行数 |
| `pollIntervalMs` | 状态轮询间隔 10–60000 毫秒 |
| `session.<name>` | 会话配置；批量导入使用独立会话，不污染查询编辑器 |

示例，不含密码：

```text
jdbc:hive2://warehouse.example:10000/default;auth=NONE
jdbc:hive2://warehouse.example:10001/default;transportMode=http;httpPath=cliservice;auth=LDAP;ssl=true
jdbc:hive2://warehouse.example:10000/default;principal=hive/_HOST@EXAMPLE.COM
```

当前连接器要求直连 HS2 端点；ZooKeeper 自动发现、SASL auth-int / auth-conf 和自动 initFile 脚本会明确报错，不会静默忽略。需要传输加密时使用 TLS。GoNavi 的 PHP SQL 脚本隧道不是 HS2 HTTP transport，不能互换。Kerberos KDC 连接使用本地 krb5.conf 指定的独立网络，不自动复用 HS2 的 SSH / 代理；KDC 不可直达时需另外配置通路。KDC I/O 使用上游库自身超时，不能承诺与 HS2 查询一样即时取消。

## 查询、浏览与元数据

- 浏览数据库、普通表和视图，读取 SHOW CREATE、列注释、分区列与表存储统计；表信息面板只读取目录统计，不自动执行全库 COUNT。
- 查询按 HS2 operation 生命周期执行，支持取消、超时、分批拉取和行预算。元数据与用户 SQL 使用隔离会话。
- 分页使用兼容 Hive 1.x 的窗口查询，不发送通用 OFFSET；后续页采用明确列投影，不把辅助行号带入结果或导出。需要稳定翻页时指定 ORDER BY。
- SQL 编辑器提供 Hive 类型、关键字和函数补全；EXPLAIN 保留 Hive stage、Spark physical plan、Impala 原生计划，不隐式运行 EXPLAIN ANALYZE。
- 原生 DDL / DML 通过 SQL 编辑器执行。通用结构设计器和网格编辑保持只读：Hive 的逻辑主键通常不强制唯一，不能据此保证单行编辑。无类型的“复制 INSERT”不生成猜测 SQL；使用带列类型信息的 SQL 导出。

## 导入、导出与同步

| 功能 | Hive 行为 |
|---|---|
| CSV / JSON / XLSX 导入 | 流式读取、列映射、类型验证、分区写入、进度、取消与错误处理；不把客户端路径当作 LOAD DATA LOCAL 的服务端路径 |
| SQL 文件与备份恢复 | 在固定会话中执行，保留 USE / SET 上下文；支持现有编码和 gzip；拒绝 Beeline 客户端命令、无法安全预检的服务端变量展开及不支持的事务控制 |
| CSV / JSON / XLSX / Markdown / HTML / Parquet 导出 | 复用现有导出格式与流式任务；复杂值采用可逆表示，Parquet 不宣称把字符串化 JSON 自动变成原生嵌套列 |
| SQL 查询、表和数据库备份 | 采用完整列类型与原始 DDL；保留复杂类型、分区定义和空分区；视图只导出定义，不写入视图数据 |
| 双向同步与结构迁移 | Hive 可作源或目标；支持表同步、SQL 查询源、追加、全量覆盖及条件满足时的增量 DML；预检目标表能力和跨库类型转换 |
| 自动建表 | Apache Hive 4 默认把普通 `CREATE TABLE` 转成 external 表，同步自动建表改用服务端支持的 `CREATE MANAGED TABLE`，使目标表可按普通表覆盖写入 |
| 覆盖写入边界 | 全量覆盖需要 managed 表或兼容的 ACID 表；外部表（含用户提供的 `LOCATION`）只支持追加，预检会说明原因，不会对外部数据目录做破坏性清空 |

普通表和 insert-only ACID 表支持追加写入；UPDATE / DELETE 要求已验证的完整 ACID 条件，Impala 的 Kudu 等存储另按家族能力判定。**ACID 表不意味着支持普通多语句 BEGIN / COMMIT / ROLLBACK。** 导入和同步按已完成的语句报告进度；部分提交或响应丢失时标记结果未知，禁止自动重放。

同步中的显式逻辑键不是数据库唯一约束。执行增量修改前检查源、目标的空键与重复键；类型、精度或存储能力不满足时在首次写入前失败。Spark 的时间精度、Impala 的复杂列写入限制不按 Apache Hive 的能力放行。

DECIMAL 保留精确十进制文本，BIGINT 避免经过浮点数，标量 BINARY 保留字节，常规 ARRAY / MAP / STRUCT / UNIONTYPE 使用类型构造器，MAP 的非字符串 primitive key 按完整源类型解析。**HiveServer2 的原生复杂值文本不能无损表达嵌套 BINARY**：真实 Hive 4 会把非法 UTF-8 字节替换成 U+FFFD，且不转义结构分隔符；连接器在读取前拒绝这种类型，不伪造原始字节。先通过源查询把二进制成员投影为 HEX / BASE64 标量，再导出或同步。跨库时间精度或复杂类型没有无损映射时，同样要求显式转换，不静默截断。

Hive CSV 使用未加引号的 NULL 标记表示 SQL NULL，并将非空值明确加引号；带引号的 "NULL"、空字符串、反斜杠均保留为原始文本。XLSX 使用缺失单元格表示 SQL NULL、明确的字符串单元格表示文本。Hive 配对导入、预览和断点恢复使用同一无损模式；其他数据源维持原行为。

SQL 备份恢复默认使用目标库的新存储路径。活动 DDL 去除源表与分区的 LOCATION，并标明该处理，避免恢复表指向源文件并覆盖原数据；只导出结构并不复制外部数据文件。

## 保护边界

只读和生产保护继续约束查询、结构、数据编辑及导入。受保护的 Hive SQL 另外拒绝 TRANSFORM / MAP / REDUCE USING、Java reflection 和服务端 变量替换；这些语法不能因为以 SELECT 开头就视为只读。任意自定义 UDF 的行为仍需要服务端授权控制。

URI、密码和敏感参数进入既有凭据存储；连接日志只记录端点摘要，不输出 JDBC 内嵌凭据。SQL 审计保留结构并脱敏字面量。

## 可复现验证

使用[独立容器配置](testdata/hive/compose.yaml)与[本地执行配置](testdata/hive/hive-site.xml)。配置固定 Hive 镜像摘要，只发布 loopback 端口，限制 2 CPU / 3 GiB 内存，使用独立卷和网络，不连接生产 metastore。

```powershell
docker compose -f testdata/hive/compose.yaml -p gonavi-hive-1584 up -d
$env:GONAVI_HIVE_LIVE_HOST = '127.0.0.1'
$env:GONAVI_HIVE_LIVE_PORT = '11084'
$env:GONAVI_HIVE_LIVE_USER = 'gonavi'
$env:GONAVI_HIVE_LIVE_PARAMS = 'authMode=NONE&fetchSize=1&pollIntervalMs=50'
$env:GONAVI_HIVE_LIVE_ACID = '1'
go test -p 1 -tags gonavi_hive_driver ./internal/db ./internal/app ./internal/sync -run 'TestHive.*Live' -count=1 -timeout=20m
```

真实服务测试默认跳过，只有设置 LIVE 环境变量才会创建独立的 `gonavi_*` 测试库。串行执行，避免多组本地 MapReduce 任务争抢容器内存。停止专用环境使用同一 Compose project；默认保留数据卷。

企业认证验证见[Kerberos / TLS 验证说明](testdata/hive/auth/README.md)。
