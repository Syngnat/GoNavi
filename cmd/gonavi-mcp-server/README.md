# GoNavi MCP Server

`gonavi-mcp-server` 会把 GoNavi 已保存连接背后的数据库能力通过 MCP 暴露给外部客户端。本机客户端默认使用 `stdio`；云端 Agent 可使用显式开启的 Streamable HTTP 模式。

## 当前提供的 tools

- `get_connections`
  - 返回 GoNavi 已保存连接的 `id/name/type/target/defaultDatabase` 等摘要信息
- `get_databases`
  - 入参：`connectionId`
- `get_tables`
  - 入参：`connectionId`、可选 `dbName`
  - 返回表列表，并在 `views` 字段附带视图列表，兼容旧客户端只调用 `get_tables` 的场景
- `get_views`
  - 入参：`connectionId`、可选 `dbName`
  - 返回视图列表
- `get_objects`
  - 入参：`connectionId`、可选 `dbName`、可选 `objectTypes`
  - 返回表、视图、触发器、函数、过程、序列、包、事件，以及消息队列类 `topic/queue/exchange` 等对象清单
- `get_columns`
  - 入参：`connectionId`、可选 `dbName`、`tableName`
- `get_table_ddl`
  - 入参：`connectionId`、可选 `dbName`、`tableName`
- `execute_sql`
  - 入参：`connectionId`、可选 `dbName`、`sql`
  - 与内置 AI 助手共用「安全控制」：只读仅查询，读写可 DML，完全可 DDL
  - 调用本工具即视为确认，不必再传 `allowMutating`
  - `maxRowsPerResult` 限制单个结果集返回给 Agent 的行数，默认 `50`，上限 `200`
- `get_script_library` / `get_script`
  - 列出当前用户可见的脚本、文件夹、连接/输入别名和 revision；需要源码时再读取完整脚本
  - 脚本库不返回其他用户的私有脚本
- `save_script`
  - 创建或更新脚本库脚本；更新已有脚本必须带 `revision`
- `list_script_input_sheets`
  - 读取 CSV、JSON 或 XLSX 输入文件的工作表名称；多 Sheet XLSX 先查再传 `sheetName`
- `prepare_script_write`
  - 为未受保护的生产库写入脚本申请一次性 `writeApprovalToken`
- `run_script`
  - 支持 `scriptId` 或内联 JavaScript、连接别名、CSV/JSON/XLSX 输入、批大小、IN 分片、超时、调用次数、输出行数和内存限制
  - 脚本可调用 `gonavi.db.query`、`gonavi.db.execute`、托管事务、`gonavi.files` 和 `gonavi.output`
  - 只读安全等级拒绝 `allowWrite=true`；读写等级允许 DML 但拒绝 DDL；完全等级才允许 DDL
- `get_script_run` / `get_script_output` / `cancel_script_run`
  - 轮询状态与日志、分页读取 `gonavi.output` 输出流、取消仍在运行的脚本

Redis 连接使用同一个 `execute_sql` 工具，`sql` 填写单条 Redis 命令，`dbName` 填写 DB 编号，例如 `GET gonavi:test:counter`。`GET`、`TTL`、`SCAN` 等只读命令可在只读模式执行；`SET`、`DEL` 等普通数据写入需要读写模式；`FLUSHDB`、`FLUSHALL`、脚本及未知命令仍要求完全模式。保存连接的只读保护和执行前再次授权同样生效。分号按 Redis 参数处理，不会拆成多条 SQL。

Redis 结果放在结果集的 `value` 列，缺失 key 返回 `null`，数组按元素返回多行并受返回行数限制。每次执行使用隔离连接，记录既有审计并进入结果脱敏流程。Redis 客户端不自动重试响应丢失的命令；写入结果未知时返回 `outcomeUnknown`，调用方不得自动重试。

远程 Agent 只需要结构元数据时，启动 HTTP 模式请加 `--schema-only`。该模式不注册 `execute_sql` 与脚本执行工具，只保留连接摘要、对象清单、表/视图、字段、索引、外键、触发器和 DDL 工具。

## 查看 MCP SQL 执行记录

在 GoNavi 侧栏打开「SQL 审计」，点击「MCP SQL 执行记录」快捷筛选，即可查看外部客户端执行的 SQL、目标连接、状态、耗时和行数。AI 设置的「请求事件」展示内置 AI 的模型请求，其中也会提示 MCP SQL 的查看位置。

- 记录详情展示 MCP 请求 ID 和客户端指纹；使用请求 ID 筛选或打开详情中的「MCP 请求执行明细」，可关联同一调用的总记录和逐条语句记录。请求 ID 与工具结构化返回值的 `requestId` 一致。
- 客户端指纹由 MCP 初始化信息及会话边界生成。HTTP 使用会话 ID，stdio 使用服务器及父进程边界；只保存哈希，不保存认证 Token、原始会话 ID或进程命令行。该指纹用于区分调用来源，不是可信身份认证。
- 查询编辑器的执行历史默认仍只显示编辑器记录。来源可切换为「MCP」或「编辑器与 MCP」，通过现有「插入编辑器」操作复用 SQL；已脱敏的字面量需要自行补齐，元数据模式不提供 SQL 恢复。
- 桌面端和独立 server 必须使用同一个数据目录，才能查看同一份审计存储。启用审计后，记录遵循既有脱敏、容量和保留设置；关闭审计时不会新增普通执行记录。旧记录没有 MCP 上下文字段，不会反向补造。
- 表结构升级及写入通过 SQLite 写事务串行化，配合 WAL 和锁等待支持多进程并发；存储故障仍遵循现有 fail-open 与健康状态告警机制。升级保留既有记录及哈希，可在审计中心「校验完整性」。

## 运行方式

开发态直接运行：

```powershell
go run ./cmd/gonavi-mcp-server
```

显式运行本机 `stdio`：

```powershell
go run ./cmd/gonavi-mcp-server stdio
```

也可以先编译：

```powershell
go build -o .\bin\gonavi-mcp-server.exe .\cmd\gonavi-mcp-server
```

## Docker / Podman / Compose

当前容器化支持仅覆盖 `gonavi-mcp-server`，不包含 Wails 桌面 GUI。

当前支持矩阵：

- Docker Desktop / Linux 服务器 / NAS：直接使用 Compose 或 `docker run`
- Podman / Quadlet：使用 `deploy/podman/gonavi-mcp-server`
- Kubernetes：使用 `deploy/k8s/gonavi-mcp-server`
- Helm：使用 `deploy/helm/gonavi-mcp-server`
- 仅构建环境：使用仓库根目录 `Dockerfile.build-env`
- 桌面 GUI 浏览器访问版：当前不提供，此仓库主应用仍是 Wails 桌面程序，不是现成的 Web 服务

仓库根目录已提供以下文件：

- `Dockerfile.mcp-server`
- `docker-compose.mcp-server.yml`
- `docker.mcp-server.env.example`
- `deploy/podman/gonavi-mcp-server/*`

推荐流程：

```bash
cp docker.mcp-server.env.example docker.mcp-server.env
docker compose --env-file docker.mcp-server.env -f docker-compose.mcp-server.yml up -d
```

默认 Compose 会拉取 GHCR 预构建镜像。如果你要基于当前工作区源码本地构建，再叠加：

```bash
docker compose --env-file docker.mcp-server.env \
  -f docker-compose.mcp-server.yml \
  -f docker-compose.mcp-server.local.yml \
  up -d --build
```

其中 `GONAVI_HOST_DATA_ROOT` 必须指向 GoNavi 当前活动数据目录。该目录内至少应包含：

- `connections.json`
- `daily_secrets.json`
- `drivers/`（如果目标连接依赖可选 driver agent）

容器内默认会设置：

- `GONAVI_DATA_ROOT=/data`
- `GONAVI_MCP_HTTP_ADDR=0.0.0.0:8765`
- `GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK=true`
- `GONAVI_MCP_HTTP_PATH=/mcp`

`GONAVI_DATA_ROOT` 会覆盖默认活动数据目录解析逻辑，避免宿主机路径与容器内路径不一致时依赖 `storage_root.json` 的绝对路径。

`GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK` 是容器部署的显式许可。直接在宿主机运行二进制时默认关闭，仍只允许绑定 `127.0.0.1`、`::1` 或 `localhost`；即使显式开启，Bearer Token 仍然必填。

如果你只想手动构建镜像：

```bash
docker build -f Dockerfile.mcp-server -t gonavi-mcp-server:local .
docker run --rm -p 8765:8765 \
  -e GONAVI_MCP_HTTP_TOKEN=replace-with-a-random-token \
  -e GONAVI_MCP_SCHEMA_ONLY=true \
  -e GONAVI_DATA_ROOT=/data \
  -v /absolute/path/to/gonavi-data:/data \
  gonavi-mcp-server:local http
```

如果你直接使用已发布镜像：

```bash
docker run --rm -p 8765:8765 \
  -e GONAVI_MCP_HTTP_TOKEN=replace-with-a-random-token \
  -e GONAVI_MCP_SCHEMA_ONLY=true \
  -e GONAVI_DATA_ROOT=/data \
  -v /absolute/path/to/gonavi-data:/data \
  ghcr.io/syngnat/gonavi-mcp-server:latest http
```

### Podman

仓库内还提供了 Podman 原生部署样例：

- `deploy/podman/gonavi-mcp-server/gonavi-mcp-server.env.example`
- `deploy/podman/gonavi-mcp-server/gonavi-mcp-server.container`
- `deploy/podman/gonavi-mcp-server/README.md`

直接运行已发布镜像：

```bash
cp deploy/podman/gonavi-mcp-server/gonavi-mcp-server.env.example ./gonavi-mcp-server.env
podman run -d --name gonavi-mcp-server --replace \
  -p 8765:8765 \
  --env-file ./gonavi-mcp-server.env \
  -v /absolute/path/to/gonavi-data:/data:Z \
  ghcr.io/syngnat/gonavi-mcp-server:latest http
```

如果你要基于当前源码本地构建：

```bash
podman build -f Dockerfile.mcp-server -t localhost/gonavi-mcp-server:local .
podman run -d --name gonavi-mcp-server --replace \
  -p 8765:8765 \
  --env-file ./gonavi-mcp-server.env \
  -v /absolute/path/to/gonavi-data:/data:Z \
  localhost/gonavi-mcp-server:local http
```

其中：

- `gonavi-mcp-server.env` 用 `deploy/podman/gonavi-mcp-server/gonavi-mcp-server.env.example` 初始化
- `:Z` 适用于开启 SELinux 的宿主机；未启用 SELinux 可去掉
- 更适合长期运行的方式见 [deploy/podman/gonavi-mcp-server/README.md](../../deploy/podman/gonavi-mcp-server/README.md) 中的 Quadlet 示例

`podman compose` 本身依赖外部 compose provider，所以仓库对 Podman 的主支持路径是 `podman run` 与 Quadlet，而不是假设所有环境都能直接复用 Compose。

## Kubernetes

仓库内置了最小 K8s 示例：

- `deploy/k8s/gonavi-mcp-server/kustomization.yaml`
- `deploy/k8s/gonavi-mcp-server/base/deployment.yaml`
- `deploy/k8s/gonavi-mcp-server/base/service.yaml`
- `deploy/k8s/gonavi-mcp-server/README.md`
- `deploy/k8s/gonavi-mcp-server/overlays/*`

推荐先从现有 GoNavi 数据目录生成 Secret：

```bash
kubectl create namespace gonavi
kubectl -n gonavi create secret generic gonavi-mcp-server-data \
  --from-file=connections.json=/absolute/path/to/gonavi-data/connections.json \
  --from-file=daily_secrets.json=/absolute/path/to/gonavi-data/daily_secrets.json \
  --from-literal=GONAVI_MCP_HTTP_TOKEN=replace-with-a-random-token
kubectl apply -k deploy/k8s/gonavi-mcp-server
```

如果需要 NAS hostPath、可选 driver agent PVC、Ingress，或两者组合，可直接使用 `overlays/nas-hostpath`、`overlays/drivers-pvc`、`overlays/ingress`、`overlays/ingress-with-drivers-pvc`。

更完整的说明见 [deploy/k8s/gonavi-mcp-server/README.md](../../deploy/k8s/gonavi-mcp-server/README.md)。

## Helm

如果你希望把镜像、Secret、Ingress、hostPath / PVC 挂载做成参数化部署，而不是维护多份 Kustomize overlay，可直接使用：

- `deploy/helm/gonavi-mcp-server`

快速安装：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server -n gonavi --create-namespace
```

Chart 详细说明见 [deploy/helm/gonavi-mcp-server/README.md](../../deploy/helm/gonavi-mcp-server/README.md)。

## Docker / Podman Build Environment

如果你的目标不是运行 MCP，而是给 Linux 服务器 / NAS / CI 准备一套可重复的 Wails 构建环境，可直接使用仓库根目录的 `Dockerfile.build-env`：

```bash
docker build -f Dockerfile.build-env -t gonavi-build-env:local .
docker run --rm -it -v "$PWD:/workspace" -w /workspace gonavi-build-env:local bash
```

如果你使用 Podman，也可以直接执行：

```bash
podman build -f Dockerfile.build-env -t localhost/gonavi-build-env:local .
podman run --rm -it -v "$PWD:/workspace" -w /workspace localhost/gonavi-build-env:local bash
```

镜像内已预装 Go、Node、Wails CLI、GTK3 与 WebKitGTK 开发依赖，适合执行：

```bash
wails build
```

这个镜像默认安装 WebKitGTK 4.0 构建依赖，适合作为通用 Linux / NAS 构建环境。镜像基座支持多架构，`amd64` / `arm64` 会跟随容器平台。

预构建镜像会发布到 GHCR：

- `ghcr.io/syngnat/gonavi-mcp-server:latest`
- `ghcr.io/syngnat/gonavi-build-env:latest`

它只负责构建 Linux 产物，不会把 Wails 主程序变成浏览器版服务。

远程 Agent 使用 Streamable HTTP 时必须设置 bearer token：

```powershell
$env:GONAVI_MCP_HTTP_TOKEN = "<随机token>"
go run ./cmd/gonavi-mcp-server http --addr 127.0.0.1:8765 --path /mcp --schema-only
```

安装包主程序也支持同样模式：

```powershell
& "C:\Program Files\GoNavi\GoNavi.exe" mcp-server http --addr 127.0.0.1:8765 --path /mcp --token "<随机token>" --schema-only
```

默认建议只监听 `127.0.0.1`，再通过 SSH 隧道、反向代理或内网网关暴露给云端 Agent。不要在没有 TLS、防火墙和鉴权的情况下直接监听公网地址。

无图形界面或需要把配置交给云端 Agent 时，可直接生成 OpenClaw / Hermans 等远程 MCP 配置：

```powershell
& "C:\Program Files\GoNavi\GoNavi.exe" mcp-server remote-config --client openclaw --url "https://<你的域名或隧道地址>/mcp" --token "<随机token>" --schema-only
```

独立 server 开发态也支持同样能力：

```powershell
go run ./cmd/gonavi-mcp-server remote-config --client hermans --url "https://<你的域名或隧道地址>/mcp" --token "<随机token>" --schema-only
```

## Claude Code / Codex / OpenCode / ZCode / DeepSeek Harness / Kimi Code / Grok Build / OpenClaw / Hermans

正式安装包场景，推荐直接在 GoNavi 里使用“AI 设置 -> MCP 服务”，选择目标客户端后执行一键接入。除远程 Agent 外，GoNavi 只会在检测到目标客户端的本机 CLI 命令后，才为 Claude Code、Codex、OpenCode、ZCode、DeepSeek Harness、Kimi Code 或 Grok Build 写入当前用户的本地 MCP 配置；未检测到时会禁用写入并提示先安装或启用客户端、将命令加入 `PATH` 后刷新检测。

它会自动把当前安装的 `GoNavi.exe` 写入 Claude Code 的用户级 `~/.claude.json`，命令形态类似：

```json
{
  "mcpServers": {
    "gonavi": {
      "type": "stdio",
      "command": "C:\\Program Files\\GoNavi\\GoNavi.exe",
      "args": ["mcp-server"],
      "env": {}
    }
  }
}
```

这样用户不需要自己找本机 `gonavi-mcp-server.exe` 路径，安装包本体就能直接作为 MCP 入口。

Codex 当前使用 `~/.codex/config.toml`，GoNavi 会写入类似下面这段：

```toml
[mcp_servers.gonavi]
command = 'C:\Program Files\GoNavi\GoNavi.exe'
args = ['mcp-server']
startup_timeout_sec = 60
```

其余一键接入客户端的用户级配置位置与写入形式如下。只有检测到对应本机 CLI 后才会写入；写入后重新加载或重启对应客户端即可生效；已有无关配置会保留。

| 客户端 | 用户级配置位置 | GoNavi 写入位置 |
|---|---|---|
| ZCode | `~/.zcode/cli/config.json` | `mcp.servers.gonavi` |
| DeepSeek Harness | `$DSH_HOME/cordis.patch.yml`，默认 `~/.dsh/cordis.patch.yml` | `@deepseek-ai/dsh-mcp-client` 的 `gonavi-mcp` patch entry |
| Kimi Code | `$KIMI_CODE_HOME/mcp.json`，默认 `~/.kimi-code/mcp.json` | `mcpServers.gonavi` |
| Grok Build | `~/.grok/config.toml` | `[mcp_servers.gonavi]` |

仓库开发态如果要在本机 `Claude Code CLI` 里稳定使用这个 MCP，仍然推荐走仓库内包装脚本：

```powershell
.\tools\claude-gonavi-mcp.ps1 -p "必须调用 gonavi MCP 的 get_connections 工具"
```

或者：

```cmd
tools\claude-gonavi-mcp.cmd -p "必须调用 gonavi MCP 的 get_connections 工具"
```

这个脚本会先构建 `bin\gonavi-mcp-server.exe`，再通过 `--mcp-config` 和 `--strict-mcp-config` 把 GoNavi MCP 单独注入当前 Claude 会话，避免默认混合 MCP 加载时序导致的首轮工具未挂载问题。

OpenClaw、Hermans 这类部署在云端或远端 Linux 的 Agent，不能直接使用 Windows 本机的 `stdio` 命令。GoNavi 的连接信息和数据库密码仍应留在 Windows 本机，由 GoNavi MCP 读取保存连接和系统凭据；远端 Agent 只拿到 MCP tools 和 `connectionId`。

推荐接入形态：

1. Windows 本机运行 GoNavi，并保持能访问已保存的数据库连接。
2. 在 Windows 本机启动 `GoNavi.exe mcp-server http --addr 127.0.0.1:8765 --path /mcp --token <随机token> --schema-only`。
3. 通过 SSH 隧道、反向代理或内网网关把 `http://127.0.0.1:8765/mcp` 暴露为云端 Agent 可访问的 HTTPS 地址。
4. 在 OpenClaw / Hermans 中添加远程 MCP Server，transport 选择 Streamable HTTP，URL 指向 `/mcp` 地址，并设置请求头 `Authorization: Bearer <随机token>`。
5. 先调用 `get_connections` 获取 `connectionId`，再调用 `get_databases`、`get_objects`、`get_tables`、`get_views`、`get_columns`、`get_table_ddl` 等工具读取结构。

如果目标 Agent 支持 `mcpServers` JSON，可按下面的通用片段配置：

```json
{
  "mcpServers": {
    "gonavi": {
      "type": "streamable-http",
      "url": "https://<你的域名或隧道地址>/mcp",
      "headers": {
        "Authorization": "Bearer <随机token>"
      }
    }
  }
}
```

不要把数据库 `host/user/password` 写入云端 Agent 的配置文件。默认 `--schema-only` 不暴露 `execute_sql`；如果你明确需要远程执行 SQL，可以去掉该参数，此时 `execute_sql` 与内置 AI 助手共用安全控制，调用工具即视为确认。

## MCP 客户端配置示例

开发态：

```json
{
  "mcpServers": {
    "gonavi": {
      "command": "go",
      "args": ["run", "./cmd/gonavi-mcp-server"]
    }
  }
}
```

Windows 独立 server 编译产物（开发态）：

```json
{
  "mcpServers": {
    "gonavi": {
      "command": "D:\\Work\\CodeRepos\\GoNavi\\bin\\gonavi-mcp-server.exe",
      "args": []
    }
  }
}
```

Windows 已安装 GoNavi（推荐给最终用户）：

```json
{
  "mcpServers": {
    "gonavi": {
      "type": "stdio",
      "command": "C:\\Program Files\\GoNavi\\GoNavi.exe",
      "args": ["mcp-server"],
      "env": {}
    }
  }
}
```

## 使用说明

- 先调用 `get_connections`，拿到 `connectionId`
- 之后所有数据库工具都只传 `connectionId`，由 GoNavi 服务端内部解析保存连接和密钥
- 如果 `dbName` 为空，会优先使用该保存连接里的默认数据库
- Server 会读取 GoNavi 当前活动数据目录里的连接配置，并通过系统 keyring/凭据管理器解析密文
- 如果本机凭据存储不可用，依赖密钥的连接会返回对应错误
