# GoNavi MCP Server Helm Chart

这个 Chart 用来部署 `gonavi-mcp-server`，覆盖当前仓库 K8s 示例里的几类常见场景：

- 基于现有 Secret 直接部署
- 通过 Helm values 内联创建测试用 Secret
- 启用 Ingress
- 追加 `drivers/` PVC
- NAS / k3s 单机节点直接挂宿主机数据目录

Chart 目录：

- `Chart.yaml`
- `values.yaml`
- `values-examples/*.yaml`
- `templates/*.yaml`

## 1. 默认安装

默认值假设你已经有一个现成 Secret：

- 名称：`gonavi-mcp-server-data`
- 至少包含：
  - `connections.json`
  - `daily_secrets.json`
  - `GONAVI_MCP_HTTP_TOKEN`

安装命令：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server -n gonavi --create-namespace
```

## 2. 直接创建测试用 Secret

如果只是本地验证模板或快速试跑，可以使用示例 values：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server \
  -n gonavi --create-namespace \
  -f deploy/helm/gonavi-mcp-server/values-examples/inline-secret.yaml
```

这个示例只适合最小联调，不适合真实生产连接数据。

## 3. 常用示例

启用 Ingress：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server \
  -n gonavi --create-namespace \
  -f deploy/helm/gonavi-mcp-server/values-examples/ingress.yaml
```

挂载 drivers PVC：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server \
  -n gonavi --create-namespace \
  -f deploy/helm/gonavi-mcp-server/values-examples/drivers-pvc.yaml
```

同时启用 Ingress 与 drivers PVC：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server \
  -n gonavi --create-namespace \
  -f deploy/helm/gonavi-mcp-server/values-examples/ingress-with-drivers-pvc.yaml
```

NAS / k3s hostPath：

```bash
helm upgrade --install gonavi-mcp-server deploy/helm/gonavi-mcp-server \
  -n gonavi --create-namespace \
  -f deploy/helm/gonavi-mcp-server/values-examples/nas-hostpath.yaml
```

## 4. 关键参数

- `image.repository` / `image.tag`
- `mcp.httpAddr` / `mcp.allowNonLoopback`
- `secret.create`
- `secret.name`
- `data.mode=secret|hostPath|pvc`
- `drivers.mode=none|pvc|hostPath`
- `ingress.enabled`

## 5. 约束

- `data.mode=secret` 时，Secret 必须能提供 `connections.json` 和 `daily_secrets.json`
- `data.mode=hostPath` 时，宿主机目录需要包含 GoNavi 活动数据目录内容
- `drivers.mode!=none` 时，会在 `/data/drivers` 追加独立挂载
- Chart 默认只部署 MCP Server，不部署桌面 GUI
