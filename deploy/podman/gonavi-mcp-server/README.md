# GoNavi MCP Server Podman 示例

这个目录提供 `gonavi-mcp-server` 的 Podman 原生部署入口，覆盖两类常见场景：

- 直接用 `podman run` 在 Linux 服务器 / NAS 上启动
- 用 rootless Quadlet + systemd 做常驻服务

目录内容：

- `gonavi-mcp-server.env.example`：给 `podman run` / Quadlet 共用的容器环境变量示例
- `gonavi-mcp-server.container`：Quadlet 示例

前提仍然一样：宿主机 GoNavi 活动数据目录内至少应包含：

- `connections.json`
- `daily_secrets.json`

如果目标连接依赖可选 driver agent，还要保证同一数据目录下已有 `drivers/`。

## 1. 直接运行已发布镜像

```bash
cp deploy/podman/gonavi-mcp-server/gonavi-mcp-server.env.example ./gonavi-mcp-server.env
```

把 `GONAVI_MCP_HTTP_TOKEN` 改成随机值后运行：

环境文件中的 `GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK=true` 仅用于容器监听网卡；Bearer Token 仍然必填。

```bash
podman run -d --name gonavi-mcp-server --replace \
  -p 8765:8765 \
  --env-file ./gonavi-mcp-server.env \
  -v /absolute/path/to/gonavi-data:/data:Z \
  ghcr.io/syngnat/gonavi-mcp-server:latest http
```

查看状态：

```bash
podman ps
podman logs -f gonavi-mcp-server
```

如果你的宿主机没有启用 SELinux，可把挂载参数末尾的 `:Z` 去掉；如果启用了 SELinux，建议保留它。

## 2. 本地源码构建镜像

仓库根目录已经提供 `.containerignore`，Podman 会优先读取它来裁剪构建上下文。

```bash
podman build -f Dockerfile.mcp-server -t localhost/gonavi-mcp-server:local .
podman run -d --name gonavi-mcp-server --replace \
  -p 8765:8765 \
  --env-file ./gonavi-mcp-server.env \
  -v /absolute/path/to/gonavi-data:/data:Z \
  localhost/gonavi-mcp-server:local http
```

## 3. Rootless Quadlet 常驻服务

Podman Quadlet 适合 Linux 服务器 / NAS 上做 rootless 常驻服务。

把文件放到用户级目录：

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/podman/gonavi-mcp-server/gonavi-mcp-server.container ~/.config/containers/systemd/
cp deploy/podman/gonavi-mcp-server/gonavi-mcp-server.env.example ~/.config/containers/systemd/gonavi-mcp-server.env
```

然后修改两处：

- `~/.config/containers/systemd/gonavi-mcp-server.container` 里的 `Volume=/absolute/path/to/gonavi-data:/data:Z`
- `~/.config/containers/systemd/gonavi-mcp-server.env` 里的 `GONAVI_MCP_HTTP_TOKEN`

启动服务：

```bash
systemctl --user daemon-reload
systemctl --user enable --now gonavi-mcp-server.service
systemctl --user status gonavi-mcp-server.service
journalctl --user -u gonavi-mcp-server.service -f
```

如果你希望用户退出登录后服务仍然保持运行，再执行：

```bash
loginctl enable-linger "$USER"
```

Rootless Quadlet 默认搜索路径是 `~/.config/containers/systemd/`；如果你要做系统级 rootful 部署，可改放到 `/etc/containers/systemd/`。

## 4. 关于 Compose

Podman 的 `podman compose` 依赖外部 compose provider。也就是说，是否能直接复用仓库根目录的 `docker-compose.mcp-server.yml`，取决于你的 Podman 环境是否已经安装并配置了对应 provider。

因此，这个仓库对 Podman 的主支持路径是：

- `podman run`
- Quadlet（推荐长期运行）

如果你的环境已经有可用的 compose provider，再去复用根目录 Compose 文件即可。
