---
name: gonavi-cli
description: Operate databases through the GoNavi headless CLI — the `gonavi` executable shipped in verified GitHub Release archives. Covers listing/adding/importing saved connections, running SQL queries against saved connections or ad-hoc connection files, exporting result sets to csv/json/md/html/xlsx, batch-executing SQL files with transaction control, exporting the SQL audit log, and launching the MCP server (stdio/http/remote-config). Use whenever the user mentions GoNavi, the gonavi CLI, running SQL from the terminal, exporting database query results, executing SQL files, managing saved database connections without the GUI, or the GoNavi MCP server — even if they don't name the tool explicitly.
---

# GoNavi CLI

The GoNavi CLI is a standalone, headless binary for the GoNavi database client
(Wails app). It queries and manages saved connections without the GUI and is
built for scripting and AI agents: stdout carries machine-readable data
(JSON/JSONL/CSV/Markdown), stderr carries JSON error reports, and every
invocation exits with a stable exit code.

## Install

Download the matching `gonavi-cli_${VERSION}_${goos}_${arch}` archive and
`gonavi-cli_${VERSION}_checksums.txt` file from a GoNavi GitHub Release, verify
the SHA256 checksum, extract the archive, then run:

```bash
gonavi version                         # -> {"version":"0.9.3"}
```

- The CLI is currently distributed through verified GitHub Release archives,
  not npm.
- `GONAVI_CLI_RELEASE_BASE_URL` may point at a mirror that preserves the same
  release asset names and checksum file. Release assets are named
  `gonavi-cli_${VERSION}_${goos}_${arch}.tar.gz` (darwin/linux) or `.zip`
  (win32), plus `gonavi-cli_${VERSION}_checksums.txt`.

## Data root and environment

- Saved connections and the SQL audit log live under the GoNavi data root:
  `GONAVI_DATA_ROOT` if set, otherwise `~/.gonavi`.
- `--data-root PATH` (before the command) overrides it for one invocation:
  `gonavi --data-root /srv/gonavi-data list-connections`.
- Never put secrets in argv — they show up in process listings. Pass them via
  environment variables (see Connection management) or a connection file.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 2    | Usage error (bad flags, missing args, invalid format) |
| 3    | Connection error (not found, ambiguous, save/import failed, invalid file) |
| 4    | Policy denied (write attempted without `--allow-write`, or read-only connection) |
| 5    | Execution failure (SQL error, output failure, invalid result shape) |
| 6    | Cancelled (interrupt, timeout, explicit cancellation) |
| 7    | Outcome unknown (execution result could not be determined) |

## Error contract

On failure the CLI writes one JSON object to stderr and exits nonzero:

```json
{"ok": false, "code": "policy_denied", "message": "..."}
```

Common `code` values: `usage`, `runtime_unavailable`, `connections_unavailable`,
`connection_save_failed`, `connection_import_failed`, `connection_failed`,
`connection_not_found`, `connection_ambiguous`, `connection_file_invalid`,
`invalid_connection_input`, `missing_secret_environment`, `sql_file_unavailable`,
`policy_denied`, `execution_failed`, `invalid_result`, `unsupported_result_shape`,
`cancelled`, `outcome_unknown`, `output_failed`, `mcp_failed`.

Error messages are redacted before they are printed, so they are safe to log.

## Command reference

```
gonavi [--data-root PATH] list-connections
gonavi [--data-root PATH] connection <list|add|import>
gonavi [--data-root PATH] query (--conn ID_OR_NAME|--connection-file FILE) [--sql SQL|--sql-file FILE|SQL]
gonavi [--data-root PATH] export (--conn ID_OR_NAME|--connection-file FILE) --output FILE [--sql SQL|--sql-file FILE|SQL]
gonavi [--data-root PATH] batch (--conn ID_OR_NAME|--connection-file FILE) --file FILE --allow-write
gonavi [--data-root PATH] audit export --output FILE
gonavi [--data-root PATH] mcp <stdio|http|remote-config>
```

Every command supports `--help`. `connection help` and `audit help` also work.
Help and `version` never start the database runtime.

### version

`gonavi version` (or `--version` / `-version`) prints `{"version":"..."}`.
It accepts no arguments.

### list-connections / connection list

`gonavi list-connections` (alias `connections`, or `connection list`) prints
one JSON object per line — each a `SavedConnectionView` (id, name,
environmentType, config, secret flags like `hasPrimaryPassword`, ...).

Use this to discover the `--conn` selector for a later query:

```bash
gonavi list-connections | jq -r '.name + "\t" + .config.type + "\t" + (.config.host // "")'
```

### connection add

`gonavi connection add` saves a connection. Flags:

| Flag | Meaning |
|------|---------|
| `--file FILE` | JSON `SavedConnectionInput` file (base for the input) |
| `--name NAME` | required |
| `--type TYPE` | required; driver identifier (see Data source types) |
| `--id ID` | explicit connection ID |
| `--environment ENV` | environment label |
| `--host`, `--port`, `--user`, `--database` | endpoint fields |
| `--connection-params PARAMS` | extra connection parameters (rejected if sensitive — use `--connection-params-env`) |
| `--connection-params-env VAR` | env var holding complete connection parameters |
| `--password-env VAR` | env var holding the password |
| `--dsn-env VAR` | env var holding a DSN (custom connections) |
| `--uri-env VAR` | env var holding a connection URI |
| `--read-only` | mark the connection read-only |

`--connection-params` and `--connection-params-env` are mutually exclusive.
On success the saved `SavedConnectionView` is printed as JSON on stdout.

```bash
export GONAVI_DB_PW='s3cret'
gonavi connection add --name analytics --type postgres \
  --host pg.internal --port 5432 --user etl --database warehouse \
  --password-env GONAVI_DB_PW --read-only
```

### connection import

`gonavi connection import --file FILE` bulk-imports saved connections. The
file is a JSON array of `SavedConnectionInput`, or an object with a
`connections` array. Each imported connection is printed as JSON on its own
line.

### query

```bash
gonavi query --conn mydb "SELECT id, name FROM users LIMIT 10"
gonavi query --conn mydb --format md "SELECT * FROM orders WHERE status = 'open'"
gonavi query --conn mydb --sql-file query.sql --format json
gonavi query --connection-file /tmp/conn.json --database app "SELECT count(*) FROM events"
```

Flags: `--conn ID_OR_NAME` or `--connection-file FILE` (exactly one),
`--database DB` (database/schema override), `--sql SQL` / `--sql-file FILE` /
one positional SQL argument (exactly one), `--format jsonl|json|csv|md|markdown`
(default `jsonl`), `--allow-write` (aliases: deprecated `--allow-mutating`),
`--query-timeout SECONDS`.

`--format` behavior:
- `jsonl` (default): one JSON object per line — `result_set` events
  `{"type":"result_set","resultSet":N,"columns":[...],"rowCount":N}`, `row`
  events `{"type":"row","resultSet":N,"data":{col:value}}`, then a `summary`
  event `{"type":"summary","success":true,"queryId":"...","resultSets":N,"rows":N}`.
  Non-tabular statements (e.g. `UPDATE`) produce a single `summary` whose
  `data` carries metadata like `{"affectedRows":3}`.
- `json`: a single `QueryResult` envelope
  `{"success":true,"message":"","data":[...],"fields":[...],"messages":[...],"queryId":"...","transactionId":"...","transactionPending":false}`.
- `csv` / `md`: header + rows; require exactly one result set (multi-result-set
  queries fail with `unsupported_result_shape`). Markdown escapes `|` in cell
  values and renders newlines as `<br>`.

Mutating SQL (`INSERT`/`UPDATE`/`DELETE`/DDL) without `--allow-write` is
rejected with exit 4 (`policy_denied`) — even on a writable connection.
Read-only connections reject writes regardless of `--allow-write`.

### export

```bash
gonavi export --conn mydb --sql "SELECT * FROM orders" --output orders.csv
gonavi export --conn mydb --sql-file q.sql --output report.xlsx --format xlsx
gonavi export --conn mydb "SELECT a, b FROM t" --output out.md --force
```

Flags: connection selection as in `query`, `--output FILE` (required),
`--format csv|json|md|html|xlsx` (defaults to the output file extension),
`--columns a,b,c` (projection), `--xlsx-max-rows-per-sheet N`,
`--force` (overwrite an existing file), `--query-timeout SECONDS`.

On success prints the sanitized `QueryResult` JSON to stdout.

### batch / exec-file

```bash
gonavi batch --conn mydb --file migrate.sql --allow-write
gonavi batch --conn mydb --file seeds.sql.gz --allow-write --transaction off --continue-on-error
```

Executes a SQL file (plain or `.gz`). Flags: connection selection as in
`query`, `--file FILE` (or alias `--sql-file FILE`), `--allow-write`
(required — batch is refused with exit 4 otherwise), `--transaction single|off`
(default `single`; wraps the file in one transaction),
`--stop-on-error` (default) / `--continue-on-error`
(requires `--transaction off`), `--job-id ID` (durable job id),
`--max-statement-bytes N`. On success prints the sanitized `QueryResult` JSON.

### audit export

```bash
gonavi audit export --output audit.json
gonavi audit export --output audit.csv --from 2026-08-01T00:00:00Z --to 2026-08-13T23:59:59Z
```

Exports the SQL audit log. Flags: `--output FILE` (required), `--format json|csv`
(default `json`), `--force`, and filters `--connection-id`, `--database`,
`--db-type`, `--status`, `--source`, `--search`, `--from`, `--to`
(RFC3339 or Unix milliseconds).

### mcp

`gonavi mcp stdio` runs the MCP server over stdio; `gonavi mcp http` runs the
Streamable HTTP server (see `gonavi mcp --help` for its options);
`gonavi mcp remote-config` writes a remote MCP client config to stdout.

## Connection selection

Two mutually exclusive ways to pick the target database:

- `--conn ID_OR_NAME` — resolve a saved connection by ID or exact name.
  Ambiguous names fail with `connection_ambiguous` (exit 3); unknown names with
  `connection_not_found`. List candidates with `list-connections` first.
- `--connection-file FILE` — a raw `ConnectionConfig` JSON file (see
  `references/connection-config.md`). The config is transient: it is never
  saved, must not contain `id`, and `type` is required. The file must be a
  regular file (not a symlink), at most 1 MiB, with unknown JSON fields
  rejected. Use this when the target database is not saved, or when you want
  credentials to live in a file rather than in a saved repository.
  Delete the file after use.

## Data source types

`--type` accepts the normalized driver identifier; several friendly names are
aliases (e.g. `postgresql` → `postgres`, `doris` → `diros`, `kingbase8` →
`kingbase`, `intersystems` → `iris`, `elastic` → `elasticsearch`,
`chromadb` → `chroma`, `rocket-mq` → `rocketmq`).

Built-in (always available): `mysql`, `goldendb`, `postgres`, `oracle`,
`redis`, `chroma`, `qdrant`, `milvus`, `rocketmq`, `mqtt`, `kafka`, `rabbitmq`.

Optional (must be installed via the GUI Driver Manager or an agent):
`mariadb`, `oceanbase`, `diros` (Doris), `starrocks`, `sphinx`, `sqlserver`,
`sqlite`, `duckdb`, `dameng`, `kingbase`, `highgo`, `vastbase`, `opengauss`,
`gaussdb`, `iris`, `mongodb`, `tdengine`, `iotdb`, `clickhouse`,
`elasticsearch`, `trino`, plus custom `driver`/`dsn` connections.

## Workflows

1. Discover what is available:
   `gonavi list-connections` → pick `name` (or `id`).
2. Inspect data read-only (default): `query --format md` for a human-readable
   table, `--format jsonl` when streaming, `--format csv` for a file.
3. Write safely: always pass `--allow-write` explicitly, prefer
   `--transaction` control for multi-statement files, and double-check
   `readOnly` on the target connection.
4. Ad-hoc database without saving anything: write a connection file
   (permissions 0600), run `query`/`export`/`batch` with `--connection-file`,
   then remove the file.
5. Secrets: pass env var names (`--password-env`, `--dsn-env`, `--uri-env`,
   `--connection-params-env`), never literal values on the command line.

For the exact JSON shapes of `ConnectionConfig` and `SavedConnectionInput`,
read `references/connection-config.md`.
