export const zhCNMessages: Record<string, string> = {
  "common.action.cancel": "取消",
  "common.action.save": "保存",
  "common.action.close": "关闭",
  "common.action.back": "上一步",
  "connection.action.test": "测试连接",
  "connection.modal.action.cancel_test": "取消测试连接",
  "connection.action.viewDetails": "查看原因",
  "connection.status.success": "连接成功",
  "connection.status.failure": "连接失败",
  "connection.sidebar.group.untitled": "未命名分组",
  "connection.sidebar.group.meta": "{count} 个连接 · 连接分组",
  "connection.sidebar.group.badge": "分组",
  "connection.sidebar.group.edit": "编辑分组",
  "connection.sidebar.group.delete": "删除分组",
  "connection.sidebar.group.deleteConfirmTitle": "确认删除",
  "connection.sidebar.group.deleteConfirmContent":
    "确定要删除分组 \"{name}\" 吗？这不会删除里面的连接。",
  "connection.sidebar.group.expandAria": "展开连接分组 {name}",
  "connection.sidebar.group.collapseAria": "折叠连接分组 {name}",
  "connection.sidebar.menu.section": "连接",
  "connection.sidebar.menu.groupSection": "连接分组",
  "connection.sidebar.menu.copy": "复制连接",
  "connection.sidebar.menu.disconnect": "断开连接",
  "connection.sidebar.menu.delete": "删除连接",
  "connection.sidebar.menu.hostFallback": "未配置地址",
  "connection.sidebar.menu.hostBadge": "HOST",
  "connection.sidebar.menu.moveToTag": "移至标签",
  "connection.sidebar.menu.moveOutTag": "移出标签",
  "connection.sidebar.menu.moveToUngrouped": "移出分组",
  "connection.sidebar.menu.createDatabase": "新建数据库",
  "connection.sidebar.menu.refresh": "刷新连接",
  "connection.sidebar.menu.current": "当前",
  "database.unnamed": "未命名数据库",
  "database.label": "数据库",
  "sidebar.active_connection.no_host_selected": "未选择 Host",
  "sidebar.modal.tag.create_title": "新建分组",
  "connection.sidebar.duplicate.backendUnavailable":
    "复制连接失败：后端接口不可用",
  "connection.sidebar.duplicate.noResult":
    "复制连接失败：后端未返回结果",
  "connection.sidebar.duplicate.success": "已复制连接: {name}",
  "connection.sidebar.duplicate.failureFallback": "复制连接失败",
  "connection.sidebar.disconnect.success": "已断开连接",
  "connection.sidebar.delete.confirmTitle": "确认删除",
  "connection.sidebar.delete.confirmContent":
    "确定要删除连接 \"{name}\" 吗？",
  "connection.sidebar.delete.backendUnavailable":
    "删除连接失败：后端接口不可用",
  "connection.sidebar.delete.success": "已删除连接",
  "connection.sidebar.delete.failureFallback": "删除连接失败",
  "sidebar.message.jvm_provider_probe_failed_with_diagnostic":
    "JVM Provider 探测失败：{error}；已保留诊断增强入口",
  "sidebar.message.jvm_provider_probe_exception_with_diagnostic":
    "JVM Provider 探测异常：{error}；已保留诊断增强入口",
  "sidebar.error.unknown": "未知错误",
  "sidebar.message.connection_failed": "连接失败：{error}",
  "sidebar.message.no_visible_databases":
    "未返回可见数据库或结构。请检查账号权限，或从右键菜单刷新。",
  "sidebar.message.jvm_resources_backend_unavailable":
    "JVM 资源后端不可用。",
  "sidebar.message.load_jvm_resources_failed":
    "加载 JVM 资源失败：{error}",
  "connection.modal.title.step1": "选择数据源类型",
  "connection.modal.description.step1":
    "按数据库、中间件或文件类型快速进入对应的连接配置流程。",
  "connection.modal.step1.sectionTitle": "选择数据源",
  "connection.modal.step1.sectionDescription":
    "先选择目标数据库或中间件类型，再进入详细连接参数配置。",
  "connection.modal.step1.group.relational": "关系型数据库",
  "connection.modal.step1.group.domestic": "国产数据库",
  "connection.modal.step1.group.timeseries": "时序数据库",
  "connection.modal.step1.group.other": "其他",
  "connection.modal.step1.hint.jvm": "JMX / Endpoint / Agent",
  "connection.modal.step1.hint.custom": "自定义驱动与 DSN",
  "connection.modal.step1.hint.redis": "单机 / 集群",
  "connection.modal.step1.hint.mongodb": "单机 / 副本集",
  "connection.modal.step1.hint.oceanBase": "MySQL / Oracle 租户",
  "connection.modal.step1.hint.file": "本地文件连接",
  "connection.modal.step1.hint.standard": "标准连接配置",
  "connection.modal.title.create": "新建 {type} 连接",
  "connection.modal.description.create":
    "填写连接参数、测试连通性，并保存到连接树中。",
  "connection.modal.title.edit": "编辑连接",
  "connection.modal.description.edit":
    "调整 {type} 连接的参数、认证方式与网络选项。",
  "connection.modal.failureDialog.title": "测试连接失败原因",
  "connection.modal.failureDialog.description":
    "查看本次测试连接的完整错误上下文，便于快速定位配置问题。",
  "connection.modal.failureDialog.emptyLog": "暂无失败日志",
  "connection.modal.test.validation":
    "测试失败: 请先完善必填项后再测试连接",
  "connection.modal.test.failure": "测试失败: {reason}",
  "connection.modal.secret.placeholder.retained":
    "••••••（留空表示继续沿用{retainedLabel}）",
  "connection.modal.secret.draftReplacement":
    "已输入新值，保存时会替换当前已保存内容。",
  "connection.modal.error.savedConnectionNotFound":
    "未找到当前连接对应的已保存密文，请重新填写密码并保存后再试",
  "connection.modal.error.secretStoreUnavailable":
    "系统密文存储当前不可用，请检查系统钥匙串或凭据管理器后再试",
  "connection.modal.layoutKind.mysqlCompatible": "MySQL 兼容",
  "connection.modal.layoutKind.mongodb": "文档数据库",
  "connection.modal.layoutKind.redis": "键值数据库",
  "connection.modal.layoutKind.postgresCompatible": "PostgreSQL 兼容",
  "connection.modal.layoutKind.oracle": "Oracle 服务",
  "connection.modal.layoutKind.file": "文件型数据库",
  "connection.modal.layoutKind.custom": "自定义连接",
  "connection.modal.layoutKind.jvm": "JVM 运行时",
  "connection.modal.layoutKind.nacos": "Nacos 配置中心",
  "connection.modal.layoutKind.genericSql": "标准 SQL",
  "connection.modal.section.identity.title": "基础身份",
  "connection.modal.section.identity.description":
    "连接名称和连接树中展示的基础信息。",
  "connection.modal.section.uri.title": "连接 URI",
  "connection.modal.section.uri.description":
    "适合复制粘贴完整连接串，也可以和下方参数互相生成、解析。",
  "connection.modal.section.target.title": "目标地址",
  "connection.modal.section.target.description":
    "数据库服务的主机、端口或网关入口，是连通性测试的主目标。",
  "connection.modal.section.fileTarget.title": "数据库文件",
  "connection.modal.section.fileTarget.description":
    "SQLite / DuckDB 使用本地数据库文件路径，不需要端口和网络隧道。",
  "connection.modal.section.connectionMode.title": "连接模式",
  "connection.modal.section.connectionMode.description":
    "选择单机、主从、副本集或集群等拓扑模式。",
  "connection.modal.section.oceanBaseProtocol.title": "OceanBase 协议",
  "connection.modal.section.oceanBaseProtocol.description":
    "明确选择 MySQL 或 Oracle 租户兼容协议。",
  "connection.modal.section.mongoDiscovery.title": "MongoDB 寻址",
  "connection.modal.section.mongoDiscovery.description":
    "选择标准 host:port 或 mongodb+srv DNS 发现方式。",
  "connection.modal.section.replica.title": "多节点配置",
  "connection.modal.section.replica.description":
    "补充从库、种子节点、副本集成员或独立认证信息。",
  "connection.modal.section.service.title": "数据库服务",
  "connection.modal.section.service.description":
    "默认数据库、Oracle Service Name 等服务级定位参数。",
  "connection.modal.section.mongoPolicy.title": "MongoDB 策略",
  "connection.modal.section.mongoPolicy.description":
    "认证库、读偏好等 MongoDB 专属策略。",
  "connection.modal.section.credentials.title": "认证凭据",
  "connection.modal.section.credentials.description":
    "用户名、密码和密文保留策略；留空会按已保存密文规则处理。",
  "connection.modal.section.databaseScope.title": "数据库范围",
  "connection.modal.section.databaseScope.description":
    "连接成功后可限制连接树展示的数据库或 Redis DB。",
  "connection.modal.section.customDriver.title": "自定义驱动",
  "connection.modal.section.customDriver.description":
    "指定驱动名称，用于匹配已安装或可动态导入的数据库驱动。",
  "connection.modal.section.customDsn.title": "连接字符串",
  "connection.modal.section.customDsn.description":
    "直接填写驱动要求的 DSN，适合非内置数据源或特殊参数。",
  "connection.modal.section.jvmRuntime.title": "JVM 运行时",
  "connection.modal.section.jvmRuntime.description":
    "JVM 目标、接入模式、JMX、Endpoint、Agent 与诊断增强。",
  "connection.modal.uri.label": "连接 URI（可复制粘贴）",
  "connection.modal.uri.help":
    "支持从参数生成、复制到剪贴板，或粘贴后一键解析回填参数",
  "connection.modal.uri.action.generate": "生成 URI",
  "connection.modal.uri.action.parse": "从 URI 解析",
  "connection.modal.uri.action.copy": "复制 URI",
  "connection.modal.uri.feedback.generated": "URI 已生成",
  "connection.modal.uri.feedback.generateFailed": "生成 URI 失败",
  "connection.modal.uri.feedback.emptyInput": "请先输入 URI",
  "connection.modal.uri.feedback.unsupported":
    "当前 URI 与数据源类型不匹配，或 URI 格式不支持",
  "connection.modal.uri.feedback.parsed": "已根据 URI 回填连接参数",
  "connection.modal.uri.feedback.parseFailed":
    "URI 解析失败，请检查格式后重试",
  "connection.modal.uri.feedback.emptyCopy": "没有可复制的 URI",
  "connection.modal.uri.feedback.copied": "URI 已复制",
  "connection.modal.uri.feedback.copyFailed": "复制失败",
  "connection.modal.uri.stored.clear": "清除已保存 URI",
  "connection.modal.uri.stored.description":
    "当前已保存连接 URI。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.connectionParams.label": "额外连接参数",
  "connection.modal.connectionParams.help":
    "按当前数据源驱动支持的 URI/DSN query 格式填写；认证密码请使用上方密码字段。",
  "connection.modal.filePicker.sshKeyFailure": "选择私钥文件失败: {detail}",
  "connection.modal.filePicker.sshKnownHostsFailure":
    "选择 known_hosts 文件失败: {detail}",
  "connection.modal.filePicker.certificateFailure":
    "选择证书文件失败: {detail}",
  "connection.modal.filePicker.databaseFailure":
    "选择数据库文件失败: {detail}",
  "connection.modal.error.unknown": "未知错误",
  "connection.modal.secret.blocking.primary":
    "测试连接前请填写新的密码，或取消清除已保存密码",
  "connection.modal.secret.blocking.ssh":
    "测试连接前请填写新的 SSH 密码，或取消清除已保存 SSH 密码",
  "connection.modal.secret.blocking.proxy":
    "测试连接前请填写新的代理密码，或取消清除已保存代理密码",
  "connection.modal.secret.blocking.httpTunnel":
    "测试连接前请填写新的隧道密码，或取消清除已保存隧道密码",
  "connection.modal.secret.blocking.mysqlReplica":
    "测试连接前请填写新的从库密码，或取消清除已保存从库密码",
  "connection.modal.secret.blocking.mongoReplica":
    "测试连接前请填写新的副本集密码，或取消清除已保存副本集密码",
  "connection.modal.secret.blocking.mongoPrimary":
    "测试连接前请填写新的 MongoDB 密码，或重新勾选保存密码",
  "connection.modal.save.backendUnavailable":
    "保存连接失败：后端接口不可用",
  "connection.modal.save.updatedUnconnected": "配置已更新（未连接）",
  "connection.modal.save.savedUnconnected": "配置已保存（未连接）",
  "connection.modal.save.refreshWarning":
    "配置已保存，但安全更新状态暂未刷新，请稍后重新检查",
  "connection.modal.save.failureFallback": "保存失败",
  "connection.modal.test.fallback.driverUnavailable": "驱动未安装启用",
  "connection.modal.test.fallback.incompleteParams": "连接参数不完整",
  "connection.modal.test.timeout":
    "连接测试超时（>{seconds} 秒），请检查网络/代理/SSH配置后重试",
  "connection.modal.test.databaseListTimeout":
    "连接成功但拉取数据库列表超时（>{seconds} 秒）",
  "connection.modal.test.noVisibleSchema":
    "连接成功，但未获取到可见 schema；请检查当前账号权限或默认 schema 配置",
  "connection.modal.test.noVisibleDatabaseList":
    "连接成功，但未获取到可见数据库列表",
  "connection.modal.test.databaseListFailure":
    "连接成功，但获取数据库列表失败：{detail}",
  "connection.modal.test.fallback.rejected":
    "连接被拒绝或参数无效，请检查后重试",
  "connection.modal.test.fallback.validation":
    "请先完善必填项后再测试连接",
  "connection.modal.test.fallback.unknownException": "未知异常",
  "connection.modal.driver.unavailableFallback":
    "{name} 驱动未安装启用，请先在驱动管理中安装",
  "connection.modal.driver.unavailableTitle": "{name} 驱动不可用",
  "connection.modal.driver.currentFallback": "当前",
  "connection.modal.driver.updateFallback":
    "{name} 驱动代理需要重装后才能应用当前版本的驱动侧更新",
  "connection.modal.typeWarning.unavailable": "{name} 驱动未启用",
  "connection.modal.config.basic.title": "基础信息",
  "connection.modal.config.basic.description":
    "常用参数集中在左侧，优先完成连接建立所需的最小输入。",
  "connection.modal.config.basic.navDescription":
    "名称、地址、认证、URI 与数据库范围",
  "connection.modal.config.basic.jvmNavDescription":
    "JVM 目标、接入模式、JMX、Endpoint、Agent 与诊断增强",
  "connection.modal.field.name.label": "连接名称",
  "connection.modal.field.environment_type.label": "预设类型",
  "connection.environment.production": "生产环境",
  "connection.environment.test": "测试环境",
  "connection.environment.development": "开发环境",
  "connection.environment.local": "本地环境",
  "connection.modal.field.name.placeholder.default": "例如：本地测试库",
  "connection.modal.field.name.placeholder.jvm":
    "例如：本地 JVM / 订单服务 JVM",
  "connection.modal.field.host.label": "主机地址 (Host)",
  "connection.modal.field.filePath.label": "文件路径 (绝对路径)",
  "connection.modal.field.addressPath.required": "请输入地址/路径",
  "connection.modal.field.port.label": "端口 (Port)",
  "connection.modal.field.port.required": "请输入端口号",
  "connection.modal.action.browse": "浏览...",
  "connection.modal.field.driver.label": "驱动名称 (Driver Name)",
  "connection.modal.field.driver.required": "请输入驱动名称",
  "connection.modal.field.driver.placeholder": "例如: mysql, postgres",
  "connection.modal.field.dsn.label": "连接字符串 (DSN)",
  "connection.modal.field.dsn.placeholder":
    "例如: user:pass@tcp(localhost:3306)/dbname?charset=utf8",
  "connection.modal.field.dsn.clearSaved": "清除已保存 DSN",
  "connection.modal.field.dsn.savedDescription":
    "当前已保存连接字符串。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.field.protocol.label": "连接协议",
  "connection.modal.field.clickHouseProtocol.help":
    "自动模式按 URI scheme 和常见端口判断；非标 HTTP/Native 端口可手动指定。",
  "connection.modal.field.clickHouseProtocol.auto": "自动",
  "connection.modal.field.oceanBaseProtocol.label": "OceanBase 协议",
  "connection.modal.field.oceanBaseProtocol.help.primary":
    "MySQL 租户选择 MySQL；Oracle 租户选择 Oracle。GoNavi 会根据端口自动选择：OB MySQL wire 端口走 OBClient capability 注入（与 Navicat 相同路径），OBProxy Oracle listener 端口走标准 TNS。",
  "connection.modal.field.oceanBaseProtocol.help.connectionAttributes":
    "如果 Oracle 租户连接报「Error 1235」或 OBClient 握手失败，可在「连接参数」字段通过 {attributes} 覆盖 GoNavi 默认注入的 OBClient capability。",
  "connection.modal.field.defaultDatabase.label": "默认连接数据库（可选）",
  "connection.modal.field.defaultDatabase.help":
    "留空会自动尝试 postgres、template1、与当前用户名同名数据库",
  "connection.modal.field.defaultDatabase.placeholder": "例如：appdb",
  "connection.modal.field.serviceName.label": "服务名 (Service Name)",
  "connection.modal.field.oceanBaseServiceName.label":
    "OceanBase Oracle 服务名 (Service Name)",
  "connection.modal.field.serviceName.required":
    "请输入 Oracle 服务名（例如 ORCLPDB1）",
  "connection.modal.field.oceanBaseServiceName.required":
    "请输入 OceanBase Oracle 服务名",
  "connection.modal.field.serviceName.help":
    "请填写监听器注册的 SERVICE_NAME（不是用户名）。例如：ORCLPDB1",
  "connection.modal.field.oceanBaseServiceName.help":
    "Oracle 租户必须填写监听器注册的 SERVICE_NAME；用户名仍按 OceanBase 租户格式填写。",
  "connection.modal.field.serviceName.placeholder": "例如：ORCLPDB1",
  "connection.modal.field.oracleMode.label": "连接模式",
  "connection.modal.field.oracleMode.service": "服务名称",
  "connection.modal.field.oracleMode.sid": "SID",
  "connection.modal.field.sid.label": "SID",
  "connection.modal.field.sid.required": "请输入 SID",
  "connection.modal.field.sid.placeholder": "例如：ORCL",
  "connection.modal.jvm.unsupportedMode.saveTest":
    "当前连接包含未支持的 JVM 模式；请先调整为 JMX、Endpoint 或 Agent 后再测试或保存",
  "connection.modal.jvm.unsupportedTransport.saveTest":
    "当前连接包含未支持的 JVM 诊断 transport；请先调整为 agent-bridge 或 arthas-tunnel 后再测试或保存",
  "connection.modal.jvm.unsupportedMode.banner":
    "当前连接包含未支持的 JVM 模式。此版本只支持 JMX / Endpoint / Agent，请先调整允许模式和首选模式后再继续。",
  "connection.modal.jvm.unsupportedMode.alert": "检测到未支持的 JVM 模式",
  "connection.modal.jvm.target.title": "目标 JVM",
  "connection.modal.jvm.target.description":
    "定义连接树中的主机入口和基础运行环境。",
  "connection.modal.jvm.host.label": "主机地址",
  "connection.modal.jvm.host.required": "请输入 JVM 主机地址",
  "connection.modal.jvm.port.label": "主端口",
  "connection.modal.jvm.port.required": "请输入 JVM 端口号",
  "connection.modal.jvm.environment.title": "环境",
  "connection.modal.jvm.environment.dev.label": "开发 / 测试",
  "connection.modal.jvm.environment.dev.description": "本地或测试环境。",
  "connection.modal.jvm.environment.staging.label": "预发 / 验收",
  "connection.modal.jvm.environment.staging.description": "上线前验证环境。",
  "connection.modal.jvm.environment.prod.label": "生产",
  "connection.modal.jvm.environment.prod.description":
    "生产 JVM，默认更谨慎。",
  "connection.modal.jvm.securityPolicy.label": "安全策略",
  "connection.modal.jvm.readonlyPreferred": "只读优先",
  "connection.modal.jvm.accessMode.title": "接入模式",
  "connection.modal.jvm.accessMode.description":
    "通过卡片选择允许使用的 JVM 通道；已启用卡片再次点击会设为首选。",
  "connection.modal.jvm.accessMode.required":
    "请至少选择一种 JVM 接入模式",
  "connection.modal.jvm.preferredMode.required":
    "请选择首选 JVM 接入模式",
  "connection.modal.jvm.tag.preferred": "首选",
  "connection.modal.jvm.tag.enabled": "已启用",
  "connection.modal.jvm.tag.notEnabled": "未启用",
  "connection.modal.choice.current": "当前",
  "connection.modal.jvm.mode.jmx.description":
    "标准 MBean 与线程、内存、类加载等运行时指标。",
  "connection.modal.jvm.mode.endpoint.description":
    "通过服务端管理接口读取 JVM 资源与配置。",
  "connection.modal.jvm.mode.agent.description":
    "通过 GoNavi Java Agent 提供更完整的增强能力。",
  "connection.modal.jvm.mode.disable": "停用",
  "connection.modal.jvm.mode.enablePreferred": "启用并设为首选",
  "connection.modal.jvm.preferredSummary":
    "当前首选：{mode}。至少保留一种接入模式，停用首选模式时会自动切换到剩余模式。",
  "connection.modal.jvm.jmx.description":
    "标准 JVM 管理通道，可覆盖主机/端口并配置认证。",
  "connection.modal.jvm.jmx.host.label": "JMX 主机覆盖（可选）",
  "connection.modal.jvm.jmx.host.placeholder": "留空沿用主机地址",
  "connection.modal.jvm.jmx.port.label": "JMX 端口",
  "connection.modal.jvm.jmx.port.placeholder": "沿用主端口",
  "connection.modal.jvm.jmx.username.label": "JMX 用户名（可选）",
  "connection.modal.jvm.jmx.username.placeholder": "未开启认证可留空",
  "connection.modal.jvm.jmx.password.label": "JMX 密码（可选）",
  "connection.modal.jvm.jmx.password.placeholder": "未开启认证可留空",
  "connection.modal.jvm.endpoint.description":
    "连接应用暴露的 JVM 管理端点，适合已有运维 API 的服务。",
  "connection.modal.jvm.endpoint.address.label": "Endpoint 地址",
  "connection.modal.jvm.endpoint.address.required":
    "启用 Endpoint 模式时请输入 Endpoint 地址",
  "connection.modal.jvm.endpoint.address.help":
    "例如 Spring Boot Actuator 或自定义管理接口地址。",
  "connection.modal.jvm.endpoint.address.placeholder":
    "例如：https://orders.internal/manage/jvm",
  "connection.modal.jvm.endpoint.apiKey.label": "Endpoint API Key（可选）",
  "connection.modal.jvm.endpoint.apiKey.placeholder":
    "端点受 Token 保护时填写",
  "connection.modal.jvm.agent.description":
    "连接 GoNavi Java Agent 管理端口，用于增强采集和诊断链路。",
  "connection.modal.jvm.agent.address.label": "Agent 地址",
  "connection.modal.jvm.agent.address.required":
    "启用 Agent 模式时请输入 Agent 地址",
  "connection.modal.jvm.agent.address.help":
    "目标 Java 服务需要以 -javaagent 方式启动 GoNavi Agent。",
  "connection.modal.jvm.agent.address.placeholder":
    "例如：http://127.0.0.1:19090/gonavi/agent/jvm",
  "connection.modal.jvm.agent.apiKey.label": "Agent API Key（可选）",
  "connection.modal.jvm.agent.apiKey.placeholder":
    "Agent 启用 Token 校验时填写",
  "connection.modal.jvm.diagnostic.title": "诊断增强",
  "connection.modal.jvm.diagnostic.description":
    "开启后可创建 JVM 诊断会话并执行受控 Arthas/诊断命令。",
  "connection.modal.jvm.switch.on": "开启",
  "connection.modal.jvm.switch.off": "关闭",
  "connection.modal.jvm.diagnostic.disabledHint":
    "关闭时只保存 JVM 连接与监控能力，不显示诊断会话入口。",
  "connection.modal.jvm.diagnostic.transport.label": "诊断传输",
  "connection.modal.jvm.diagnostic.transport.agentBridge.description":
    "通过 GoNavi Agent 桥接诊断命令。",
  "connection.modal.jvm.diagnostic.transport.arthasTunnel.description":
    "连接官方 Tunnel / Web Console。",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.label":
    "Arthas Tunnel 地址",
  "connection.modal.jvm.diagnostic.bridgeAddress.label":
    "诊断 Bridge 地址",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.required":
    "请输入 Arthas Tunnel Server 地址",
  "connection.modal.jvm.diagnostic.bridgeAddress.required":
    "请输入诊断 Bridge 地址",
  "connection.modal.jvm.diagnostic.arthasTunnelAddress.help":
    "例如：http://127.0.0.1:7777，支持反向代理后的访问前缀。",
  "connection.modal.jvm.diagnostic.bridgeAddress.help":
    "例如：http://127.0.0.1:19091/gonavi/diag",
  "connection.modal.jvm.diagnostic.targetId.agentId.label":
    "目标实例标识（AgentId）",
  "connection.modal.jvm.diagnostic.targetId.label": "目标实例标识",
  "connection.modal.jvm.diagnostic.targetId.required":
    "Arthas Tunnel 模式必须填写目标实例标识",
  "connection.modal.jvm.diagnostic.targetId.arthasHelp":
    "填写 Arthas Tunnel 中目标 JVM 的 agentId。",
  "connection.modal.jvm.diagnostic.targetId.bridgeHelp":
    "可选，用于在桥接端区分具体 JVM 实例。",
  "connection.modal.jvm.diagnostic.timeout.label": "诊断超时（秒）",
  "connection.modal.jvm.diagnostic.timeout.range":
    "诊断超时时间范围: 1-300 秒",
  "connection.modal.jvm.diagnostic.apiKey.label": "诊断 API Key（可选）",
  "connection.modal.jvm.diagnostic.apiKey.placeholder":
    "诊断桥接端启用 Token 校验时填写",
  "connection.modal.jvm.diagnostic.command.observe.label": "观察类命令",
  "connection.modal.jvm.diagnostic.command.observe.description":
    "thread、dashboard、jvm 等只读排查命令。",
  "connection.modal.jvm.diagnostic.command.trace.label": "跟踪类命令",
  "connection.modal.jvm.diagnostic.command.trace.description":
    "trace、watch 等对目标有额外开销的命令。",
  "connection.modal.jvm.diagnostic.command.mutating.label": "高风险命令",
  "connection.modal.jvm.diagnostic.command.mutating.description":
    "可能改变运行态或造成明显性能影响的命令。",
  "connection.modal.topology.single.label": "单机模式",
  "connection.modal.topology.mysql.single.description":
    "只连接一个主库地址，适合本地和单实例。",
  "connection.modal.topology.mysql.replica.label": "主从模式",
  "connection.modal.topology.mysql.replica.description":
    "主库优先，可配置从库地址用于切换。",
  "connection.modal.topology.mongodb.single.description":
    "只连接一个 MongoDB 节点。",
  "connection.modal.topology.mongodb.replica.label": "副本集 / 多节点",
  "connection.modal.topology.mongodb.replica.description":
    "配置副本集名称和多个候选节点。",
  "connection.modal.topology.redis.single.description":
    "只连接一个 Redis 节点。",
  "connection.modal.topology.redis.cluster.label": "集群模式",
  "connection.modal.topology.redis.cluster.description":
    "Redis Cluster，配置多个种子节点。",
  "connection.modal.field.redisHosts.label": "集群附加节点地址",
  "connection.modal.field.redisHosts.help":
    "主节点使用上方主机地址；这里填写其他种子节点，格式：host:port",
  "connection.modal.field.mysqlReplicaHosts.label": "从库地址列表",
  "connection.modal.field.mysqlReplicaHosts.help":
    "可输入多个从库地址，格式：host:port（回车确认）",
  "connection.modal.field.mysqlReplicaHosts.placeholder":
    "例如：10.10.0.12:3306、10.10.0.13:3306",
  "connection.modal.field.mysqlReplicaUser.label": "从库用户名（可选）",
  "connection.modal.field.mysqlReplicaUser.placeholder":
    "留空沿用主库用户名",
  "connection.modal.field.mysqlReplicaPassword.label": "从库密码（可选）",
  "connection.modal.field.mysqlReplicaPassword.placeholder":
    "留空沿用主库密码",
  "connection.modal.field.mysqlReplicaPassword.retained": "已保存从库密码",
  "connection.modal.field.mysqlReplicaPassword.clear": "清除已保存从库密码",
  "connection.modal.field.mysqlReplicaPassword.savedDescription":
    "当前已保存从库密码。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.mongo.discovery.standard.label": "标准地址",
  "connection.modal.mongo.discovery.standard.description":
    "使用 host:port 直连或副本集节点列表。",
  "connection.modal.mongo.discovery.srv.label": "SRV 地址",
  "connection.modal.mongo.discovery.srv.description":
    "使用 mongodb+srv，由 DNS 发现目标节点。",
  "connection.modal.mongo.discovery.srvSshWarning":
    "SRV 与 SSH 隧道同时启用时，可能依赖本地 DNS 解析能力",
  "connection.modal.field.mongoHosts.label": "附加节点地址",
  "connection.modal.field.mongoSrvHosts.label": "附加 SRV 主机（可选）",
  "connection.modal.field.mongoHosts.help":
    "可输入多个节点地址，格式：host:port（回车确认）",
  "connection.modal.field.mongoSrvHosts.help":
    "可输入多个候选主机名，格式：host；若留空则仅使用上方主机。",
  "connection.modal.field.mongoHosts.placeholder":
    "例如：10.10.0.12:27017、10.10.0.13:27017",
  "connection.modal.field.mongoSrvHosts.placeholder":
    "例如：cluster-a.example.com、cluster-b.example.com",
  "connection.modal.field.mongoReplicaSet.label": "副本集名称（可选）",
  "connection.modal.field.mongoReplicaSet.placeholder": "例如：rs0",
  "connection.modal.field.mongoReplicaUser.label": "副本集用户名（可选）",
  "connection.modal.field.mongoReplicaUser.placeholder": "留空沿用主用户名",
  "connection.modal.field.mongoReplicaPassword.label": "副本集密码（可选）",
  "connection.modal.field.mongoReplicaPassword.placeholder":
    "留空沿用主密码",
  "connection.modal.field.mongoReplicaPassword.retained":
    "已保存副本集密码",
  "connection.modal.field.mongoReplicaPassword.clear":
    "清除已保存副本集密码",
  "connection.modal.field.mongoReplicaPassword.savedDescription":
    "当前已保存副本集密码。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.mongo.discoverMembers": "自动发现成员",
  "connection.modal.mongo.discover.failure": "成员发现失败",
  "connection.modal.mongo.discover.successOne": "发现 {count} 个成员",
  "connection.modal.mongo.discover.successMany": "发现 {count} 个成员",
  "connection.modal.mongo.member.role": "角色",
  "connection.modal.mongo.member.health": "健康",
  "connection.modal.mongo.member.healthy": "正常",
  "connection.modal.mongo.member.unhealthy": "异常",
  "connection.modal.field.mongoAuthSource.label": "认证库 (authSource)",
  "connection.modal.field.mongoAuthSource.placeholder":
    "默认使用 database 或 admin",
  "connection.modal.mongo.readPreference.label": "读偏好 (readPreference)",
  "connection.modal.mongo.readPreference.primary.description":
    "只读主节点。",
  "connection.modal.mongo.readPreference.primaryPreferred.description":
    "主节点优先。",
  "connection.modal.mongo.readPreference.secondary.description":
    "只读从节点。",
  "connection.modal.mongo.readPreference.secondaryPreferred.description":
    "从节点优先。",
  "connection.modal.mongo.readPreference.nearest.description":
    "选择最近节点。",
  "connection.modal.mongo.authMechanism.label": "验证方式",
  "connection.modal.mongo.authMechanism.auto.label": "自动协商",
  "connection.modal.mongo.authMechanism.auto.description":
    "交给驱动按服务端能力选择。",
  "connection.modal.mongo.authMechanism.none.label": "无认证",
  "connection.modal.mongo.authMechanism.none.description":
    "不发送认证信息。",
  "connection.modal.mongo.authMechanism.scramSha1.description":
    "兼容旧版本 MongoDB。",
  "connection.modal.mongo.authMechanism.scramSha256.description":
    "推荐的 SCRAM 认证。",
  "connection.modal.mongo.authMechanism.aws.description": "AWS IAM 认证。",
  "connection.modal.field.redisHosts.placeholder":
    "例如：10.10.0.12:6379、10.10.0.13:6379",
  "connection.modal.field.redisPassword.label": "密码 (可选)",
  "connection.modal.field.redisPassword.placeholder":
    "Redis 密码（如果设置了 requirepass）",
  "connection.modal.field.redisPassword.retained": "已保存 Redis 密码",
  "connection.modal.field.displayDatabases.label":
    "显示数据库 (留空显示全部)",
  "connection.modal.field.displayDatabases.help":
    "精确库名，连接测试成功后可选择；与通配包含规则取并集",
  "connection.modal.field.displayDatabases.placeholder":
    "选择显示的数据库",
  "connection.modal.field.includeDatabasePatterns.help":
    "匹配后会自动显示当前和以后新增的数据库",
  "connection.modal.field.includeDatabasePatterns.placeholder":
    "例如：tenant_%、reporting*",
  "connection.modal.field.excludeDatabasePatterns.help":
    "排除规则优先于固定包含和通配包含规则",
  "connection.modal.field.excludeDatabasePatterns.placeholder":
    "例如：*_archive、test_%",
  "connection.modal.field.databasePatterns.help":
    "* 和 % 匹配任意长度，_ 匹配单个字符，\\ 用于转义；排除规则优先。",
  "connection.modal.field.displayRedisDatabases.placeholder":
    "选择显示的数据库 (0-15)",
  "connection.modal.field.username.label": "用户名",
  "connection.modal.field.username.required": "请输入用户名",
  "connection.modal.field.password.label": "密码",
  "connection.modal.field.password.placeholder": "密码",
  "connection.modal.field.password.retained": "已保存密码",
  "connection.modal.field.savePassword": "保存密码",
  "connection.modal.network.title": "网络与安全",
  "connection.modal.network.navDescription": "SSL、SSH、代理与高级连接",
  "connection.modal.network.description":
    "上方稳定列出所有连接方式，下方固定展示当前方式的配置详情，避免启用后页面重新排布，同时给详情区留出足够宽度。",
  "connection.modal.network.currentEditing": "当前编辑",
  "connection.modal.network.enabled": "已启用",
  "connection.modal.network.notEnabled": "未启用",
  "connection.modal.network.ssl.description": "加密与证书校验",
  "connection.modal.network.ssh.title": "SSH 隧道",
  "connection.modal.network.ssh.description": "跳板机 / 堡垒机转发",
  "connection.modal.network.proxy.title": "代理",
  "connection.modal.network.proxy.description": "本地代理或网关转发",
  "connection.modal.network.httpTunnel.title": "Navicat HTTP 隧道",
  "connection.modal.network.httpTunnel.description":
    "MySQL 兼容脚本隧道",
  "connection.modal.network.ssl.panelDescription":
    "为连接链路增加加密与证书校验控制，适合生产或跨网络访问。",
  "connection.modal.network.ssl.disabledHint":
    "左侧勾选“SSL/TLS”后，可在这里配置模式、证书与校验策略。",
  "connection.modal.network.ssl.mode": "SSL 模式",
  "connection.modal.network.ssl.preferred.description":
    "Prefer SSL，失败时按驱动策略处理。",
  "connection.modal.network.ssl.required.description":
    "强制 SSL 并校验证书。",
  "connection.modal.network.ssl.skipVerify.description":
    "强制 SSL 但跳过证书校验。",
  "connection.modal.network.ssl.caPath": "CA 证书路径",
  "connection.modal.network.ssl.serverCaPath": "服务端证书/CA 路径",
  "connection.modal.network.ssl.certPath": "客户端证书路径",
  "connection.modal.network.ssl.damengCertPath":
    "客户端证书路径 (SSL_CERT_PATH)",
  "connection.modal.network.ssl.keyPath": "客户端私钥路径",
  "connection.modal.network.ssl.damengKeyPath":
    "客户端私钥路径 (SSL_KEY_PATH)",
  "connection.modal.network.ssl.certRequired": "达梦 SSL 需要证书路径",
  "connection.modal.network.ssl.keyRequired": "达梦 SSL 需要私钥路径",
  "connection.modal.network.ssl.hint.mysqlCompatible":
    "MySQL 兼容数据源支持 CA 证书、客户端证书与私钥；本地自签证书场景可先用 Preferred 或 Skip Verify。",
  "connection.modal.network.ssl.hint.oceanBaseOracle":
    "OceanBase Oracle 租户使用 Oracle 协议连接；如需 Wallet，请在高级参数中配置 Oracle 驱动参数。",
  "connection.modal.network.ssl.hint.dameng":
    "达梦驱动启用 SSL 需要客户端证书与私钥路径（sslCertPath / sslKeyPath）。",
  "connection.modal.network.ssl.hint.sqlserver":
    "SQL Server 可配置服务端证书/CA 文件；生产环境建议使用 Required，并关闭 TrustServerCertificate。",
  "connection.modal.network.ssl.hint.mongodb":
    "MongoDB 支持 CA 证书、客户端证书与私钥；证书校验异常时可先用 Skip Verify 验证连通性。",
  "connection.modal.network.ssl.hint.oracle":
    "Oracle PEM 证书请优先使用 Wallet 并在高级参数中配置 WALLET；这里仅控制 SSL 开关与校验策略。",
  "connection.modal.network.ssl.hint.tdengine":
    "TDengine 当前仅配置 WSS 与校验策略；证书文件请通过服务端信任链处理。",
  "connection.modal.network.ssl.hint.default":
    "支持的驱动可配置 CA 证书、客户端证书与私钥；仅在测试环境或自签证书场景使用 Skip Verify。",
  "connection.modal.example": "例如: {value}",
  "connection.modal.example.or": "例如: {first} 或 {second}",
  "connection.modal.network.ssh.panelDescription":
    "通过跳板机或堡垒机转发数据库连接，适合内网或受限网络环境。",
  "connection.modal.network.ssh.disabledHint":
    "左侧勾选“SSH 隧道”后，可在这里填写主机、端口、用户名、密码和私钥路径。",
  "connection.modal.network.ssh.host": "SSH 主机 (域名或IP)",
  "connection.modal.network.ssh.hostRequired": "请输入SSH主机",
  "connection.modal.network.ssh.portRequired": "请输入SSH端口",
  "connection.modal.network.ssh.user": "SSH 用户",
  "connection.modal.network.ssh.userRequired": "请输入SSH用户",
  "connection.modal.network.ssh.password": "SSH 密码",
  "connection.modal.network.ssh.keyPath": "私钥路径 (可选)",
  "connection.modal.network.ssh.keyPathPlaceholder": "绝对路径",
  "connection.modal.network.ssh.knownHostsPath": "known_hosts 路径 (可选)",
  "connection.modal.network.ssh.knownHostsPathPlaceholder": "绝对路径",
  "connection.modal.network.ssh.hostKeyFingerprint": "服务端 SHA256 指纹 (可选)",
  "connection.modal.network.ssh.hostKeyFingerprintPlaceholder": "SHA256:<base64>",
  "connection.modal.network.ssh.hostKeyVerificationHint":
    "必须配置 known_hosts 路径或 SHA256 指纹；未知或变更的服务端密钥会被拒绝，应用不会自动写入或覆盖密钥。",
  "connection.modal.network.ssh.hostKeyAutomaticHint":
    "GoNavi 会自动识别并验证服务器身份。首次连接时，请通过可信渠道核对指纹后确认；已信任的服务器会自动通过，密钥变化将被阻止。",
  "connection.modal.network.ssh.hostKeyConfirmationRequired":
    "需要确认 SSH 服务器身份后才能继续。",
  "connection.modal.network.ssh.hostKeyTrustSaved":
    "已信任并保存 SSH 服务器身份。",
  "connection.modal.network.ssh.hostKeyDialog.unknownTitle": "确认 SSH 服务器身份",
  "connection.modal.network.ssh.hostKeyDialog.changedTitle": "SSH 服务器密钥已变化",
  "connection.modal.network.ssh.hostKeyDialog.unknownMessage":
    "GoNavi 已在 SSH 握手中识别到服务器公钥。请通过可信渠道核对指纹后再继续。",
  "connection.modal.network.ssh.hostKeyDialog.changedMessage":
    "服务器返回的密钥与已信任记录不同。为防止中间人攻击，连接已被阻止。",
  "connection.modal.network.ssh.hostKeyDialog.host": "服务器",
  "connection.modal.network.ssh.hostKeyDialog.keyType": "密钥算法",
  "connection.modal.network.ssh.hostKeyDialog.fingerprint": "SHA256 指纹",
  "connection.modal.network.ssh.hostKeyDialog.previousFingerprint": "此前指纹",
  "connection.modal.network.ssh.hostKeyDialog.continueOnce": "仅本次继续",
  "connection.modal.network.ssh.hostKeyDialog.trustAndSave": "信任并保存",
  "connection.modal.network.ssh.hostKeyDialog.replaceAndTrust": "替换并信任",
  "connection.modal.network.ssh.hostKeyDialog.saveExplanation":
    "仅会保存到 GoNavi 的可信主机库，不会修改 ~/.ssh/known_hosts。",
  "connection.modal.network.ssh.hostKeyDialog.saveFailure":
    "保存服务器身份失败：{detail}",
  "connection.modal.network.ssh.retained": "已保存 SSH 密码",
  "connection.modal.network.ssh.clearPassword": "清除已保存 SSH 密码",
  "connection.modal.network.ssh.savedDescription":
    "当前已保存 SSH 密码。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.network.proxy.panelDescription":
    "适合借助本地代理软件或中间网关转发数据库流量。",
  "connection.modal.network.proxy.disabledHint":
    "左侧勾选“代理”后，可在这里选择代理类型并填写主机、端口与认证信息。",
  "connection.modal.network.proxy.host": "代理主机",
  "connection.modal.network.proxy.hostRequired": "请输入代理主机",
  "connection.modal.network.proxy.type": "代理类型",
  "connection.modal.network.proxy.socks5.description":
    "常见本地代理和网关代理。",
  "connection.modal.network.proxy.http.description":
    "通过 HTTP CONNECT 建立隧道。",
  "connection.modal.network.proxy.portRequired": "请输入代理端口",
  "connection.modal.network.proxy.user": "代理用户名（可选）",
  "connection.modal.network.proxy.password": "代理密码（可选）",
  "connection.modal.network.proxy.noAuth": "留空表示无认证",
  "connection.modal.network.proxy.retained": "已保存代理密码",
  "connection.modal.network.proxy.clearPassword": "清除已保存代理密码",
  "connection.modal.network.proxy.savedDescription":
    "当前已保存代理密码。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.network.httpTunnel.panelDescription":
    "通过完整的 ntunnel_mysql.php URL 转发 MySQL 请求。",
  "connection.modal.network.httpTunnel.disabledHint":
    "左侧勾选后填写完整脚本 URL 与认证信息；当前仅支持 MySQL 兼容连接，标准 HTTP CONNECT 请使用 HTTP 代理。",
  "connection.modal.network.httpTunnel.host": "HTTP 隧道 URL",
  "connection.modal.network.httpTunnel.hostRequired":
    "请输入完整的 HTTP 隧道 URL",
  "connection.modal.network.httpTunnel.urlPlaceholder":
    "例如：https://gateway.example.com/ntunnel_mysql.php",
  "connection.modal.network.httpTunnel.portRequired": "请输入隧道端口",
  "connection.modal.network.httpTunnel.user": "HTTP Basic 用户名（可选）",
  "connection.modal.network.httpTunnel.password": "HTTP Basic 密码（可选）",
  "connection.modal.network.httpTunnel.retained": "已保存 HTTP 隧道密码",
  "connection.modal.network.httpTunnel.clearPassword":
    "清除已保存 HTTP 隧道密码",
  "connection.modal.network.httpTunnel.savedDescription":
    "当前已保存 HTTP 隧道密码。留空表示继续沿用，输入新值表示替换。",
  "connection.modal.network.httpTunnel.encodeBase64":
    "Base64 编码查询内容",
  "connection.modal.network.httpTunnel.encodeBase64Hint":
    "对应 Navicat 的 encodeBase64 选项，默认开启。",
  "connection.modal.network.httpTunnel.exclusiveHint":
    "当前仅支持 MySQL 兼容连接。标准 HTTP CONNECT 代理请在“代理”中选择 HTTP 类型。",
  "connection.modal.validation.ssl.damengRequired":
    "达梦启用 SSL 时必须填写证书路径与私钥路径",
  "connection.modal.validation.ssl.clientPairRequired":
    "TLS 客户端证书与私钥路径需要同时填写",
  "connection.modal.validation.httpTunnel.hostRequired":
    "HTTP 隧道 URL 不能为空",
  "connection.modal.validation.httpTunnel.portRange":
    "HTTP 隧道端口必须在 1-65535 之间",
  "connection.modal.network.advanced.title": "高级连接",
  "connection.modal.network.timeout.label": "连接超时 (秒)",
  "connection.modal.network.timeout.help": "数据库连接超时时间，默认 30 秒",
  "connection.modal.network.timeout.range": "超时时间范围: 1-300 秒",
  "connection.modal.network.keepAliveEnabled.checkbox": "启用后台定时探活保活",
  "connection.modal.network.keepAliveEnabled.help":
    "仅在跳板机 token 或长连接会话需要定期续期时开启。",
  "connection.modal.network.keepAliveInterval.label": "探活间隔 (分钟)",
  "connection.modal.network.keepAliveInterval.help":
    "后台会按这个间隔对已建立的缓存连接执行 Ping 或自定义探活 SQL，默认 240 分钟。",
  "connection.modal.network.keepAliveInterval.range":
    "探活间隔范围: 1-1440 分钟",
  "connection.modal.network.keepAliveSQL.label": "自定义探活 SQL",
  "connection.modal.network.keepAliveSQL.help":
    "留空时使用驱动 Ping；仅允许一条 SELECT/WITH，请使用只返回少量数据的轻量查询和数据库只读账号。配置会随连接明文保存，请勿填写凭证。",
  "connection.modal.network.keepAliveSQL.maxLength":
    "自定义探活 SQL 不能超过 4096 个字符",
  "connection.modal.network.keepAliveSQL.readOnly":
    "自定义探活 SQL 仅允许一条 SELECT 或 WITH 语句",
  "connection.modal.appearance.title": "外观",
  "connection.modal.appearance.description": "自定义图标与颜色",
  "connection.modal.appearance.icon": "图标",
  "connection.modal.appearance.current": "当前：{name}",
  "connection.modal.appearance.color": "颜色",
  "connection.modal.appearance.customColor": "自定义颜色",
  "connection.modal.appearance.preview": "预览",
  "connection.modal.appearance.previewName": "连接名称",
  "connection.modal.appearance.reset": "重置为默认",
  "connection.modal.config.sections": "配置分区",
  "connection.modal.driver.unavailableAlert": "当前数据源驱动未启用",
  "connection.modal.driver.installAction": "去驱动管理安装",
  "connection.modal.driver.updateAlert": "当前数据源驱动代理建议重装",
  "connection.modal.driver.reinstallAction": "去驱动管理重装",
};
