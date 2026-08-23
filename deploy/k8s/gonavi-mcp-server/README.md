# GoNavi MCP Server Kubernetes 示例

这个目录提供 `gonavi-mcp-server` 的最小 K8s 部署清单，适合：

- Linux 服务器上的单集群部署
- NAS 自带 K8s / k3s / k8s-lite 环境
- 需要把 GoNavi MCP 通过 Ingress / Gateway 暴露给远端 Agent 的场景

如果你希望通过 values 参数统一控制镜像、Secret、Ingress、PVC/hostPath，而不是维护多份 overlay，请直接使用 [deploy/helm/gonavi-mcp-server](../../helm/gonavi-mcp-server)。

目录结构：

- `kustomization.yaml`：基础部署入口
- `base/kustomization.yaml`：基础资源集合
- `overlays/nas-hostpath`：直接挂 NAS / 单机节点上的 GoNavi 数据目录
- `base/deployment.yaml` / `base/service.yaml`：基础资源
- `overlays/drivers-pvc`：为 `/data/drivers` 增加 PVC 挂载
- `overlays/ingress`：增加 Ingress 暴露 `/mcp`
- `overlays/ingress-with-drivers-pvc`：同时启用 Ingress 和 drivers PVC

## 前提

容器仍然依赖 GoNavi 的活动数据目录。至少要准备：

- `connections.json`
- `daily_secrets.json`

如果目标连接依赖可选 driver agent，还需要额外挂载 `/data/drivers`。

`base/deployment.yaml` 默认镜像指向：

```text
ghcr.io/syngnat/gonavi-mcp-server:latest
```

如果你要跟随 `dev` 分支，可以改成：

```text
ghcr.io/syngnat/gonavi-mcp-server:dev-latest
```

如果你要使用自建镜像，再按下面方式覆盖 `image`：

- 在当前节点可访问的 Docker / Podman / containerd 环境中构建并导入这个镜像
- 把镜像推送到你的私有仓库，并同步修改 `base/deployment.yaml` 里的 `image`

例如：

```bash
docker build -f Dockerfile.mcp-server -t gonavi-mcp-server:local .
# or
podman build -f Dockerfile.mcp-server -t localhost/gonavi-mcp-server:local .
```

## 1. 创建 Secret

推荐直接从现有 GoNavi 数据文件生成：

```bash
kubectl create secret generic gonavi-mcp-server-data \
  --from-file=connections.json=/absolute/path/to/gonavi-data/connections.json \
  --from-file=daily_secrets.json=/absolute/path/to/gonavi-data/daily_secrets.json \
  --from-literal=GONAVI_MCP_HTTP_TOKEN=replace-with-a-random-token
```

如需单独 namespace，请先执行：

```bash
kubectl create namespace gonavi
kubectl -n gonavi create secret generic gonavi-mcp-server-data \
  --from-file=connections.json=/absolute/path/to/gonavi-data/connections.json \
  --from-file=daily_secrets.json=/absolute/path/to/gonavi-data/daily_secrets.json \
  --from-literal=GONAVI_MCP_HTTP_TOKEN=replace-with-a-random-token
```

## 2. 应用清单

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server
```

如果使用独立 namespace，请先把 YAML 里的 `namespace` 改成你的目标值，或自行用 `kustomize` / Helm 做二次封装。

清单内已经带了基础安全上下文和默认资源配额；如果你的连接数量、对象规模或并发访问更高，建议按实际负载调整 `resources`。

基础 Deployment 会显式设置 `GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK=true`，允许进程监听 Pod 网卡；Bearer Token 仍由 Secret 强制提供。本机直接运行二进制时不要开启该选项。

### 常用 Overlay

仅基础部署：

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server
```

需要可选 driver agent：

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server/overlays/drivers-pvc
```

NAS / k3s 单机节点直接挂宿主机目录：

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server/overlays/nas-hostpath
```

需要对外暴露 `/mcp`：

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server/overlays/ingress
```

同时需要 Ingress 与 drivers PVC：

```bash
kubectl apply -k deploy/k8s/gonavi-mcp-server/overlays/ingress-with-drivers-pvc
```

应用 overlay 前，记得先改里面的占位值，例如：

- `overlays/ingress/ingress.yaml` 里的域名、TLS Secret、`ingressClassName`
- `overlays/drivers-pvc/patch-deployment.yaml` 里的 PVC 名称 `gonavi-drivers`
- `overlays/nas-hostpath/patch-deployment.yaml` 里的宿主机目录 `/volume1/docker/gonavi/data`

`nas-hostpath` overlay 会直接把整个 GoNavi 数据目录挂到 `/data`，因此 `connections.json`、`daily_secrets.json`、`drivers/` 都从宿主机目录读取；此时仍建议保留 `GONAVI_MCP_HTTP_TOKEN` 的 Secret 注入，不要把 token 直接硬编码进 Deployment。

## 3. 校验

```bash
kubectl get pods -n gonavi
kubectl get svc -n gonavi
kubectl port-forward -n gonavi svc/gonavi-mcp-server 8765:8765
curl -H "Authorization: Bearer replace-with-a-random-token" http://127.0.0.1:8765/healthz
```

`/healthz` 返回 `ok` 说明 Pod 已对外提供 HTTP 服务。

## 4. 暴露给远端 Agent

- 集群内使用：直接访问 `http://gonavi-mcp-server.gonavi.svc.cluster.local:8765/mcp`
- 集群外使用：通过 Ingress / Gateway / 反向代理暴露 `/mcp`
- 远端 Agent 请求头：`Authorization: Bearer <你的 token>`

## 5. drivers 挂载

当前示例默认只挂载 `connections.json` 与 `daily_secrets.json`。如果保存连接里包含 Dameng、ClickHouse、DuckDB 等依赖 driver agent 的数据源，请在 Deployment 中额外补一个卷，把宿主机或 PVC 中的 `drivers/` 目录挂载到：

```text
/data/drivers
```

否则对应连接会因为缺少 driver agent 无法使用。
