<p align="center">
  <img src="assets/readme-logo.png" width="128" alt="GoNavi Logo" />
</p>

<h1 align="center">GoNavi</h1>

<p align="center">
  <b>Navigate every data source — native speed, agent-ready, zero Electron bloat.</b>
</p>

<p align="center">
  A high-performance cross-platform database client built with
  <a href="https://wails.io">Wails</a> (Go) + <a href="https://react.dev">React</a>.
  Desktop-first. MCP-ready. ~30MB class binaries.
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
  <a href="#-sponsors"><b>华龙中转站 / Hualong Transfer Station</b></a></sub>
</p>

---

## Why GoNavi?

Most database GUIs are Electron shells with megabytes of tax. GoNavi takes a different path:

| | Typical Electron client | **GoNavi** |
|---|---|---|
| Runtime | Chromium + Node | **Go + native WebView** |
| Binary size | Hundreds of MB | **~30MB class** |
| Startup | Heavy | **Fast** |
| Memory | High baseline | **Lean** |
| AI / Agents | Bolt-on or absent | **First-class MCP + multi-provider AI** |
| Data sources | Mostly RDBMS | **SQL · Cache · Vector · MQ · Search · Time-series · Domestic DBs** |

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

Each image is a **full GoNavi application window**, scaled proportionally for README display.

<p align="center">
  <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/01-home-workbench.png" alt="GoNavi full window — connections, queries, and workbench" width="560" />
  &nbsp;
  <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/04-ai-assistant.png" alt="GoNavi full window — AI assistant with schema context" width="560" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Syngnat/GoNavi/dev/assets/screenshots/06-new-connection.png" alt="GoNavi full window — new connection data-source selector" width="560" />
</p>

<p align="center"><sub>Real desktop captures · full window</sub></p>

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
| **Optional** | MariaDB · Doris · StarRocks · Sphinx · SQL Server · SQLite · DuckDB · OceanBase · Dameng · Kingbase · HighGo · Vastbase · OpenGauss · GaussDB · IRIS · MongoDB · TDengine · IoTDB · ClickHouse · Trino · Elasticsearch · Custom Driver/DSN |

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
| Document | MongoDB | Optional driver agent | Document query, collection browsing, connection management |
| Time-series | TDengine | Optional driver agent | Time-series schema browsing and querying |
| Time-series | Apache IoTDB | Optional driver agent | Storage group / device / timeseries browsing and querying |
| Columnar Analytics | ClickHouse | Optional driver agent | Analytical query, object browsing, SQL execution |
| Federated Query | Trino | Optional driver agent | Cross-source SQL via multiple catalogs, `catalog.schema` browsing, SQL execution |
| Search | Elasticsearch | Optional driver agent | Index browsing, mapping inspection, guarded REST console, JSON DSL / query_string search |
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

- [Go](https://go.dev/dl/) 1.21+
- [Node.js](https://nodejs.org/) 18+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
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

Safety defaults: remote `schema-only` omits `execute_sql`; mutating SQL requires explicit `allowMutating=true`.  
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

## 💖 Sponsors

<p align="center">
  <a href="https://api-fast.hualong.online/">
    <img src="assets/sponsors/hualong-mark.png" width="120" alt="华龙中转站 Hualong Transfer Station" />
  </a>
</p>

<p align="center">
  <b><a href="https://api-fast.hualong.online/">华龙中转站 · Hualong Transfer Station</a></b><br/>
  <sub>AI API Gateway · multi-model routing · domestic high-speed endpoint</sub>
</p>

Special thanks to **[华龙中转站 (Hualong Transfer Station)](https://api-fast.hualong.online/)** for sponsoring GoNavi open-source development.

| | |
|---|---|
| **What they are** | An **AI API Gateway** that unifies multi-model access behind an OpenAI-compatible surface — so you can ship LLM features without fighting provider fragmentation and network friction. |
| **What you get** | Multi-model routing · OpenAI-compatible API · **domestic high-speed direct endpoint** · practical for indie devs and open-source projects that need reliable LLM access |
| **Why we recommend them** | GoNavi is AI/MCP-first. Stable model access is core infrastructure for coding agents, schema-aware assistants, and day-to-day development. |

**Looking for a solid LLM relay?**  
👉 [https://api-fast.hualong.online/](https://api-fast.hualong.online/) — console, docs, and the domestic high-speed endpoint.

> Hualong also sponsored a **shared 50B token pool** for GoNavi **co-maintainers**, used via **API Key** (not 50B per person). Rules and how to apply: [Issue #671](https://github.com/Syngnat/GoNavi/issues/671).

---

## 🤝 Contributing

Issues and PRs welcome. Branch from **`dev`**, PR against **`dev`**.

- [CONTRIBUTING.md](CONTRIBUTING.md)
- Call for contributors (incl. sponsored token pool): [Issue #671](https://github.com/Syngnat/GoNavi/issues/671)

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

- [华龙中转站 · Hualong Transfer Station](https://api-fast.hualong.online/) — AI API Gateway (GoNavi sponsor)
- [linux.do](https://linux.do/)
- [AIBook](https://aibook.ren/)

## License

[Apache-2.0](LICENSE)

<p align="center">
  <sub>Built for people who live in SQL, schemas, and agent loops.</sub>
</p>
