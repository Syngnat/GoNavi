# Hive Kerberos / TLS 真实互通验证

本夹具只用于 GoNavi 的隔离 HiveServer2 实验环境，不连接生产数据库。
**KDC 准备完成不等于认证互通通过。** 每个认证阶段必须由真实 HiveServer2 完成 OpenSession、GetInfo/Ping、SELECT 1、logged_in_user 和 CloseSession。

## 当前证据

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| Debian + MIT KDC | 已准备 | GONAVI.TEST；容器 healthy；256 MiB / 0.5 CPU |
| 用户与服务票据 | 已准备 | gonavi 用户 keytab 真实 kinit；hive/HTTP 两个服务 kvno=1 |
| Windows → SSH → KDC | 已通过 | keytab 5.904 s、password 5.483 s、TGT-only FILE ccache 3.536 s；均获取两种服务票据并拒绝不存在的服务；不代表 HS2 认证已通过 |
| Java 8 TLS keystore | 已准备 | 独立限额、无网络 helper 成功导入 JKS；密钥与口令未进入仓库 |
| binary / NONE 只读基线与恢复 | 已通过 | 初始基线 12.154 s；原 Compose 恢复后完整只读查询 13.629 s；配置 hash 不变、auth 挂载已移除、原数据卷保留；[恢复证据](./evidence/restored-binary-none.jsonl) |
| binary / Kerberos GSSAPI | 已通过，6/6 | 三种凭据真实完整查询；错误密码、错误 SPN、无 Kerberos 均按预期拒绝；[脱敏证据](./evidence/binary-gssapi.jsonl) |
| HTTP / SPNEGO | 已通过，6/6 | 三种凭据真实完整查询；错误密码、错误 SPN、无认证 HTTP 401 均按预期拒绝；[脱敏证据](./evidence/http-spnego.jsonl) |
| binary / Kerberos + TLS | 已通过，8/8 | 三种凭据完整查询、3 项认证拒绝、错误 CA 与错误 IP 主机名均按 x509 类型拒绝；[脱敏证据](./evidence/binary-gssapi-tls.jsonl) |
| HTTP / SPNEGO + TLS | 已通过，8/8 | 三种凭据完整查询、3 项认证拒绝、错误 CA 与错误 IP 主机名均按 x509 类型拒绝；[脱敏证据](./evidence/http-spnego-tls.jsonl) |

[机器可读汇总](./evidence/summary.json)记录实际测试二进制 SHA-256、各阶段计数、原配置 hash 与恢复断言。四阶段真实矩阵 **28/28 通过**：12 项成功用例均完成公开驱动 OpenSession / GetInfo / Ping / SELECT 1 / logged_in_user=gonavi / CloseSession；16 项负例按 KDC、HS2 或 x509 的具体拒绝原因判定，不把任意网络错误当作认证拒绝。测试环境是固定 digest 的 Apache Hive 4.0.1 + MIT Kerberos，单 realm；不宣称 Hive 1/2、Spark、Impala、跨 realm 或生产网络已验证。

## 不可越过的操作边界

- 现有 Hive 容器仍被其他成员用于 NONE/MR 验证。在 Lead 明确发送 `AUTH PHASE GO` 前，禁止 stop/restart/recreate 或改变它的配置。
- [deploy-kdc.sh](./deploy-kdc.sh) **只创建 KDC**，不调用原 Hive Compose 项目。
- 不修改用户 SSH、DNS、hosts、系统 Kerberos 配置或其他容器。SSH 别名为 `Bero-6H16-DE`，它已包含 ProxyJump。
- 仓库只有脚本、配置模板和脱敏证据。密码、keytab、ccache、私钥、JKS 与渲染后的 TLS 配置只放远端专用目录或本机 TEMP。不要显示其内容，不要 commit/push。

## 资源与凭据引用

远端专用根目录：`/opt/gonavi-db-lab/hive-1584/auth/`。

| 资源 | 约束或路径 |
| --- | --- |
| KDC 容器 | `gonavi-hive-1584-kdc`；内存/交换上限 256 MiB；0.5 CPU；无自动重启 |
| 网络 | 仅加入已有专用 `gonavi-hive-1584`；KDC alias `kdc.gonavi.test` |
| KDC 暴露端口 | `127.0.0.1:11188 → 88` TCP/UDP |
| kpasswd 暴露端口 | `127.0.0.1:12464 → 464` TCP/UDP；管理端口 749 不发布 |
| Realm | `GONAVI.TEST`，仅 AES256/AES128，票据有效期 1 h |
| 用户 principal | `gonavi@GONAVI.TEST` |
| 服务 principal | `hive/hive.gonavi.test@GONAVI.TEST`、`HTTP/hive.gonavi.test@GONAVI.TEST` |
| 用户秘密 | `private/client/gonavi.password`、`gonavi.keytab`、`gonavi.ccache`；0600，父目录 0700 |
| 服务秘密 | `private/hive/hive.keytab`、`hive.jks`、`keystore.password`；uid:gid 1000:1000，0600，父目录 0700 |
| TLS 公共信任锚 | `private/hive/ca.crt`；不可信 CA 反向用例用 `untrusted-ca.crt` |
| TLS SAN | DNS `hive.gonavi.test`、`localhost`；IP `127.0.0.1`；证书有效期 7 天 |

[Dockerfile](./Dockerfile) 固定官方 Debian bookworm-slim 镜像 digest。安装 MIT krb5 与 OpenSSL，不在 KDC 内安装 Java；Java keystore 转换由 [prepare-keystore.sh](./prepare-keystore.sh) 使用现有固定 digest 的官方 Hive 镜像独立执行，128 MiB / 0.5 CPU / network none，不触碰正在运行的 Hive 容器。

## 独立准备 KDC

先确认 11188/12464 在 TCP 和 UDP 上均无监听，且资源名没有被其他用途占用。将本目录复制到远端 `auth/source/`，然后运行：

```sh
cd /opt/gonavi-db-lab/hive-1584/auth/source
sh deploy-kdc.sh
# KDC 初始化成功后执行；只启动一个短生命周期的专用 helper。
sh prepare-keystore.sh
```

`deploy-kdc.sh` 检查端口冲突、专用网络和资源 label，构建也受 256 MiB / 0.5 CPU 限制；已有 KDC 不会被 recreate。初始化错误仅写入专用私有日志，不要打印初始化日志，它可能含交互命令。

## 授权后的 Hive override

[render_hive_auth.py](./render_hive_auth.py) 读取原 Hive XML，但从不改写它，也不启动或重启服务。输出默认是私有 `overrides/<stage>/hive-site.xml`，0600、uid 1000；TLS 口令由私有文件读取并进行 XML 转义。支持 `binary-gssapi`、`http-spnego`、`binary-tls`、`http-tls`、`binary-gssapi-tls`、`http-spnego-tls`。

```sh
python3 render_hive_auth.py binary-gssapi
```

只有获得阶段授权后，才能把 [compose.hive-auth.yaml](./compose.hive-auth.yaml) 合并到**原 Hive Compose 项目**，保持原容器、数据卷、网络、端口和资源限额，不创建第二套 Hive。

| 挂载源（相对远端 auth 根） | 容器目标 |
| --- | --- |
| `private/hive/` | `/run/gonavi-auth:ro` |
| `private/overrides/<stage>/hive-site.xml` | `/hive_custom_conf/hive-site.xml:ro` |
| `private/overrides/<stage>/core-site.xml` | `/hive_custom_conf/core-site.xml:ro` |

阶段环境变量是 `GONAVI_HIVE_STAGE`、`GONAVI_HIVE_STAGE_MODE=binary/http` 和 `GONAVI_HIVE_STAGE_AUTH=KERBEROS/NONE`。Override 保留 1536 MiB Java heap、设置容器 hostname/alias `hive.gonavi.test`，并将 Java Kerberos 配置限定为挂载文件。HTTP 使用 HTTP principal；binary 使用 hive principal；只支持 SASL QOP `auth`，加密由 TLS 提供，不能把 `auth-int` 或 `auth-conf` 当已支持。HTTP 是单向、预先发送 token 的 SPNEGO，不宣称 Kerberos mutual authentication；需要 TLS 严格校验服务器身份。Binary 才验证 RFC 4752 mutual AP-REP。显式服务 realm 已由驱动单独映射并校验返回票据；本夹具只有一个 realm，不构成跨 realm 真实互通证据。

```sh
# 仅在明确授权后执行；本段不会自动运行。
cd /opt/gonavi-db-lab/hive-1584
GONAVI_HIVE_STAGE=binary-gssapi \
GONAVI_HIVE_STAGE_MODE=binary \
GONAVI_HIVE_STAGE_AUTH=KERBEROS \
GONAVI_HIVE_STAGE_CONTAINER_PORT=10000 \
docker compose -f compose.yaml -f auth/source/compose.hive-auth.yaml up -d --no-deps --wait --wait-timeout 180 hive
```

[switch-hive-stage.sh](./switch-hive-stage.sh) 封装同一操作：必须设置 `GONAVI_AUTH_PHASE_APPROVED=1`，校验专用项目 label、保留原配置 hash 和数据卷，只对 `hive` 执行 `up --no-deps --wait`。认证 override 的健康检查使用固定当前阶段容器端口，Docker 管理 10 秒间隔与 180 秒上限，不由 agent 忙轮询。HTTP 阶段内部端口为 10001，binary 为 10000。

原 XML 和 Compose 不变。恢复 NONE 也须与 Lead 协调；脚本的 `restore` 使用原项目、原 Compose 重新建立 binary/NONE Hive 服务，随后必须用公开驱动确认 SELECT 1。不得用 `down -v`，不得删除数据卷。

## Windows 客户端与无 MR 探针

[prepare-client.ps1](./prepare-client.ps1) 只把三种用户凭据和公共 CA 下载到 `%TEMP%/gonavi-hive-1584-auth/`，限制目录 ACL；不下载服务 keytab、私钥或 keystore 口令。它从 [krb5-client.conf.in](./krb5-client.conf.in) 生成仅本次探针引用的配置，不写系统配置。

```powershell
./testdata/hive/auth/prepare-client.ps1
go build -tags gonavi_hive_driver -o "$env:TEMP/gonavi-hive-1584-auth-probe.exe" ./testdata/hive/auth/probe
```

默认端口引用：binary `127.0.0.1:21084 → Bero:11084`（保留 Lead 原隧道）；HTTP `21085 → 11085`；KDC `21188 → 11188`；kpasswd `22464 → 12464`。KDC 设置 TCP 优先，SSH 只转发 TCP 即可。Lead 在认证阶段创建单独受管理的 SSH job，不替换仍被 MR 使用的旧隧道。主机名错误用例额外需要把 `127.0.0.2:21084/21085` 转发到同一服务，不能改 DNS 或关闭校验。

[probe/main.go](./probe/main.go) 从私有 JSON 读取连接参数；密码只接受 `passwordFile` 引用，禁止内联。每次成功都验证公开驱动完整查询路径，不运行 INSERT、DDL、MR 或已有 `TestHiveLive` 大测试。`logged_in_user()` 用来核对会话身份；`doAs=false` 时 `current_user()` 返回服务用户，不能据此判定客户端身份失败。

```powershell
& "$env:TEMP/gonavi-hive-1584-auth-probe.exe" -config "$env:TEMP/gonavi-hive-1584-auth/binary-gssapi-keytab.json"
```

[run-probes.ps1](./run-probes.ps1) 按指定阶段顺序执行并遇到首个错误即失败，将脱敏 JSONL 存到私有 TEMP；只有核对通过后才复制为本目录的非秘密证据。每阶段顺序运行 keytab/password/FILE ccache 的成功用例、错误密码/错误 SPN/未认证请求的拒绝用例。TLS 阶段还要分别验证错误 CA 和错误主机名；只有匹配 x509 错误类型才算预期拒绝，连接失败/503 不得冒充安全测试成功。关闭连接失败也使探针失败。输出只含用例名、状态、会话用户、耗时与脱敏错误，不含连接配置、口令、token 或 keytab。

## Hadoop 启动配置约束

Kerberos 模式必须把 `hadoop.security.authentication=kerberos` 放到阶段专用 core-site 配置，使 Hadoop UGI 在 HiveConf 初始化前看到它。仅放在 Hive 配置中会让 Hadoop 仍处于 `simple`，真实 Hive 4 启动以 `Kerberos principal should have 3 parts: hive` 失败；这不是客户端驱动认证失败。渲染器为六种阶段同时生成适当的 core-site 文件（非 Kerberos 阶段为 `simple`），回归测试检查该早期配置。

## KDC 客户端网络预检（不连接 Hive）

[kdc-probe/main.go](./kdc-probe/main.go) 可在 Hive 切换前单独验证 Windows → SSH → 真实 MIT KDC。分别用 keytab、私有口令与 FILE ccache 为两个服务请求票据，并检查未知服务被 KDC 拒绝。FILE ccache 必须只包含 TGT（允许 MIT 的 X-CACHECONF 元数据），禁止用预缓存服务票据冒充网络互通。执行前由 Lead 确认新的 KDC 隧道正在监听；网络不可达不计为认证拒绝，更不能计为认证通过。

```powershell
go build -o "$env:TEMP/gonavi-hive-1584-kdc-probe.exe" ./testdata/hive/auth/kdc-probe
& "$env:TEMP/gonavi-hive-1584-kdc-probe.exe" -dir "$env:TEMP/gonavi-hive-1584-auth"
```

此预检不连接 HiveServer2，因此即使通过，也不能代替上文每阶段的真实查询证据。

## 本地回归

```powershell
go test -tags gonavi_hive_driver ./testdata/hive/auth/probe ./testdata/hive/auth/kdc-probe -count=1
python -B -m unittest discover -s testdata/hive/auth -p test_render_hive_auth.py -v
```

[probe/main_test.go](./probe/main_test.go) 覆盖拒绝原因分类、凭据脱敏和禁止内联口令；[test_render_hive_auth.py](./test_render_hive_auth.py) 覆盖全部六阶段、原配置不变、去重、非 TLS 不残留口令和 TLS 私密文件必需。以上测试通过不能替代实际 Kerberos/SPNEGO/TLS 互通。
