<p align="center">
  <img src="https://origin-download.syngnat.top:8443/gonavi/brand-assets/v1/03-ribbon-graphite-glow.svg" width="128" alt="GoNavi Logo" />
</p>

<h1 align="center">GoNavi</h1>

<p align="center">
  <b>Navigate every data source — native speed, agent-ready, zero Electron bloat.</b>
</p>

<p align="center">
  A high-performance cross-platform database client built with
  <a href="https://wails.io">Wails</a> (Go) + <a href="https://react.dev">React</a>.
  Desktop-first. MCP-ready. ~20–26MB class installers.
</p>

<p align="center">
  <a href="https://github.com/Syngnat/GoNavi/releases"><img src="https://img.shields.io/github/v/release/Syngnat/GoNavi?style=for-the-badge&color=8B5CF6" alt="Release" /></a>
  <a href="https://github.com/Syngnat/GoNavi/releases"><img src="https://img.shields.io/github/downloads/Syngnat/GoNavi/total?style=for-the-badge&color=6366F1&label=downloads" alt="Downloads" /></a>
  <a href="https://github.com/Syngnat/GoNavi/stargazers"><img src="https://img.shields.io/github/stars/Syngnat/GoNavi?style=for-the-badge&color=F59E0B" alt="Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E?style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  <a href="https://go.dev"><img src="https://img.shields.io/github/go-mod/go-version/Syngnat/GoNavi?style=flat-square&logo=go&logoColor=white&label=Go" alt="Go" /></a>
  <a href="https://wails.io"><img src="https://img.shields.io/badge/Wails-v2-red?style=flat-square" alt="Wails" /></a>
  <a href="https://reactjs.org"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React" /></a>
  <a href="https://github.com/Syngnat/GoNavi/actions"><img src="https://img.shields.io/github/actions/workflow/status/Syngnat/GoNavi/release.yml?style=flat-square&label=Build" alt="Build" /></a>
</p>

<p align="center">
  <a href="https://mcpvault.io/servers/gonavi/health?utm_source=external_badge&utm_medium=referral&utm_campaign=mcp_health_report"><img src="https://mcpvault.io/badge/gonavi.svg" alt="MCPVault: claimed" /></a>
</p>

<p align="center">
  <b>Language</b>: English · <a href="README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="https://gonavi.org"><b>🌐 Website</b></a>
  ·
  <a href="https://github.com/Syngnat/GoNavi/releases"><b>⬇ Download</b></a>
  ·
  <a href="#-quick-start"><b>⚡ Quick Start</b></a>
  ·
  <a href="#-key-features"><b>✨ Features</b></a>
  ·
  <a href="#-mcp--agents"><b>🤖 MCP</b></a>
</p>

<p align="center">
  <sub>Sponsored by
  <a href="#-sponsors"><b>APISmart</b></a>
  ·
  <a href="#-sponsors"><b>HuaLongAI</b></a></sub>
</p>

---

## Why GoNavi?

Most database GUIs are Electron shells with megabytes of tax. GoNavi takes a different path — and “lightweight” only makes sense if you separate three numbers:

| Number | What it means | GoNavi (v0.9.8) |
|---|---|---|
| **Installer size** | What you download | **~20–26 MB** class (Win / macOS / Linux release assets) |
| **Steady-state RSS** | What RAM the running UI holds | Linux WebKit build, idle empty workbench: main ≈ **429 MB**; with WebKit helpers ≈ **765 MB** (method below) |
| **UI stack** | Chromium tax or not | **Go + system WebView (Wails)** — not Electron |

| | Typical Electron client | **GoNavi** |
|---|---|---|
| Runtime | Chromium + Node | **Go + native WebView** |
| Installer | Hundreds of MB common | **~20–26 MB class** |
| Startup | Heavy | **Fast** |
| Memory claim | Often mixed with installer size | **Measure RSS separately** (see note) |
| AI / Agents | Bolt-on or absent | **First-class MCP + multi-provider AI** (draft SQL; GUI still owns schema / edits / EXPLAIN) |
| Data sources | Mostly RDBMS | **SQL · Cache · Vector · MQ · Search · Time-series · Domestic DBs** |

> **Installer MB ≠ RAM.** The RSS figures above are one Linux cloud run of the v0.9.8 WebKit41 build (empty workbench, no DB connections, remote display, ~30–40 s steady). Do not compare them to installer size, or to unverified “native ~80 MB” marketing. Windows / macOS laptop numbers may differ — treat them as a labeled sample, not a leaderboard score.

> **One cockpit for MySQL, Postgres, Redis, Kafka, Milvus, OceanBase, ClickHouse…**  
> Query, edit, audit, sync — and hand structured context to coding agents without leaking passwords off-host.

---

## At a Glance

```text
┌──────────────────────────────────────────────────────────────────────┐
│  GoNavi Workbench                                                    │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │ Connections │  │ Monaco SQL + AI  │  │ Virtualized DataGrid    │  │
│  │ SSH / Proxy │  │ Schema context   │  │ Batch edit · Export     │  │
│  │ Drivers     │  │ Slash commands   │  │ Txn submit / rollback   │  │
│  └─────────────┘  └────────┬─────────┘  └─────────────────────────┘  │
│                            │                                         │
│              ┌─────────────▼─────────────┐                           │
│              │  Go core · Audit · Sync   │                           │
│              │  MCP HTTP · Web Server    │                           │
│              └───────────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Product screenshots

Each image is a **full GoNavi application window** (1440×900) captured from the latest dev build, scaled proportionally for README display.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/01-home-workbench.png" alt="GoNavi full window — workbench with connections, saved queries, and quick actions" width="100%" />
      <br /><sub><b>Workbench</b> — connections, saved queries, quick actions</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/02-query-editor.png" alt="GoNavi full window — SQL editor with result grid and object tree" width="100%" />
      <br /><sub><b>SQL editor</b> — highlighting, result grid, object tree</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/04-ai-assistant.png" alt="GoNavi full window — AI assistant with schema context and generated SQL" width="100%" />
      <br /><sub><b>AI assistant</b> — schema-aware chat, insert / run / preview generated SQL</sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/05-ai-settings.png" alt="GoNavi full window — AI settings, built-in tools and recommended flows" width="100%" />
      <br /><sub><b>AI settings</b> — built-in tools and recommended inspection flows</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/06-new-connection.png" alt="GoNavi full window — new connection data-source selector" width="100%" />
      <br /><sub><b>New connection</b> — searchable, categorized data-source picker</sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/08-sql-execution-history.png" alt="GoNavi full window — SQL execution history with filters and detail panel" width="100%" />
      <br /><sub><b>SQL execution history</b> — filter, inspect, refill into the editor</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/09-sql-audit.png" alt="GoNavi full window — SQL audit center" width="100%" />
      <br /><sub><b>SQL audit center</b> — desensitized SQL evidence across connections</sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/07-settings-themes.png" alt="GoNavi full window — settings center with built-in themes" width="100%" />
      <br /><sub><b>Settings</b> — built-in themes, fonts, workspace, and more</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Sample data from a local lab database · connection addresses, keys, and provider configuration are not shown</sub></p>

---

## 💖 Sponsors

> **Want to sponsor GoNavi?** We welcome sponsorships and partnerships that help sustain its open-source development. Contact the maintainer on WeChat: `ygf1140302783` (note “GoNavi”) to start a conversation.

<table>
  <tr>
    <td align="center" valign="top" width="50%">
      <a href="https://www.apismart.ai/">
        <img src="assets/sponsors/apismart-logo.png" height="120" alt="APISmart" />
      </a><br/>
      <b><a href="https://www.apismart.ai/">APISmart</a></b><br/>
      <sub>Unified AI model API · OpenAI-compatible</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <a href="https://gonavi.hualong.online/">
        <img src="assets/sponsors/hualong-mark.png" height="120" alt="HuaLongAI" />
      </a><br/>
      <b><a href="https://gonavi.hualong.online/">HuaLongAI</a></b><br/>
      <sub>AI API Gateway · multi-model routing · domestic high-speed endpoint</sub>
    </td>
  </tr>
</table>

Special thanks to **[APISmart](https://www.apismart.ai/)** and **[HuaLongAI](https://gonavi.hualong.online/)** for sponsoring GoNavi open-source development.

| Sponsor | What they offer | Why it fits GoNavi |
|---|---|---|
| **[APISmart](https://www.apismart.ai/)** | APISmart provides unified access to leading AI models through a single API. Developers can connect to LLM, image, and video models using one API key and an OpenAI-compatible interface. This eliminates the need to manage multiple providers separately. Intelligent routing and automatic failover help improve reliability, while centralized billing makes usage easier to manage. With APISmart, developers can build and scale AI applications faster through one streamlined platform. | Lets developers and agent workflows use multiple AI capabilities without separately integrating each provider. |
| **[HuaLongAI](https://gonavi.hualong.online/)** | HuaLongAI is a premium model API relay provider for power AI developers, focused on official direct connectivity. It primarily offers Codex-series models supplied directly from official sources, with no substitutions or dilution, and invites verification. Billing is transparent, with token-level itemized records available for review. It supports enterprise-grade high concurrency and provides enterprise customers with a professional management platform, formal contracts, and invoices; visit the website for contact details. GPT-series models start at a 0.08 rate, with a stable Pro group at 0.15, two-way referral gifts, and uncapped referral rewards. | Stable model access is core infrastructure for GoNavi's schema-aware assistants, MCP, and day-to-day development. |

- APISmart: [https://www.apismart.ai/](https://www.apismart.ai/) — unified AI model API with an OpenAI-compatible interface.
- HuaLongAI: [https://gonavi.hualong.online/](https://gonavi.hualong.online/) — console, docs, and the domestic high-speed endpoint.

> HuaLongAI also sponsored a **shared 50B token pool** for GoNavi **co-maintainers**, used via **API Key** (not 50B per person). Rules and how to apply: [Issue #671](https://github.com/Syngnat/GoNavi/issues/671).

---

## ✨ Key Features

<table>
<tr>
<td width="50%" valign="top">

### 🤖 AI that knows your schema
- OpenAI · Gemini · Claude · custom OpenAI-compatible APIs  
- Attach live table schemas as context  
- Slash commands: generate SQL, explain, optimize, review  
- **MCP**: after detecting a locally installed CLI, one-click connect Claude Code / Codex / OpenCode / ZCode / DeepSeek Harness / Kimi Code / Grok Build, or use Streamable HTTP for remote agents
- Secrets stay on the GoNavi host — agents get tools, not raw passwords  

</td>
<td width="50%" valign="top">

### ⚡ Built for large data
- Virtualized DataGrid for heavy result sets  
- In-place cell edit · batch CRUD · transaction submit/rollback  
- Large-field popup editor · smart read/write modes  
- Export: CSV · XLSX · JSON · Markdown  
- Monaco editor with context-aware completion  

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔌 Connectivity without drama
- URI generate / parse  
- SSH tunnel · proxy  
- Connection JSON import / export  
- On-demand optional driver agents  
- Custom Driver + DSN extensibility  

</td>
<td width="50%" valign="top">

### 🛡️ Observable & shippable
- SQL execution logs with timing  
- Audit center (redacted by default, retention, export)  
- Desktop + experimental **Web Server** mode  
- Docker / K8s / Helm / Podman packaging  
- Auto update checks · multi-arch releases  

</td>
</tr>
</table>

### 🧩 Stack

`Go 1.24` · `Wails v2` · `React 18` · `TypeScript` · `Vite` · `Ant Design 5` · `Zustand` · `Monaco`

---

## 🗄 Supported Data Sources

> **Built-in** — ready out of the box · **Optional agent** — install via Driver Manager

| | |
|---|---|
| **Built-in** | MySQL · GoldenDB · PostgreSQL · Oracle · Redis · Chroma · Qdrant · Milvus · RocketMQ · MQTT · Kafka · RabbitMQ |
| **Optional** | MariaDB · Doris · StarRocks · Sphinx · SQL Server · SQLite · DuckDB · OceanBase · Dameng · Kingbase · HighGo · Vastbase · OpenGauss · GaussDB · IRIS · Caché · MongoDB · TDengine · IoTDB · ClickHouse · Trino · Elasticsearch · TiDB · CockroachDB · KWDB · TimescaleDB · GBase 8a · GBase 8c · GBase 8s · YashanDB · Firebird · QuestDB · GreptimeDB · InfluxDB · Presto · OpenSearch · Weaviate · Meilisearch · Typesense · etcd · ZooKeeper · Custom Driver/DSN |

<details>
<summary><b>Full capability matrix</b></summary>

| Category | Data Source | Driver Mode | Typical Capabilities |
|---|---|---|---|
| Relational | MySQL | Built-in | Schema browsing, SQL query, data editing, export/backup |
| Domestic DB | GoldenDB | Built-in | MySQL-compatible query workflow and distributed transaction scenarios |
| Relational | PostgreSQL | Built-in | Schema browsing, SQL query, data editing, object management |
| Relational | Oracle | Built-in | Query execution, object browsing, data editing |
| Cache | Redis | Built-in | Key browsing, command execution, encoding/view switch |
| Vector Database | Chroma | Built-in | Collection browsing, vector retrieval, metadata filtering |
| Vector Database | Qdrant | Built-in | Collection browsing, vector search, payload filtering |
| Vector Database | Milvus | Built-in | Collection browsing, vector search, scalar filtering |
| Message Queue | RocketMQ | Built-in | Topic browsing, consumer-group inspection, message-oriented workflow |
| Message Queue | MQTT | Built-in | Broker and topic-filter workflow with QoS-aware connection settings |
| Message Queue | Kafka | Built-in | Topic browsing, broker metadata, consumer-group workflow |
| Message Queue | RabbitMQ | Built-in | Queue/exchange browsing, virtual host inspection, management API workflow |
| Relational | MariaDB | Optional driver agent | Querying, object management, data editing |
| Relational | Doris | Optional driver agent | Querying, object browsing, SQL execution |
| Columnar Analytics | StarRocks | Optional driver agent | Querying, object browsing, SQL execution |
| Search | Sphinx | Optional driver agent | SphinxQL querying and object browsing |
| Relational | SQL Server | Optional driver agent | Schema browsing, SQL query, object management |
| File-based | SQLite | Optional driver agent | Local DB browsing, editing, export |
| File-based | DuckDB | Optional driver agent | Large-table query, pagination, file-DB workflow |
| Domestic DB | OceanBase | Optional driver agent | MySQL / Oracle tenant access, object browsing, query workflow |
| Domestic DB | Dameng | Optional driver agent | Querying, object browsing, data editing |
| Domestic DB | Kingbase | Optional driver agent | Querying, object browsing, data editing |
| Domestic DB | HighGo | Optional driver agent | Querying, object browsing, data editing |
| Domestic DB | Vastbase | Optional driver agent | Querying, object browsing, data editing |
| Domestic DB | OpenGauss | Optional driver agent | PostgreSQL-like schema browsing, SQL query, object management |
| Domestic DB | GaussDB | Optional driver agent | PostgreSQL-like schema browsing, SQL query, object management |
| Multi-model | InterSystems IRIS | Optional driver agent | Namespace browsing, SQL query, object management |
| Multi-model | InterSystems Caché | Optional driver agent | Namespace browsing, Caché SQL query, object management |
| Document | MongoDB | Optional driver agent | Document query, collection browsing, connection management |
| Time-series | TDengine | Optional driver agent | Time-series schema browsing and querying |
| Time-series | Apache IoTDB | Optional driver agent | Storage group / device / timeseries browsing and querying |
| Columnar Analytics | ClickHouse | Optional driver agent | Analytical query, object browsing, SQL execution |
| Federated Query | Trino | Optional driver agent | Cross-source SQL via multiple catalogs, `catalog.schema` browsing, SQL execution |
| Search | Elasticsearch | Optional driver agent | Index browsing, mapping inspection, guarded REST console, JSON DSL / query_string search |
| Relational | TiDB | Optional driver agent | MySQL-compatible querying, TiDB execution plans, data editing, sync / migration |
| Relational | CockroachDB | Optional driver agent | PostgreSQL-wire querying, SHOW CREATE DDL, data editing, sync / migration |
| Time-series | KWDB | Optional driver agent | Relational and time-series databases over the PostgreSQL wire, data editing, sync / migration |
| Time-series | TimescaleDB | Optional driver agent | Hypertables and continuous aggregates, chunk statistics, PostgreSQL workflow, sync / migration |
| Domestic DB | GBase 8a | Optional driver agent | MySQL-protocol MPP querying, HASH indexes, single-kind grid commits, sync / migration |
| Domestic DB | GBase 8c | Optional driver agent | openGauss kernel (A / B / PG modes), sha256 authentication, object management, sync / migration |
| Domestic DB | GBase 8s | Optional driver agent | Informix SQLI via your GBase 8s CSDK, object browsing, data editing, SQL backup / restore |
| Domestic DB | YashanDB | Optional driver agent | Oracle-compatible querying via your YashanDB client, PL/SQL objects, execution plans, sync / migration |
| Relational | Firebird | Optional driver agent | Firebird 2.5 / 3.0 / 4-5, procedures / triggers / packages, data editing, SQL backup / restore |
| Time-series | QuestDB | Optional driver agent | Partitioned time-series tables, SQL querying, execution plans, append-only import |
| Time-series | GreptimeDB | Optional driver agent | MySQL-protocol querying, TIME INDEX / tag metadata, append-only import |
| Time-series | InfluxDB | Optional driver agent | InfluxDB 1.x (InfluxQL) / 2.x (Flux) / 3.x (SQL), line-protocol writes, grid editing |
| Federated Query | Presto | Optional driver agent | PrestoDB / PrestoSQL catalogs, SQL execution, cancellation, migration source |
| Search | OpenSearch | Optional driver agent | OpenSearch 1.x / 2.x / 3.x indices, guarded REST console, SQL / PPL |
| Vector Database | Weaviate | Optional driver agent | Classes and tenants, GraphQL-backed grid browsing and editing, vector columns |
| Search | Meilisearch | Optional driver agent | Indexes as tables, filter / sort push-down, document editing, REST console |
| Search | Typesense | Optional driver agent | Collections as tables, filter_by push-down, document editing, REST console |
| Key-Value | etcd | Optional driver agent | Prefix tree browsing, key / lease editing, etcdctl-style console (v2 / v3 APIs) |
| Coordination | ZooKeeper | Optional driver agent | Znode tree browsing, data and ACL inspection, node editing, zkCli-style console |
| Extensibility | Custom Driver/DSN | Custom | Extend to more data sources via Driver + DSN |

</details>

### Elasticsearch REST console

Elasticsearch connections reuse the query workspace as a version-aware REST console:

- Write Dev Tools-style `METHOD /path` requests with JSON bodies, or NDJSON for `_bulk` and `_msearch`; run the request at the cursor, the exact selection, or a batch in editor order.
- Search hits can be viewed as a table while the complete HTTP response remains available as raw JSON or text.
- A server-side allowlist accepts supported search, document, index, mapping, settings, alias, health, and limited CAT operations. Unknown and high-privilege endpoints are rejected by default.
- Destructive operations require an expiring one-time confirmation. Connection protection still takes precedence and blocks writes as well as script-bearing reads.
- Writes are limited to concrete indices and require Elasticsearch `view_index_metadata` (or `manage`) permission so GoNavi can verify the target before sending data; aliases and data streams are not accepted as write targets.
- Request templates adapt document, mapping, and Bulk paths for Elasticsearch 6, 7, and 8.

> This console targets Elasticsearch 6/7/8. It does not claim OpenSearch compatibility, and intentionally excludes reindex, security, snapshot, node, cluster-settings, template, pipeline, lifecycle, and other unrestricted administration APIs.

---

## 🚀 Quick Start

### Prerequisites

- [Go](https://go.dev/dl/) 1.25+
- [Node.js](https://nodejs.org/) 18+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)
- Linux only: a C compiler, pkg-config, and the GTK3 / WebKitGTK development packages

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
```

### Develop

```bash
git clone https://github.com/Syngnat/GoNavi.git
cd GoNavi

wails dev                          # full hot reload
node tools/wails-fast-dev.mjs      # faster when Go exports unchanged
node tools/wails-fast-dev.mjs --refresh-bindings  # after Go export signature changes
```

### Build

```bash
wails build
wails build -clean   # clean build before release
```

Artifacts → `build/bin`.

On Linux, install the build dependencies first (pick one):

```bash
# Debian 12+ / Ubuntu 22.04+
sudo apt-get install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
# Fedora / OpenCloudOS 9
sudo dnf install -y gcc pkgconf-pkg-config gtk3-devel webkit2gtk4.1-devel
# RHEL / Rocky / AlmaLinux 9 (WebKitGTK 4.0 only)
sudo dnf install -y gcc pkgconf-pkg-config gtk3-devel webkit2gtk3-devel
# Arch Linux
sudo pacman -S --needed base-devel gtk3 webkit2gtk-4.1
```

The build detects whether WebKitGTK 4.1 or 4.0 is installed. The frontend build peaks at about 3 GB of memory.

### Prefer a binary?

Grab the latest build from **[Releases](https://github.com/Syngnat/GoNavi/releases)**  
(macOS AMD64/ARM64 · Windows AMD64 · Linux WebKitGTK 4.0/4.1).

### Standalone CLI

Stable and dev builds carry headless `gonavi` archives under the
`gonavi-cli_${VERSION}_${GOOS}_${GOARCH}` namespace with a matching
`gonavi-cli_${VERSION}_checksums.txt` file. Download the matching archive from
the GitHub Release, verify its checksum, extract it, then run:

```bash
gonavi list-connections
gonavi query --conn CONNECTION_ID --sql 'SELECT * FROM orders LIMIT 10'
gonavi export --conn CONNECTION_ID --output orders.csv --sql 'SELECT * FROM orders'
gonavi batch --conn CONNECTION_ID --file migration.sql --allow-write
```

The project does not currently publish the CLI to npm. Install it directly from
the verified release archive instead.

The stable workflow also generates and retains a checksum-driven WinGet
manifest artifact for `Syngnat.GoNavi.CLI`; it must be accepted by the WinGet
community repository before the package is available there. The existing
desktop GoNavi package is separate. After acceptance, install with:

```powershell
winget install --id Syngnat.GoNavi.CLI -e
```

The CLI shares the active data root with the desktop application:
`GONAVI_DATA_ROOT` first, then `~/.gonavi/storage_root.json`, then `~/.gonavi`.
Use a `0600` owner-only `--connection-file` for transient credentials; secrets
are never accepted as command-line flags. Query output defaults to JSONL, while
diagnostics go to stderr. Mutating SQL also requires the stored AI safety level,
connection protections, and `--allow-write`.

For Linux containers, copy `docker.cli.env.example`, set the host data root and
your host UID/GID, then run the CLI against the same mounted `/data` directory:

```bash
cp docker.cli.env.example docker.cli.env
docker compose --env-file docker.cli.env -f docker-compose.cli.yml run --rm gonavi-cli list-connections
```

---

## 🌐 Web Server (Experimental)

Same Go backend + React UI over HTTP — **not** a containerized Wails window.

```powershell
go build .
.\GoNavi-Wails.exe web-server --addr 127.0.0.1:34116
```

- First visit → `/setup` (admin password; optional Google Authenticator)
- Bridge: `window.go.*` / `window.runtime.*` → HTTP / SSE
- Sessions, recovery codes, login rate limits

#### Docker / Podman

```bash
cp docker.web-server.env.example docker.web-server.env
# set GONAVI_HOST_DATA_ROOT (absolute path)
# optional: GONAVI_WEB_PASSWORD (min 6 chars)
docker compose --env-file docker.web-server.env -f docker-compose.web-server.yml up -d
```

Open `http://127.0.0.1:34116`. Mount the active data root at `/data`  
(`connections.json`, `daily_secrets.json`, optional `drivers/`).  
Auth state → `web_auth.json`.

> **Do not expose an unhardened web entry to the public internet.** Use reverse proxy + HTTPS in production.

Health: `GET /__gonavi/healthz`  
Local source build: add `-f docker-compose.web-server.local.yml --build`.

After changing env passwords:

```bash
docker compose --env-file docker.web-server.env -f docker-compose.web-server.yml up -d --force-recreate
```

(`docker restart` does **not** reload env files.)

---

## 🤖 MCP & Agents

Ship schema tools to agents without shipping your vault:

```bash
cp docker.mcp-server.env.example docker.mcp-server.env
docker compose --env-file docker.mcp-server.env -f docker-compose.mcp-server.yml up -d
```

| Surface | Entry |
|---|---|
| MCP container | `docker-compose.mcp-server.yml` → `ghcr.io/syngnat/gonavi-mcp-server` |
| Web UI container | `docker-compose.web-server.yml` → `ghcr.io/syngnat/gonavi-web-server` |
| Podman / Quadlet | [deploy/podman/gonavi-mcp-server](deploy/podman/gonavi-mcp-server) |
| Kubernetes | [deploy/k8s/gonavi-mcp-server](deploy/k8s/gonavi-mcp-server) |
| Helm | [deploy/helm/gonavi-mcp-server](deploy/helm/gonavi-mcp-server) |
| Build-only image | `Dockerfile.build-env` → `ghcr.io/syngnat/gonavi-build-env` |

Image tags (all four images follow the same scheme):

| Tag | Meaning |
|---|---|
| `latest` | Newest stable release |
| `0.9.8` / `v0.9.8` | Exact release, e.g. `ghcr.io/syngnat/gonavi-web-server:0.9.8` |
| `0.9` / `v0.9` | Newest patch of a minor line |
| `dev-latest` | Rolling `dev` branch build, moves on every push |

Pin an exact release when a cluster should not drift; `dev-latest` is a moving
pointer and is not a stable anchor. Release tags are published both with and
without a `v` prefix (`v0.9.8` and `0.9.8`) pointing at the same digest, so use
whichever your tooling expects.

Safety defaults: remote `schema-only` omits `execute_sql`; when enabled it follows the same AI safety controls as the built-in assistant, and calling `execute_sql` is the confirmation.  
Details: [cmd/gonavi-mcp-server/README.md](cmd/gonavi-mcp-server/README.md).

### Linux build environment only

```bash
docker build -f Dockerfile.build-env -t gonavi-build-env:local .
docker run --rm -it -v "$PWD:/workspace" -w /workspace gonavi-build-env:local bash
```

---

## 📦 Release Pipeline

Push a `v*` tag → GitHub Actions builds multi-arch releases.  
Notes auto-generated from merged PRs via `.github/release.yaml`.

---

## 🛠 Troubleshooting

<details>
<summary><b>Windows: missing Microsoft Edge WebView2 Runtime (common on intranet images)</b></summary>

The GoNavi desktop app on Windows depends on the **Microsoft Edge WebView2 Runtime** (a system component, not full Chrome).  
Some intranet / thin / Server / LTSC images ship without it. Symptoms:

- Process exits immediately, blank/white window
- Errors about missing WebView2 / WebView2 Runtime
- Installer blocked by AV or group policy

### 1. Check whether Runtime is installed

In **PowerShell**:

```powershell
# Common Evergreen install path (64-bit Windows)
Test-Path "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application"

# Registry (a `pv` version usually means installed)
Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" `
  -ErrorAction SilentlyContinue |
  Select-Object pv, name
```

If the path is missing and registry has no `pv`, install the Runtime.

### 2. Online install (simplest)

1. Open the official download page:  
   [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
2. Download the **Evergreen Bootstrapper** (small; needs network during install)
3. Run as Administrator, then **restart GoNavi**

### 3. Offline / intranet: Standalone installer (recommended for IT)

The Bootstrapper fails on fully air-gapped machines. Use the **Evergreen Standalone Installer** instead:

1. On a machine with internet, download the matching architecture package, e.g.:
   - `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` (most 64-bit PCs)
   - `…X86.exe` / `…ARM64.exe` as needed
2. Copy the installer into the intranet (USB, software center, share)
3. Install **as Administrator** on the target PC:

```powershell
# Interactive
.\MicrosoftEdgeWebView2RuntimeInstallerX64.exe

# Silent (batch / SCCM friendly)
.\MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
```

4. Start GoNavi again. If it still fails, sign out or reboot Windows once.

### 4. Group policy / locked-down PCs

- Needs local admin, or IT push via SCCM / software center  
- Ensure policies do not block Edge/WebView2 install or updates  
- Enterprises may pin a [Fixed Version](https://developer.microsoft.com/microsoft-edge/webview2/) Runtime (most users should prefer Evergreen)

### 5. Temporary workaround: Web Server mode

If the desktop WebView cannot be installed yet, run the experimental Web Server and use a normal browser:

```powershell
.\GoNavi.exe web-server --addr 127.0.0.1:34116
```

Open `http://127.0.0.1:34116`. See the **Web Server** section above.  
Do **not** expose an unhardened Web endpoint to the public internet.

Tracker / discussion: [#672](https://github.com/Syngnat/GoNavi/issues/672).

</details>

<details>
<summary><b>macOS Gatekeeper</b></summary>

The next stable macOS release is gated on Developer ID signing and Apple notarization. Download the DMG from the matching GitHub Release, move GoNavi to **Applications**, and open it normally. Do not remove Gatekeeper quarantine metadata.

</details>

<details>
<summary><b>Linux: missing WebKitGTK</b></summary>

```bash
# Debian 13 / Ubuntu 24.04+
sudo apt-get update
sudo apt-get install -y libgtk-3-0 libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0

# Ubuntu 22.04 / Debian 12
sudo apt-get update
sudo apt-get install -y libgtk-3-0 libwebkit2gtk-4.0-37 libjavascriptcoregtk-4.0-18
```

Artifacts with `-WebKit41` prefer Debian 13 / Ubuntu 24.04+.

</details>

<details>
<summary><b>Linux: Chinese glyphs as tofu boxes</b></summary>

```bash
sudo apt-get update
sudo apt-get install -y fonts-noto-cjk fonts-wqy-microhei
fc-cache -fv
```

</details>

---

## 🤝 Contributing

Issues and PRs welcome. Branch from **`dev`**, PR against **`dev`**.

- [CONTRIBUTING.md](CONTRIBUTING.md)
- Call for contributors (incl. sponsored token pool): [Issue #671](https://github.com/Syngnat/GoNavi/issues/671)

## 🤝 Contributors

<p align="center">
  <a href="https://github.com/Syngnat/GoNavi/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=Syngnat/GoNavi" alt="GoNavi contributors" />
  </a>
</p>

---

## 💬 Contact & Feedback

| Channel | Notes |
|---|---|
| **GitHub Issues** | Preferred for bugs, feature requests, and docs — easier to track and reproduce |
| **WeChat** | `ygf1140302783` (note “GoNavi”) — maintainer can invite you to the community group for discussion |

> For technical reports, include version, OS, and repro steps when possible. Windows blank/crash on intranet images: [WebView2 guide](https://github.com/Syngnat/GoNavi/issues/672).

---

## ⭐ Star History

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg">
  <img alt="Star history" src="assets/star-history/star-history-light.svg">
</picture>
<!-- star-history:end -->

---

## Links

- [APISmart](https://www.apismart.ai/) — Unified AI model API (GoNavi sponsor)
- [HuaLongAI](https://gonavi.hualong.online/) — AI API Gateway (GoNavi sponsor)
- [linux.do](https://linux.do/)
- [AIBook](https://aibook.ren/)

## License

[Apache-2.0](LICENSE)

<p align="center">
  <sub>Built for people who live in SQL, schemas, and agent loops.</sub>
</p>
