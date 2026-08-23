# ConnectionConfig / SavedConnectionInput JSON reference

The GoNavi CLI accepts two connection JSON shapes. Exact field names matter:
JSON decoding rejects unknown fields (`DisallowUnknownFields`).

## ConnectionConfig — `--connection-file`

A raw, transient connection configuration. Rules enforced by the CLI:

- `type` is required; `id` must be absent (the CLI forces it empty).
- The file must be a regular file (not a symlink), at most 1 MiB, with
  restrictive permissions where the platform enforces them.
- The config is never saved and `savePassword` is forced to false.
- `password` may appear in the file (kept out of argv), but the file is
  transient — delete it after use.

```json
{
  "type": "mysql",
  "host": "db.internal",
  "port": 3306,
  "user": "app",
  "password": "s3cret",
  "database": "orders",
  "readOnly": true,
  "queryTimeout": 30,
  "timeout": 15
}
```

### Common fields

| Field | Type | Meaning |
|-------|------|---------|
| `type` | string | required driver identifier (see SKILL.md "Data source types") |
| `host`, `port`, `user`, `password` | string/int/string/string | endpoint + auth |
| `database` | string | default database/schema |
| `readOnly` | bool | reject all writes, even with `--allow-write` |
| `protection` | object | fine-grained guards: `restrictDataEdit`, `restrictStructureEdit`, `restrictScriptExecution`, `restrictDataImport` (all bool) |
| `driver`, `dsn` | string | custom connections |
| `connectionParams` | string | extra URI query parameters for built-in drivers |
| `timeout` | int | connection timeout in seconds (default 30) |
| `queryTimeout` | int | per-query timeout in seconds; 0 disables the automatic deadline |
| `useSSL`, `sslMode` | bool/string | SSL switch + mode (`preferred`, `required`, `skip-verify`, `disable`) |
| `sslCAPath`, `sslCertPath`, `sslKeyPath` | string | TLS trust/client material |
| `useSSH`, `ssh` | bool/object | SSH tunnel: `{host, port, user, password, keyPath, knownHostsPath, hostKeyFingerprint}` |
| `useProxy`, `proxy` | bool/object | proxy: `{type: "socks5"|"http", host, port, user, password}` |
| `useHttpTunnel`, `httpTunnel` | bool/object | HTTP CONNECT tunnel `{host, port, user, password}` |
| `uri` | string | connection URI for copy/paste |
| `keepAliveEnabled`, `keepAliveIntervalMinutes`, `keepAliveSQL` | bool/int/string | background keep-alive |
| `redisDB`, `redisSentinelMaster`, `redisSentinelUser`, `redisSentinelPassword` | int/string | Redis specifics |
| `hosts`, `topology` | []string/string | multi-host addresses `host:port` and topology (`single`, `replica`, `cluster`, `sentinel`) |
| `mysqlReplicaUser`, `mysqlReplicaPassword` | string | MySQL replica auth |
| `replicaSet`, `authSource`, `readPreference`, `mongoSrv`, `mongoAuthMechanism`, `mongoReplicaUser`, `mongoReplicaPassword` | — | MongoDB specifics |
| `clickHouseProtocol` | string | `auto`, `http`, `native` |
| `oceanBaseProtocol` | string | `mysql`, `oracle` |
| `jvm` | object | JVM connector config (jmx/endpoint/agent/diagnostic) |

## SavedConnectionInput — `connection add --file` / `connection import`

The input to saving a connection: metadata plus the embedded `config`
(a `ConnectionConfig`), and optional include/exclude rules.

```json
{
  "name": "analytics",
  "environmentType": "prod",
  "config": {
    "type": "postgres",
    "host": "pg.internal",
    "port": 5432,
    "user": "etl",
    "database": "warehouse",
    "readOnly": true
  },
  "includeDatabases": ["warehouse", "reporting"],
  "excludeDatabasePatterns": ["temp_*"]
}
```

### Fields

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | optional; omitted → generated |
| `name` | string | required |
| `environmentType` | string | environment label |
| `config` | object | required `ConnectionConfig` |
| `includeDatabases`, `includeDatabasePatterns`, `excludeDatabasePatterns` | []string | schema/database visibility |
| `includeRedisDatabases` | []int | Redis database indexes |
| `schemaVisibilityByDatabase` | map | per-database `{mode: "include"|"exclude", schemas: [...]}` |
| `iconType`, `iconColor` | string | UI icon |
| `clearPrimaryPassword`, `clearSSHPassword`, `clearProxyPassword`, `clearHttpTunnelPassword`, `clearMySQLReplicaPassword`, `clearMongoReplicaPassword`, `clearRedisSentinelPassword`, `clearOpaqueURI`, `clearOpaqueDSN`, `clearJVMJMXPassword`, `clearJVMEndpointAPIKey`, `clearJVMAgentAPIKey`, `clearJVMDiagnosticAPIKey`, `clearSensitiveConnectionParams` | bool | request removal of stored secrets on update |

`connection import` accepts an array of these objects, or
`{"connections": [...]}`.

## SavedConnectionView — output shape

`list-connections`, `connection add`, and `connection import` emit this as
JSON (one per line). It mirrors `SavedConnectionInput` plus:

- `secretRef` — reference to the stored secret bundle
- `hasPrimaryPassword`, `hasSSHPassword`, `hasProxyPassword`,
  `hasHttpTunnelPassword`, `hasMySQLReplicaPassword`,
  `hasMongoReplicaPassword`, `hasRedisSentinelPassword`, `hasOpaqueURI`,
  `hasOpaqueDSN`, `hasJVMJMXPassword`, `hasJVMEndpointAPIKey`,
  `hasJVMAgentAPIKey`, `hasJVMDiagnosticAPIKey`,
  `hasSensitiveConnectionParams` — which secrets exist (values are never
  printed; treat the `config` fields as possibly empty)
