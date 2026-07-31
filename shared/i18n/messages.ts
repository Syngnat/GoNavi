import type { SupportedLanguage } from "./locales";

export type MessageKey = string;

export const messages: Record<SupportedLanguage, Record<MessageKey, string>> = {
  "zh-CN": {
    "common.action.cancel": "取消",
    "common.action.save": "保存",
    "common.action.close": "关闭",
    "common.action.back": "上一步",
    "connection.action.test": "测试连接",
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
    "sidebar.field.environment_type": "预设分组类型",
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
    "connection.modal.field.displayDatabases.help": "连接测试成功后可选择",
    "connection.modal.field.displayDatabases.placeholder":
      "选择显示的数据库",
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
    "connection.modal.network.httpTunnel.title": "HTTP 隧道",
    "connection.modal.network.httpTunnel.description":
      "独立 HTTP CONNECT 路由",
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
      "与代理模式互斥，适合单独指定一条 HTTP CONNECT 隧道路由。",
    "connection.modal.network.httpTunnel.disabledHint":
      "左侧勾选“HTTP 隧道”后，可在这里填写隧道目标与认证信息。",
    "connection.modal.network.httpTunnel.host": "隧道主机",
    "connection.modal.network.httpTunnel.hostRequired": "请输入隧道主机",
    "connection.modal.network.httpTunnel.portRequired": "请输入隧道端口",
    "connection.modal.network.httpTunnel.user": "隧道用户名（可选）",
    "connection.modal.network.httpTunnel.password": "隧道密码（可选）",
    "connection.modal.network.httpTunnel.retained": "已保存隧道密码",
    "connection.modal.network.httpTunnel.clearPassword":
      "清除已保存隧道密码",
    "connection.modal.network.httpTunnel.savedDescription":
      "当前已保存隧道密码。留空表示继续沿用，输入新值表示替换。",
    "connection.modal.network.httpTunnel.exclusiveHint":
      "与“使用代理”互斥，启用后将通过 HTTP CONNECT 建立独立隧道。",
    "connection.modal.validation.ssl.damengRequired":
      "达梦启用 SSL 时必须填写证书路径与私钥路径",
    "connection.modal.validation.ssl.clientPairRequired":
      "TLS 客户端证书与私钥路径需要同时填写",
    "connection.modal.validation.httpTunnel.hostRequired":
      "HTTP 隧道主机不能为空",
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
    "driver.guidance.localImportButton": "导入驱动包",
    "driver.guidance.localImportDirectoryHelp":
      "如果应用内下载链路失败，可先手动下载驱动包到该目录，再使用“导入驱动包”或“导入驱动目录”完成安装。",
    "driver.guidance.localImportSingleFileHelp":
      "行内“导入驱动包”仅用于单个驱动文件/总包（如 `mariadb-driver-agent`、`mariadb-driver-agent.exe`、`GoNavi-DriverAgents.zip`），不支持直接导入 JDBC Jar；批量导入请使用上方“导入驱动目录”。",
    "driver.guidance.customConnectionDriverHelp":
      "已支持: mysql, starrocks, oceanbase, postgres, opengauss, sqlite, oracle, dm, kingbase, clickhouse；别名支持 postgresql/pgx、open_gauss/open-gauss、dm8、kingbase8/kingbasees/kingbasev8。ClickHouse 自定义连接可填写 clickhouse://、http(s)://、jdbc:clickhouse:// 或 jdbc:ch:// DSN，并复用 GoNavi ClickHouse driver-agent，不会加载 JDBC Jar。其他驱动请填写 GoNavi 已注册的 Go database/sql 驱动名，不能直接填写系统 ODBC/JDBC 驱动名。",
    "driver.modal.title": "驱动管理",
    "driver.modal.footer.refresh": "刷新",
    "driver.modal.footer.networkCheck": "网络检测",
    "driver.modal.footer.close": "关闭",
    "driver.modal.footer.background": "后台运行",
    "driver.modal.header.description.install":
      "除 MySQL / Redis / Oracle / PostgreSQL 外，其他数据源需先安装启用后再连接。",
    "driver.modal.header.description.agent":
      "驱动代理独立运行，GoNavi 升级后如提示重装，请重新安装对应驱动以应用新的 agent 逻辑。",
    "driver.modal.stats.total": "全部",
    "driver.modal.stats.enabled": "已启用",
    "driver.modal.stats.needsUpdate": "需重装",
    "driver.modal.stats.notEnabled": "未启用",
    "driver.modal.network.unreachable.downloadChain":
      "重要提醒：驱动下载链路域名不可达",
    "driver.modal.network.unreachable.general":
      "重要提醒：驱动下载网络不可达",
    "driver.modal.network.unreachable.description":
      "当前可能能访问 GitHub 页面，但驱动包下载会跳转到资产域名。请优先在 GoNavi 顶部“代理”中启用全局代理（填写代理应用本地地址和端口）。",
    "driver.modal.network.unreachable.proxyButton": "打开全局代理设置",
    "driver.modal.network.unreachable.proxyHint":
      "若仍失败，请在代理规则放行：{hosts}；仍无法调整规则时，再考虑开启 TUN 模式。",
    "driver.modal.network.proxyEnv.detected":
      "检测到代理环境变量：{keys}",
    "driver.modal.network.details.label": "查看网络检测明细",
    "driver.modal.network.details.latency":
      "代理链路到 GitHub 连通性延迟：{reachability}{latency}{error}",
    "driver.modal.network.details.reachable": "可达",
    "driver.modal.network.details.unreachable": "不可达",
    "driver.modal.network.details.noResult": "暂无结果",
    "driver.modal.network.details.noProxyEnv": "未检测到系统代理环境变量。",
    "driver.modal.network.pending.checking": "正在检测驱动下载网络...",
    "driver.modal.network.pending.idle": "尚未完成网络检测",
    "driver.modal.directory.title": "驱动目录与手动导入说明",
    "driver.modal.directory.description":
      "自动下载和手动导入的驱动都会落盘到以下目录；后续版本升级可重复复用已下载驱动。",
    "driver.modal.directory.root": "驱动根目录：{path}",
    "driver.modal.directory.logPath": "运行日志文件：{path}",
    "driver.modal.toolbar.searchPlaceholder":
      "搜索驱动名称/类型（如 DuckDB、clickhouse）",
    "driver.modal.toolbar.forceOverwrite": "覆盖已安装",
    "driver.modal.toolbar.installAll": "安装所有驱动",
    "driver.modal.toolbar.reinstallUpdates": "重装需更新驱动",
    "driver.modal.toolbar.removeAll": "删除所有驱动",
    "driver.modal.toolbar.openDirectory": "打开驱动目录",
    "driver.modal.toolbar.importDirectory": "导入驱动目录",
    "driver.modal.batch.action.installAll": "安装所有驱动",
    "driver.modal.batch.action.reinstallUpdates": "重装需更新驱动",
    "driver.modal.batch.action.removeAll": "删除所有驱动",
    "driver.modal.batch.action.default": "批量操作",
    "driver.modal.batch.running": "批量任务运行中",
    "driver.modal.batch.processed": "已处理 {completed} / {total}",
    "driver.modal.batch.success": "成功 {count}",
    "driver.modal.batch.failed": "失败 {count}",
    "driver.modal.batch.skipped": "跳过 {count}",
    "driver.modal.batch.current": "当前：{name}",
    "driver.modal.summary.total": "共 {count} 个驱动",
    "driver.modal.summary.match": "匹配 {matched} / {total}",
    "driver.modal.status.refreshing": "正在刷新状态...",
    "driver.modal.empty.noData": "暂无驱动数据",
    "driver.modal.empty.noMatch": "未找到匹配“{keyword}”的驱动",
    "driver.modal.log.title": "驱动日志 - {name}",
    "driver.modal.log.installDir": "安装目录：{path}",
    "driver.modal.log.executablePath": "驱动可执行文件：{path}",
    "driver.modal.log.empty": "当前驱动暂无操作日志。",
    "driver.modal.card.packageSize": "大小：{size}",
    "driver.modal.card.version": "版本：{version}",
    "driver.modal.card.affectedConnections": "影响 {count} 个已保存连接",
    "driver.modal.card.needsUpdate": "需要重装",
    "driver.modal.card.expandReason": "展开原因",
    "driver.modal.card.expand": "展开",
    "driver.modal.card.versionLabel": "驱动版本",
    "driver.modal.card.progressLabel": "状态进度",
    "driver.modal.card.noInstallNeeded": "无需安装",
    "driver.modal.card.versionPlaceholder.load": "点击加载版本",
    "driver.modal.card.versionPlaceholder.select": "选择驱动版本",
    "driver.modal.card.versionSizeCalculating": "计算中...",
    "driver.modal.card.fullOnly": "当前精简版不可安装，请使用 Full 版",
    "driver.modal.card.logs": "日志",
    "driver.modal.card.builtInUsable": "内置可用",
    "driver.modal.card.installing": "安装中 {percent}%",
    "driver.modal.card.enabled": "已启用",
    "driver.modal.card.installed": "已安装",
    "driver.modal.card.notEnabled": "未启用",
    "driver.modal.card.status.builtIn": "内置驱动，可直接连接。",
    "driver.modal.card.status.runtimeAvailable": "纯 Go 驱动已启用，可直接连接。",
    "driver.modal.card.status.needsUpdate":
      "需要重装以应用驱动侧更新。",
    "driver.modal.card.status.installedRevision":
      "已安装 revision {revision}。",
    "driver.modal.card.status.expectedRevision":
      "当前需要 revision {revision}。",
    "driver.modal.card.status.installedPending": "已安装，待生效。",
    "driver.modal.card.status.installedPendingVersion":
      "已安装，待生效（版本：{version}）。",
    "driver.modal.card.status.notEnabledVersion":
      "未启用（版本：{version}）。",
    "driver.modal.card.status.notEnabled": "未启用。",
    "driver.modal.punctuation.comma": "，",
    "driver.modal.punctuation.listSeparator": "、",
    "driver.modal.localSource.file": "文件",
    "driver.modal.localSource.directory": "目录",
    "driver.modal.version.default": "默认版本",
    "driver.modal.version.tip": "（{version}）",
    "driver.modal.version.group.year": "{year} 年",
    "driver.modal.version.group.other": "其他",
    "driver.modal.network.completed": "驱动网络检测已完成",
    "driver.modal.network.summary.reachable":
      "驱动下载网络检测通过，可直接安装驱动。",
    "driver.modal.network.summary.downloadChainUnreachable":
      "GitHub API 可达，但驱动下载链路不可达。",
    "driver.modal.network.summary.unreachableProxyConfigured":
      "检测到部分驱动下载地址不可达，请确认系统代理配置有效后重试。",
    "driver.modal.network.summary.proxyRecommended":
      "检测到部分驱动下载地址不可达，建议先配置 HTTP/HTTPS/SOCKS5 代理后再安装驱动。",
    "driver.modal.error.statusFetch": "拉取驱动状态失败",
    "driver.modal.error.statusFetchWithDetail": "拉取驱动状态失败：{detail}",
    "driver.modal.error.networkCheck": "驱动网络检测失败",
    "driver.modal.error.networkCheckWithDetail": "驱动网络检测失败：{detail}",
    "driver.modal.error.versionList": "{name} 版本列表加载失败",
    "driver.modal.error.versionListLoad": "加载 {name} 版本列表失败：{detail}",
    "driver.modal.error.installDriver": "安装 {name} 失败",
    "driver.modal.error.invalidLocalImport": "未选择有效的本地导入{source}",
    "driver.modal.error.localImportDriver": "导入 {name} 本地驱动包失败",
    "driver.modal.error.selectPackageFile": "选择本地驱动包文件失败",
    "driver.modal.error.invalidPackageFile": "未选择有效的驱动包文件",
    "driver.modal.error.selectPackageDirectory": "选择本地驱动包目录失败",
    "driver.modal.error.invalidPackageDirectory": "未选择有效的驱动包目录",
    "driver.modal.error.openDirectory": "打开驱动目录失败",
    "driver.modal.error.openDirectoryWithDetail": "打开驱动目录失败：{detail}",
    "driver.modal.error.removeDriver": "移除 {name} 失败",
    "driver.modal.error.unknown": "未知错误",
    "driver.modal.success.installDriver": "{name}{version} 已安装启用",
    "driver.modal.success.localImportDriver": "{name}{version} 本地驱动包已安装启用",
    "driver.modal.success.removeDriver": "{name} 已移除",
    "driver.modal.progress.install.start": "开始安装",
    "driver.modal.progress.localImport.start": "开始导入本地驱动包",
    "driver.modal.operationLog.versionTip": "（{version}）",
    "driver.modal.operationLog.autoInstall.start": "[START] 开始自动安装",
    "driver.modal.operationLog.autoInstall.done": "[DONE] 自动安装完成 {version}",
    "driver.modal.operationLog.autoInstall.slimSkipped": "[WARN] 当前发行包为精简构建，已跳过自动安装",
    "driver.modal.operationLog.localImport.start": "[START] 开始本地导入{version}（{source}）：{path}",
    "driver.modal.operationLog.localImport.done": "[DONE] 本地导入安装完成 {version}",
    "driver.modal.operationLog.directoryImport.skipInstalled": "[SKIP] 已检测到驱动已安装，目录导入去重跳过",
    "driver.modal.operationLog.directoryImport.forceOverwrite": "[INFO] 已启用覆盖已安装模式，执行重装导入",
    "driver.modal.operationLog.directoryImport.slimSkipped": "[WARN] 当前发行包为精简构建，已跳过目录导入",
    "driver.modal.operationLog.remove.start": "[START] 开始移除驱动",
    "driver.modal.operationLog.remove.done": "[DONE] 驱动移除完成",
    "driver.modal.info.noImportableDrivers": "当前没有可导入的外置驱动",
    "driver.modal.info.noReinstallableDrivers": "当前没有需要重装的外置驱动",
    "driver.modal.info.noInstallableDrivers": "当前没有需要安装或启用的外置驱动",
    "driver.modal.info.noRemovableDrivers": "当前没有可删除的外置驱动",
    "driver.modal.batch.skip.dedupe": "去重跳过 {count}",
    "driver.modal.batch.skip.slim": "精简版跳过 {count}",
    "driver.modal.batch.skip.summary": "，{summary}",
    "driver.modal.batch.forceOverwriteTip": "（覆盖已安装）",
    "driver.modal.batch.directoryImport.success": "目录导入完成{force}：成功 {success}{skip}",
    "driver.modal.batch.directoryImport.partial": "目录导入完成{force}：成功 {success}，失败 {failed}{skip}",
    "driver.modal.batch.directoryImport.failed": "目录导入失败{force}：失败 {failed}{skip}",
    "driver.modal.batch.prepare": "准备{action}",
    "driver.modal.batch.prepareRemoveAll": "准备删除所有驱动",
    "driver.modal.batch.driverSkipped": "已跳过 {name}",
    "driver.modal.batch.driverRunning": "正在{action}：{name}",
    "driver.modal.batch.driverCompleted": "已完成 {name}",
    "driver.modal.batch.driverFailed": "失败 {name}",
    "driver.modal.batch.driverRemoving": "正在删除：{name}",
    "driver.modal.batch.driverRemoveFailed": "删除失败 {name}",
    "driver.modal.batch.actionResult.success": "{action}完成：成功 {success}{skip}",
    "driver.modal.batch.actionResult.partial": "{action}完成：成功 {success}，失败 {failed}{skip}",
    "driver.modal.batch.actionResult.failed": "{action}失败：失败 {failed}{skip}",
    "driver.modal.batch.removeAll.success": "删除所有驱动完成：成功 {success}",
    "driver.modal.batch.removeAll.partial": "删除所有驱动完成：成功 {success}，失败 {failed}",
    "driver.modal.batch.removeAll.failed": "删除所有驱动失败：失败 {failed}",
    "driver.modal.card.versionLock.reinstallSuffix": "，需重装",
    "driver.modal.card.versionLock.installedVersion": "{version}（已安装{suffix}）",
    "driver.modal.card.versionLock.installed": "已安装{suffix}",
    "driver.modal.card.mongodbVersionHint": "当前仅支持 MongoDB 1.17.x 和 2.x；更老 1.x 暂不提供安装。",
    "driver.modal.card.action.reinstall": "重装驱动",
    "driver.modal.card.action.remove": "移除",
    "driver.modal.card.action.install": "安装启用",
    "driver.modal.search.builtIn": "内置",
    "driver.modal.search.external": "外置",
    "driver.modal.search.reinstallRecommended": "强烈建议重装",
    "driver.modal.confirm.removeAll.title": "删除所有已安装外置驱动？",
    "driver.modal.confirm.removeAll.content": "将移除 {count} 个外置驱动包，后续连接对应数据源前需要重新安装。",
    "driver.modal.confirm.removeAll.ok": "删除所有",
  },
  "en-US": {
    "common.action.cancel": "Cancel",
    "common.action.save": "Save",
    "common.action.close": "Close",
    "common.action.back": "Back",
    "connection.action.test": "Test connection",
    "connection.action.viewDetails": "View details",
    "connection.status.success": "Connection successful",
    "connection.status.failure": "Connection failed",
    "connection.sidebar.group.untitled": "Untitled group",
    "connection.sidebar.group.meta": "{count} connections · Connection group",
    "connection.sidebar.group.badge": "GROUP",
    "connection.sidebar.group.edit": "Edit group",
    "connection.sidebar.group.delete": "Delete group",
    "connection.sidebar.group.deleteConfirmTitle": "Confirm deletion",
    "connection.sidebar.group.deleteConfirmContent":
      "Delete group \"{name}\"? Connections inside it will not be removed.",
    "connection.sidebar.group.expandAria": "Expand connection group {name}",
    "connection.sidebar.group.collapseAria": "Collapse connection group {name}",
    "connection.sidebar.menu.section": "Connection",
    "connection.sidebar.menu.groupSection": "Connection groups",
    "connection.sidebar.menu.copy": "Copy connection",
    "connection.sidebar.menu.disconnect": "Disconnect",
    "connection.sidebar.menu.delete": "Delete connection",
    "connection.sidebar.menu.hostFallback": "Address not configured",
    "connection.sidebar.menu.hostBadge": "HOST",
    "connection.sidebar.menu.moveToTag": "Move to tag",
    "connection.sidebar.menu.moveOutTag": "Remove from tag",
    "connection.sidebar.menu.moveToUngrouped": "Remove from group",
    "connection.sidebar.menu.createDatabase": "New database",
    "connection.sidebar.menu.refresh": "Refresh connection",
    "connection.sidebar.menu.current": "Current",
    "database.unnamed": "Unnamed Database",
    "database.label": "Database",
    "sidebar.active_connection.no_host_selected": "No host selected",
    "sidebar.modal.tag.create_title": "New group",
    "connection.sidebar.duplicate.backendUnavailable":
      "Copy connection failed: backend unavailable",
    "connection.sidebar.duplicate.noResult":
      "Copy connection failed: backend returned no result",
    "connection.sidebar.duplicate.success": "Connection copied: {name}",
    "connection.sidebar.duplicate.failureFallback":
      "Copy connection failed",
    "connection.sidebar.disconnect.success": "Disconnected",
    "connection.sidebar.delete.confirmTitle": "Confirm deletion",
    "connection.sidebar.delete.confirmContent":
      "Are you sure you want to delete connection \"{name}\"?",
    "connection.sidebar.delete.backendUnavailable":
      "Delete connection failed: backend unavailable",
    "connection.sidebar.delete.success": "Connection deleted",
    "connection.sidebar.delete.failureFallback":
      "Delete connection failed",
    "sidebar.message.jvm_provider_probe_failed_with_diagnostic":
      "JVM provider probe failed: {error}. Diagnostic enhancement entry remains available.",
    "sidebar.message.jvm_provider_probe_exception_with_diagnostic":
      "JVM provider probe exception: {error}. Diagnostic enhancement entry remains available.",
    "sidebar.error.unknown": "Unknown error",
    "sidebar.message.connection_failed": "Connection failed: {error}",
    "sidebar.message.no_visible_databases":
      "No visible databases or schemas were returned. Check account permissions or refresh from the context menu.",
    "sidebar.message.jvm_resources_backend_unavailable":
      "JVM resource browsing is not available in this build.",
    "sidebar.message.load_jvm_resources_failed":
      "Failed to load JVM resources: {error}",
    "connection.modal.title.step1": "Select connection type",
    "connection.modal.description.step1":
      "Choose a database, middleware, or file source to open the matching connection flow.",
    "connection.modal.step1.sectionTitle": "Choose data source",
    "connection.modal.step1.sectionDescription":
      "Start by selecting the target database or middleware, then continue with detailed connection settings.",
    "connection.modal.step1.group.relational": "Relational databases",
    "connection.modal.step1.group.domestic": "Domestic databases",
    "connection.modal.step1.group.timeseries": "Time-series databases",
    "connection.modal.step1.group.other": "Other",
    "connection.modal.step1.hint.jvm": "JMX / Endpoint / Agent",
    "connection.modal.step1.hint.custom": "Custom driver and DSN",
    "connection.modal.step1.hint.redis": "Single node / cluster",
    "connection.modal.step1.hint.mongodb": "Single node / replica set",
    "connection.modal.step1.hint.oceanBase": "MySQL / Oracle tenant",
    "connection.modal.step1.hint.file": "Local file connection",
    "connection.modal.step1.hint.standard":
      "Standard connection configuration",
    "connection.modal.title.create": "New {type} connection",
    "connection.modal.description.create":
      "Enter the connection settings, test connectivity, and save it to the connection tree.",
    "connection.modal.title.edit": "Edit connection",
    "connection.modal.description.edit":
      "Update the {type} connection settings, authentication, and network options.",
    "connection.modal.failureDialog.title": "Connection test failure details",
    "connection.modal.failureDialog.description":
      "Review the full error context from the latest connection test to diagnose the configuration issue.",
    "connection.modal.failureDialog.emptyLog": "No failure log available",
    "connection.modal.test.validation":
      "Connection test failed: complete the required fields before retrying.",
    "connection.modal.test.failure": "Connection test failed: {reason}",
    "connection.modal.secret.placeholder.retained":
      "•••••• (leave blank to keep the {retainedLabel})",
    "connection.modal.secret.draftReplacement":
      "A new value has been entered. It will replace the saved value when saved.",
    "connection.modal.error.savedConnectionNotFound":
      "The saved secret for this connection was not found. Enter the password again and save before retrying.",
    "connection.modal.error.secretStoreUnavailable":
      "The system secret store is unavailable. Check the keychain or credentials manager and retry.",
    "connection.modal.layoutKind.mysqlCompatible": "MySQL-compatible",
    "connection.modal.layoutKind.mongodb": "Document database",
    "connection.modal.layoutKind.redis": "Key-value database",
    "connection.modal.layoutKind.postgresCompatible": "PostgreSQL-compatible",
    "connection.modal.layoutKind.oracle": "Oracle service",
    "connection.modal.layoutKind.file": "File-based database",
    "connection.modal.layoutKind.custom": "Custom connection",
    "connection.modal.layoutKind.jvm": "JVM runtime",
    "connection.modal.layoutKind.nacos": "Nacos config center",
    "connection.modal.layoutKind.genericSql": "Standard SQL",
    "connection.modal.section.identity.title": "Connection identity",
    "connection.modal.section.identity.description":
      "Name the connection and define the basic metadata shown in the connection tree.",
    "connection.modal.section.uri.title": "Connection URI",
    "connection.modal.section.uri.description":
      "Paste a complete connection string here, or generate and parse it together with the fields below.",
    "connection.modal.section.target.title": "Target address",
    "connection.modal.section.target.description":
      "The host, port, or gateway entry point of the database service and the primary connectivity target.",
    "connection.modal.section.fileTarget.title": "Database file",
    "connection.modal.section.fileTarget.description":
      "SQLite and DuckDB use a local database file path, without ports or network tunnels.",
    "connection.modal.section.connectionMode.title": "Connection mode",
    "connection.modal.section.connectionMode.description":
      "Choose the topology mode such as single instance, primary-replica, replica set, or cluster.",
    "connection.modal.section.oceanBaseProtocol.title":
      "OceanBase protocol",
    "connection.modal.section.oceanBaseProtocol.description":
      "Explicitly choose the MySQL or Oracle tenant-compatible protocol.",
    "connection.modal.section.mongoDiscovery.title": "MongoDB discovery",
    "connection.modal.section.mongoDiscovery.description":
      "Choose between standard host:port addressing and mongodb+srv DNS discovery.",
    "connection.modal.section.replica.title": "Multi-node settings",
    "connection.modal.section.replica.description":
      "Add replica hosts, seed nodes, replica set members, or separate authentication settings.",
    "connection.modal.section.service.title": "Database service",
    "connection.modal.section.service.description":
      "Service-level routing such as the default database or Oracle Service Name.",
    "connection.modal.section.mongoPolicy.title": "MongoDB policy",
    "connection.modal.section.mongoPolicy.description":
      "MongoDB-specific policies such as auth database and read preference.",
    "connection.modal.section.credentials.title": "Credentials",
    "connection.modal.section.credentials.description":
      "Username, password, and saved-secret retention rules. Leaving it blank follows the stored-secret behavior.",
    "connection.modal.section.databaseScope.title": "Database scope",
    "connection.modal.section.databaseScope.description":
      "Limit which databases or Redis DBs appear in the connection tree after a successful connection.",
    "connection.modal.section.customDriver.title": "Custom driver",
    "connection.modal.section.customDriver.description":
      "Specify the driver name to match an installed or dynamically imported database driver.",
    "connection.modal.section.customDsn.title": "Connection string",
    "connection.modal.section.customDsn.description":
      "Enter the DSN required by the driver directly for non-built-in data sources or special parameters.",
    "connection.modal.section.jvmRuntime.title": "JVM runtime",
    "connection.modal.section.jvmRuntime.description":
      "JVM target settings, access modes, JMX, Endpoint, Agent, and diagnostic enhancements.",
    "connection.modal.uri.label": "Connection URI (copy and paste)",
    "connection.modal.uri.help":
      "Generate it from the fields, copy it to the clipboard, or paste one and parse it back into fields.",
    "connection.modal.uri.action.generate": "Generate URI",
    "connection.modal.uri.action.parse": "Parse from URI",
    "connection.modal.uri.action.copy": "Copy URI",
    "connection.modal.uri.feedback.generated": "URI generated.",
    "connection.modal.uri.feedback.generateFailed": "Failed to generate URI.",
    "connection.modal.uri.feedback.emptyInput": "Enter a URI first.",
    "connection.modal.uri.feedback.unsupported":
      "The URI does not match this data source type, or the URI format is unsupported.",
    "connection.modal.uri.feedback.parsed":
      "Connection fields filled from the URI.",
    "connection.modal.uri.feedback.parseFailed":
      "Failed to parse URI. Check the format and retry.",
    "connection.modal.uri.feedback.emptyCopy": "No URI available to copy.",
    "connection.modal.uri.feedback.copied": "URI copied.",
    "connection.modal.uri.feedback.copyFailed": "Copy failed.",
    "connection.modal.uri.stored.clear": "Clear saved URI",
    "connection.modal.uri.stored.description":
      "A saved connection URI exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.connectionParams.label": "Extra connection parameters",
    "connection.modal.connectionParams.help":
      "Use the URI/DSN query format supported by the current data source driver. Put authentication passwords in the password field above.",
    "connection.modal.filePicker.sshKeyFailure":
      "Failed to select private key file: {detail}",
    "connection.modal.filePicker.certificateFailure":
      "Failed to select certificate file: {detail}",
    "connection.modal.filePicker.databaseFailure":
      "Failed to select database file: {detail}",
    "connection.modal.error.unknown": "Unknown error",
    "connection.modal.secret.blocking.primary":
      "enter a new password before testing, or cancel clearing the saved password.",
    "connection.modal.secret.blocking.ssh":
      "enter a new SSH password before testing, or cancel clearing the saved SSH password.",
    "connection.modal.secret.blocking.proxy":
      "enter a new proxy password before testing, or cancel clearing the saved proxy password.",
    "connection.modal.secret.blocking.httpTunnel":
      "enter a new tunnel password before testing, or cancel clearing the saved tunnel password.",
    "connection.modal.secret.blocking.mysqlReplica":
      "enter a new replica password before testing, or cancel clearing the saved replica password.",
    "connection.modal.secret.blocking.mongoReplica":
      "enter a new replica set password before testing, or cancel clearing the saved replica set password.",
    "connection.modal.secret.blocking.mongoPrimary":
      "enter a new MongoDB password before testing, or enable saving the password again.",
    "connection.modal.save.backendUnavailable":
      "Failed to save connection: backend API is unavailable.",
    "connection.modal.save.updatedUnconnected":
      "Configuration updated (not connected).",
    "connection.modal.save.savedUnconnected":
      "Configuration saved (not connected).",
    "connection.modal.save.refreshWarning":
      "Configuration was saved, but the security update status has not refreshed yet. Check again later.",
    "connection.modal.save.failureFallback": "Save failed",
    "connection.modal.test.fallback.driverUnavailable": "Driver is not installed or enabled",
    "connection.modal.test.fallback.incompleteParams":
      "Connection settings are incomplete",
    "connection.modal.test.timeout":
      "Connection test timed out (>{seconds} seconds). Check network, proxy, and SSH settings, then retry.",
    "connection.modal.test.databaseListTimeout":
      "Connection succeeded, but fetching the database list timed out (>{seconds} seconds).",
    "connection.modal.test.noVisibleSchema":
      "Connection succeeded, but no visible schema was returned. Check the current account permissions or default schema settings.",
    "connection.modal.test.noVisibleDatabaseList":
      "Connection succeeded, but no visible database list was returned.",
    "connection.modal.test.databaseListFailure":
      "Connection succeeded, but fetching the database list failed: {detail}",
    "connection.modal.test.fallback.rejected":
      "Connection was rejected or the parameters are invalid. Check them and retry.",
    "connection.modal.test.fallback.validation":
      "Complete the required fields before testing the connection.",
    "connection.modal.test.fallback.unknownException": "Unknown exception",
    "connection.modal.driver.unavailableFallback":
      "{name} driver is not installed or enabled. Install it in Driver Manager first.",
    "connection.modal.driver.unavailableTitle": "{name} driver unavailable",
    "connection.modal.driver.currentFallback": "current",
    "connection.modal.driver.updateFallback":
      "{name} driver agent must be reinstalled to apply driver-side updates for this version",
    "connection.modal.typeWarning.unavailable": "{name} driver is not enabled",
    "connection.modal.config.basic.title": "Basic information",
    "connection.modal.config.basic.description":
      "Common settings are grouped on the left. Fill in the minimum fields needed to establish the connection first.",
    "connection.modal.config.basic.navDescription":
      "Name, address, authentication, URI, and database scope",
    "connection.modal.config.basic.jvmNavDescription":
      "JVM target, access modes, JMX, Endpoint, Agent, and diagnostics",
    "connection.modal.field.name.label": "Connection name",
    "connection.modal.field.environment_type.label": "Preset type",
    "connection.environment.production": "Production environment",
    "connection.environment.test": "Test environment",
    "connection.environment.development": "Development environment",
    "connection.environment.local": "Local environment",
    "sidebar.field.environment_type": "Preset group type",
    "connection.modal.field.name.placeholder.default":
      "For example: local test database",
    "connection.modal.field.name.placeholder.jvm":
      "For example: local JVM / order service JVM",
    "connection.modal.field.host.label": "Host address (Host)",
    "connection.modal.field.filePath.label": "File path (absolute path)",
    "connection.modal.field.addressPath.required": "Enter an address or path",
    "connection.modal.field.port.label": "Port (Port)",
    "connection.modal.field.port.required": "Enter the port number",
    "connection.modal.action.browse": "Browse...",
    "connection.modal.field.driver.label": "Driver Name",
    "connection.modal.field.driver.required": "Enter the driver name",
    "connection.modal.field.driver.placeholder": "For example: mysql, postgres",
    "connection.modal.field.dsn.label": "Connection string (DSN)",
    "connection.modal.field.dsn.placeholder":
      "For example: user:pass@tcp(localhost:3306)/dbname?charset=utf8",
    "connection.modal.field.dsn.clearSaved": "Clear saved DSN",
    "connection.modal.field.dsn.savedDescription":
      "A saved connection string currently exists. Leave it blank to keep using it, or enter a new value to replace it.",
    "connection.modal.field.protocol.label": "Connection protocol",
    "connection.modal.field.clickHouseProtocol.help":
      "Auto mode detects from the URI scheme and common ports. Specify HTTP/Native manually for non-standard ports.",
    "connection.modal.field.clickHouseProtocol.auto": "Auto",
    "connection.modal.field.oceanBaseProtocol.label": "OceanBase protocol",
    "connection.modal.field.oceanBaseProtocol.help.primary":
      "Choose MySQL for MySQL tenants and Oracle for Oracle tenants. GoNavi auto-selects by port: OB MySQL wire ports use OBClient capability injection (same path as Navicat), and OBProxy Oracle listener ports use standard TNS.",
    "connection.modal.field.oceanBaseProtocol.help.connectionAttributes":
      "If an Oracle tenant reports \"Error 1235\" or the OBClient handshake fails, override GoNavi's default OBClient capability injection through {attributes} in the Connection parameters field.",
    "connection.modal.field.defaultDatabase.label":
      "Default connection database",
    "connection.modal.field.defaultDatabase.help":
      "Leave blank to automatically try postgres, template1, and a database with the same name as the current user.",
    "connection.modal.field.defaultDatabase.placeholder": "For example: appdb",
    "connection.modal.field.serviceName.label": "Service Name",
    "connection.modal.field.oceanBaseServiceName.label":
      "OceanBase Oracle Service Name",
    "connection.modal.field.serviceName.required":
      "Enter the Oracle service name, for example ORCLPDB1",
    "connection.modal.field.oceanBaseServiceName.required":
      "Enter the OceanBase Oracle service name",
    "connection.modal.field.serviceName.help":
      "Enter the SERVICE_NAME registered with the listener, not the username. For example: ORCLPDB1",
    "connection.modal.field.oceanBaseServiceName.help":
      "Oracle tenants require the SERVICE_NAME registered with the listener. Keep using the OceanBase tenant format for the username.",
    "connection.modal.field.serviceName.placeholder": "For example: ORCLPDB1",
    "connection.modal.jvm.unsupportedMode.saveTest":
      "This connection contains unsupported JVM modes. Change them to JMX, Endpoint, or Agent before testing or saving.",
    "connection.modal.jvm.unsupportedTransport.saveTest":
      "This connection contains an unsupported JVM diagnostic transport. Change it to agent-bridge or arthas-tunnel before testing or saving.",
    "connection.modal.jvm.unsupportedMode.banner":
      "This connection contains unsupported JVM modes. This version supports only JMX / Endpoint / Agent. Adjust the allowed modes and preferred mode before continuing.",
    "connection.modal.jvm.unsupportedMode.alert": "Unsupported JVM mode detected",
    "connection.modal.jvm.target.title": "Target JVM",
    "connection.modal.jvm.target.description":
      "Define the host entry and basic runtime environment shown in the connection tree.",
    "connection.modal.jvm.host.label": "Host address",
    "connection.modal.jvm.host.required": "Enter the JVM host address",
    "connection.modal.jvm.port.label": "Primary port",
    "connection.modal.jvm.port.required": "Enter the JVM port number",
    "connection.modal.jvm.environment.title": "Environment",
    "connection.modal.jvm.environment.dev.label": "Development / test",
    "connection.modal.jvm.environment.dev.description":
      "Local or test environment.",
    "connection.modal.jvm.environment.staging.label": "Staging / acceptance",
    "connection.modal.jvm.environment.staging.description":
      "Pre-release validation environment.",
    "connection.modal.jvm.environment.prod.label": "Production",
    "connection.modal.jvm.environment.prod.description":
      "Production JVM, with more conservative defaults.",
    "connection.modal.jvm.securityPolicy.label": "Security policy",
    "connection.modal.jvm.readonlyPreferred": "Prefer read-only",
    "connection.modal.jvm.accessMode.title": "Access modes",
    "connection.modal.jvm.accessMode.description":
      "Select allowed JVM channels with cards. Clicking an enabled card again makes it preferred.",
    "connection.modal.jvm.accessMode.required":
      "Select at least one JVM access mode",
    "connection.modal.jvm.preferredMode.required":
      "Select the preferred JVM access mode",
    "connection.modal.jvm.tag.preferred": "Preferred",
    "connection.modal.jvm.tag.enabled": "Enabled",
    "connection.modal.jvm.tag.notEnabled": "Not enabled",
    "connection.modal.choice.current": "Current",
    "connection.modal.jvm.mode.jmx.description":
      "Standard MBean and runtime metrics such as threads, memory, and class loading.",
    "connection.modal.jvm.mode.endpoint.description":
      "Read JVM resources and configuration through the server management API.",
    "connection.modal.jvm.mode.agent.description":
      "Use GoNavi Java Agent for richer enhanced capabilities.",
    "connection.modal.jvm.mode.disable": "Disable",
    "connection.modal.jvm.mode.enablePreferred": "Enable and set preferred",
    "connection.modal.jvm.preferredSummary":
      "Current preferred: {mode}. Keep at least one access mode. If the preferred mode is disabled, another remaining mode is selected automatically.",
    "connection.modal.jvm.jmx.description":
      "Standard JVM management channel with optional host, port, and authentication overrides.",
    "connection.modal.jvm.jmx.host.label": "JMX host override",
    "connection.modal.jvm.jmx.host.placeholder": "Leave blank to use the host address",
    "connection.modal.jvm.jmx.port.label": "JMX port",
    "connection.modal.jvm.jmx.port.placeholder": "Use the primary port",
    "connection.modal.jvm.jmx.username.label": "JMX username",
    "connection.modal.jvm.jmx.username.placeholder":
      "Leave blank if authentication is disabled",
    "connection.modal.jvm.jmx.password.label": "JMX password",
    "connection.modal.jvm.jmx.password.placeholder":
      "Leave blank if authentication is disabled",
    "connection.modal.jvm.endpoint.description":
      "Connect to the JVM management endpoint exposed by the application, suitable for services that already provide operations APIs.",
    "connection.modal.jvm.endpoint.address.label": "Endpoint address",
    "connection.modal.jvm.endpoint.address.required":
      "Enter the Endpoint address when Endpoint mode is enabled",
    "connection.modal.jvm.endpoint.address.help":
      "For example, a Spring Boot Actuator or custom management API address.",
    "connection.modal.jvm.endpoint.address.placeholder":
      "For example: https://orders.internal/manage/jvm",
    "connection.modal.jvm.endpoint.apiKey.label": "Endpoint API Key",
    "connection.modal.jvm.endpoint.apiKey.placeholder":
      "Enter it when the endpoint is protected by Token validation",
    "connection.modal.jvm.agent.description":
      "Connect to the GoNavi Java Agent management port for enhanced collection and diagnostics.",
    "connection.modal.jvm.agent.address.label": "Agent address",
    "connection.modal.jvm.agent.address.required":
      "Enter the Agent address when Agent mode is enabled",
    "connection.modal.jvm.agent.address.help":
      "The target Java service must start GoNavi Agent with -javaagent.",
    "connection.modal.jvm.agent.address.placeholder":
      "For example: http://127.0.0.1:19090/gonavi/agent/jvm",
    "connection.modal.jvm.agent.apiKey.label": "Agent API Key",
    "connection.modal.jvm.agent.apiKey.placeholder":
      "Enter it when Agent enables Token validation",
    "connection.modal.jvm.diagnostic.title": "Diagnostic enhancement",
    "connection.modal.jvm.diagnostic.description":
      "Enable controlled JVM diagnostic sessions and Arthas/diagnostic commands.",
    "connection.modal.jvm.switch.on": "On",
    "connection.modal.jvm.switch.off": "Off",
    "connection.modal.jvm.diagnostic.disabledHint":
      "When disabled, only the JVM connection and monitoring capabilities are saved; the diagnostic session entry is hidden.",
    "connection.modal.jvm.diagnostic.transport.label":
      "Diagnostic transport",
    "connection.modal.jvm.diagnostic.transport.agentBridge.description":
      "Bridge diagnostic commands through GoNavi Agent.",
    "connection.modal.jvm.diagnostic.transport.arthasTunnel.description":
      "Connect to the official Tunnel / Web Console.",
    "connection.modal.jvm.diagnostic.arthasTunnelAddress.label":
      "Arthas Tunnel address",
    "connection.modal.jvm.diagnostic.bridgeAddress.label":
      "Diagnostic Bridge address",
    "connection.modal.jvm.diagnostic.arthasTunnelAddress.required":
      "Enter the Arthas Tunnel Server address",
    "connection.modal.jvm.diagnostic.bridgeAddress.required":
      "Enter the Diagnostic Bridge address",
    "connection.modal.jvm.diagnostic.arthasTunnelAddress.help":
      "For example: http://127.0.0.1:7777. Reverse-proxy path prefixes are supported.",
    "connection.modal.jvm.diagnostic.bridgeAddress.help":
      "For example: http://127.0.0.1:19091/gonavi/diag",
    "connection.modal.jvm.diagnostic.targetId.agentId.label":
      "Target instance ID (AgentId)",
    "connection.modal.jvm.diagnostic.targetId.label": "Target instance ID",
    "connection.modal.jvm.diagnostic.targetId.required":
      "Target instance ID is required in Arthas Tunnel mode",
    "connection.modal.jvm.diagnostic.targetId.arthasHelp":
      "Enter the target JVM agentId in Arthas Tunnel.",
    "connection.modal.jvm.diagnostic.targetId.bridgeHelp":
      "Optional. Used by the bridge endpoint to distinguish JVM instances.",
    "connection.modal.jvm.diagnostic.timeout.label":
      "Diagnostic timeout (seconds)",
    "connection.modal.jvm.diagnostic.timeout.range":
      "Diagnostic timeout must be between 1 and 300 seconds.",
    "connection.modal.jvm.diagnostic.apiKey.label": "Diagnostic API Key",
    "connection.modal.jvm.diagnostic.apiKey.placeholder":
      "Enter it when the diagnostic bridge enables Token validation",
    "connection.modal.jvm.diagnostic.command.observe.label":
      "Observe commands",
    "connection.modal.jvm.diagnostic.command.observe.description":
      "Read-only troubleshooting commands such as thread, dashboard, and jvm.",
    "connection.modal.jvm.diagnostic.command.trace.label": "Trace commands",
    "connection.modal.jvm.diagnostic.command.trace.description":
      "Commands such as trace and watch that add extra overhead to the target.",
    "connection.modal.jvm.diagnostic.command.mutating.label":
      "High-risk commands",
    "connection.modal.jvm.diagnostic.command.mutating.description":
      "Commands that may change runtime state or cause noticeable performance impact.",
    "connection.modal.topology.single.label": "Single node",
    "connection.modal.topology.mysql.single.description":
      "Connect only to one primary database address, suitable for local and single-instance setups.",
    "connection.modal.topology.mysql.replica.label": "Primary-replica",
    "connection.modal.topology.mysql.replica.description":
      "Prefer the primary database and configure replica addresses for failover.",
    "connection.modal.topology.mongodb.single.description":
      "Connect only to one MongoDB node.",
    "connection.modal.topology.mongodb.replica.label":
      "Replica set / multi-node",
    "connection.modal.topology.mongodb.replica.description":
      "Configure a replica set name and multiple candidate nodes.",
    "connection.modal.topology.redis.single.description":
      "Connect only to one Redis node.",
    "connection.modal.topology.redis.cluster.label": "Cluster mode",
    "connection.modal.topology.redis.cluster.description":
      "Redis Cluster with multiple seed nodes.",
    "connection.modal.field.redisHosts.label": "Additional cluster node addresses",
    "connection.modal.field.redisHosts.help":
      "Use the host address above as the primary node. Enter other seed nodes here in host:port format.",
    "connection.modal.field.mysqlReplicaHosts.label":
      "Replica host addresses",
    "connection.modal.field.mysqlReplicaHosts.help":
      "Enter multiple replica addresses in host:port format. Press Enter to confirm each one.",
    "connection.modal.field.mysqlReplicaHosts.placeholder":
      "For example: 10.10.0.12:3306, 10.10.0.13:3306",
    "connection.modal.field.mysqlReplicaUser.label": "Replica username",
    "connection.modal.field.mysqlReplicaUser.placeholder":
      "Leave blank to use the primary username",
    "connection.modal.field.mysqlReplicaPassword.label": "Replica password",
    "connection.modal.field.mysqlReplicaPassword.placeholder":
      "Leave blank to use the primary password",
    "connection.modal.field.mysqlReplicaPassword.retained":
      "saved replica password",
    "connection.modal.field.mysqlReplicaPassword.clear":
      "Clear saved replica password",
    "connection.modal.field.mysqlReplicaPassword.savedDescription":
      "A saved replica password exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.mongo.discovery.standard.label": "Standard address",
    "connection.modal.mongo.discovery.standard.description":
      "Use host:port for direct connections or replica set node lists.",
    "connection.modal.mongo.discovery.srv.label": "SRV address",
    "connection.modal.mongo.discovery.srv.description":
      "Use mongodb+srv and let DNS discover the target nodes.",
    "connection.modal.mongo.discovery.srvSshWarning":
      "When SRV and SSH tunnel are both enabled, local DNS resolution may be required.",
    "connection.modal.field.mongoHosts.label": "Additional node addresses",
    "connection.modal.field.mongoSrvHosts.label": "Additional SRV hosts",
    "connection.modal.field.mongoHosts.help":
      "Enter multiple node addresses in host:port format. Press Enter to confirm each one.",
    "connection.modal.field.mongoSrvHosts.help":
      "Enter multiple candidate host names in host format. Leave blank to use only the host above.",
    "connection.modal.field.mongoHosts.placeholder":
      "For example: 10.10.0.12:27017, 10.10.0.13:27017",
    "connection.modal.field.mongoSrvHosts.placeholder":
      "For example: cluster-a.example.com, cluster-b.example.com",
    "connection.modal.field.mongoReplicaSet.label": "Replica set name",
    "connection.modal.field.mongoReplicaSet.placeholder": "For example: rs0",
    "connection.modal.field.mongoReplicaUser.label": "Replica set username",
    "connection.modal.field.mongoReplicaUser.placeholder":
      "Leave blank to use the primary username",
    "connection.modal.field.mongoReplicaPassword.label":
      "Replica set password",
    "connection.modal.field.mongoReplicaPassword.placeholder":
      "Leave blank to use the primary password",
    "connection.modal.field.mongoReplicaPassword.retained":
      "saved replica set password",
    "connection.modal.field.mongoReplicaPassword.clear":
      "Clear saved replica set password",
    "connection.modal.field.mongoReplicaPassword.savedDescription":
      "A saved replica set password exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.mongo.discoverMembers": "Discover members",
    "connection.modal.mongo.discover.failure": "Member discovery failed",
    "connection.modal.mongo.discover.successOne": "Discovered {count} member.",
    "connection.modal.mongo.discover.successMany": "Discovered {count} members.",
    "connection.modal.mongo.member.role": "Role",
    "connection.modal.mongo.member.health": "Health",
    "connection.modal.mongo.member.healthy": "Healthy",
    "connection.modal.mongo.member.unhealthy": "Unhealthy",
    "connection.modal.field.mongoAuthSource.label":
      "Auth database (authSource)",
    "connection.modal.field.mongoAuthSource.placeholder":
      "Defaults to database or admin",
    "connection.modal.mongo.readPreference.label":
      "Read preference (readPreference)",
    "connection.modal.mongo.readPreference.primary.description":
      "Read from the primary node only.",
    "connection.modal.mongo.readPreference.primaryPreferred.description":
      "Prefer the primary node.",
    "connection.modal.mongo.readPreference.secondary.description":
      "Read from secondary nodes only.",
    "connection.modal.mongo.readPreference.secondaryPreferred.description":
      "Prefer secondary nodes.",
    "connection.modal.mongo.readPreference.nearest.description":
      "Choose the nearest node.",
    "connection.modal.mongo.authMechanism.label": "Authentication method",
    "connection.modal.mongo.authMechanism.auto.label": "Auto-negotiate",
    "connection.modal.mongo.authMechanism.auto.description":
      "Let the driver choose based on server capabilities.",
    "connection.modal.mongo.authMechanism.none.label": "No authentication",
    "connection.modal.mongo.authMechanism.none.description":
      "Do not send authentication information.",
    "connection.modal.mongo.authMechanism.scramSha1.description":
      "Compatible with older MongoDB versions.",
    "connection.modal.mongo.authMechanism.scramSha256.description":
      "Recommended SCRAM authentication.",
    "connection.modal.mongo.authMechanism.aws.description":
      "AWS IAM authentication.",
    "connection.modal.field.redisHosts.placeholder":
      "For example: 10.10.0.12:6379, 10.10.0.13:6379",
    "connection.modal.field.redisPassword.label": "Redis password",
    "connection.modal.field.redisPassword.placeholder":
      "Redis password, if requirepass is configured",
    "connection.modal.field.redisPassword.retained": "saved Redis password",
    "connection.modal.field.displayDatabases.label": "Visible databases",
    "connection.modal.field.displayDatabases.help":
      "Available after a successful connection test",
    "connection.modal.field.displayDatabases.placeholder":
      "Select visible databases",
    "connection.modal.field.displayRedisDatabases.placeholder":
      "Select visible databases (0-15)",
    "connection.modal.field.username.label": "Username",
    "connection.modal.field.username.required": "Enter the username",
    "connection.modal.field.password.label": "Password",
    "connection.modal.field.password.placeholder": "Password",
    "connection.modal.field.password.retained": "saved password",
    "connection.modal.field.savePassword": "Save password",
    "connection.modal.network.title": "Network & Security",
    "connection.modal.network.navDescription":
      "SSL, SSH, proxy, and advanced connection",
    "connection.modal.network.description":
      "Keep connection methods listed above and show the selected details below, so enabling options does not rearrange the page and the detail area has enough space.",
    "connection.modal.network.currentEditing": "Editing",
    "connection.modal.network.enabled": "Enabled",
    "connection.modal.network.notEnabled": "Not enabled",
    "connection.modal.network.ssl.description":
      "Encryption and certificate validation",
    "connection.modal.network.ssh.title": "SSH tunnel",
    "connection.modal.network.ssh.description":
      "Jump host or bastion forwarding",
    "connection.modal.network.proxy.title": "Proxy",
    "connection.modal.network.proxy.description":
      "Local proxy or gateway forwarding",
    "connection.modal.network.httpTunnel.title": "HTTP tunnel",
    "connection.modal.network.httpTunnel.description":
      "Dedicated HTTP CONNECT route",
    "connection.modal.network.ssl.panelDescription":
      "Add encryption and certificate validation controls to the connection path, suitable for production or cross-network access.",
    "connection.modal.network.ssl.disabledHint":
      "Select SSL/TLS on the left to configure mode, certificates, and validation policy here.",
    "connection.modal.network.ssl.mode": "SSL mode",
    "connection.modal.network.ssl.preferred.description":
      "Prefer SSL. If it fails, follow the driver policy.",
    "connection.modal.network.ssl.required.description":
      "Require SSL and validate certificates.",
    "connection.modal.network.ssl.skipVerify.description":
      "Require SSL but skip certificate validation.",
    "connection.modal.network.ssl.caPath": "CA certificate path",
    "connection.modal.network.ssl.serverCaPath":
      "Server certificate / CA path",
    "connection.modal.network.ssl.certPath": "Client certificate path",
    "connection.modal.network.ssl.damengCertPath":
      "Client certificate path (SSL_CERT_PATH)",
    "connection.modal.network.ssl.keyPath": "Client private key path",
    "connection.modal.network.ssl.damengKeyPath":
      "Client private key path (SSL_KEY_PATH)",
    "connection.modal.network.ssl.certRequired":
      "Dameng SSL requires a certificate path",
    "connection.modal.network.ssl.keyRequired":
      "Dameng SSL requires a private key path",
    "connection.modal.network.ssl.hint.mysqlCompatible":
      "MySQL-compatible data sources support CA certificates, client certificates, and private keys. For local self-signed certificates, try Preferred or Skip Verify first.",
    "connection.modal.network.ssl.hint.oceanBaseOracle":
      "OceanBase Oracle tenants connect through the Oracle protocol. If a Wallet is required, configure Oracle driver parameters in advanced settings.",
    "connection.modal.network.ssl.hint.dameng":
      "Dameng SSL requires client certificate and private key paths (sslCertPath / sslKeyPath).",
    "connection.modal.network.ssl.hint.sqlserver":
      "SQL Server can use a server certificate or CA file. In production, use Required and disable TrustServerCertificate.",
    "connection.modal.network.ssl.hint.mongodb":
      "MongoDB supports CA certificates, client certificates, and private keys. If certificate validation fails, use Skip Verify first to test connectivity.",
    "connection.modal.network.ssl.hint.oracle":
      "For Oracle PEM certificates, prefer Wallet and configure WALLET in advanced parameters. This section only controls SSL and validation policy.",
    "connection.modal.network.ssl.hint.tdengine":
      "TDengine currently configures WSS and validation policy only. Manage certificate files through the server trust chain.",
    "connection.modal.network.ssl.hint.default":
      "Supported drivers can configure CA certificates, client certificates, and private keys. Use Skip Verify only for tests or self-signed certificates.",
    "connection.modal.example": "For example: {value}",
    "connection.modal.example.or": "For example: {first} or {second}",
    "connection.modal.network.ssh.panelDescription":
      "Forward the database connection through a jump host or bastion, suitable for internal or restricted networks.",
    "connection.modal.network.ssh.disabledHint":
      "Select SSH tunnel on the left to enter host, port, username, password, and private key path here.",
    "connection.modal.network.ssh.host": "SSH host (domain or IP)",
    "connection.modal.network.ssh.hostRequired": "Enter the SSH host",
    "connection.modal.network.ssh.portRequired": "Enter the SSH port",
    "connection.modal.network.ssh.user": "SSH user",
    "connection.modal.network.ssh.userRequired": "Enter the SSH user",
    "connection.modal.network.ssh.password": "SSH password",
    "connection.modal.network.ssh.keyPath": "Private key path",
    "connection.modal.network.ssh.keyPathPlaceholder": "Absolute path",
    "connection.modal.network.ssh.retained": "saved SSH password",
    "connection.modal.network.ssh.clearPassword": "Clear saved SSH password",
    "connection.modal.network.ssh.savedDescription":
      "A saved SSH password exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.network.proxy.panelDescription":
      "Use a local proxy app or intermediate gateway to forward database traffic.",
    "connection.modal.network.proxy.disabledHint":
      "Select Proxy on the left to choose the proxy type and enter host, port, and authentication settings here.",
    "connection.modal.network.proxy.host": "Proxy host",
    "connection.modal.network.proxy.hostRequired": "Enter the proxy host",
    "connection.modal.network.proxy.type": "Proxy type",
    "connection.modal.network.proxy.socks5.description":
      "Common local proxy and gateway proxy.",
    "connection.modal.network.proxy.http.description":
      "Create a tunnel through HTTP CONNECT.",
    "connection.modal.network.proxy.portRequired": "Enter the proxy port",
    "connection.modal.network.proxy.user": "Proxy username",
    "connection.modal.network.proxy.password": "Proxy password",
    "connection.modal.network.proxy.noAuth":
      "Leave blank for no authentication",
    "connection.modal.network.proxy.retained": "saved proxy password",
    "connection.modal.network.proxy.clearPassword":
      "Clear saved proxy password",
    "connection.modal.network.proxy.savedDescription":
      "A saved proxy password exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.network.httpTunnel.panelDescription":
      "Mutually exclusive with proxy mode. Use this to specify a dedicated HTTP CONNECT tunnel route.",
    "connection.modal.network.httpTunnel.disabledHint":
      "Select HTTP tunnel on the left to enter the tunnel target and authentication settings here.",
    "connection.modal.network.httpTunnel.host": "Tunnel host",
    "connection.modal.network.httpTunnel.hostRequired":
      "Enter the tunnel host",
    "connection.modal.network.httpTunnel.portRequired":
      "Enter the tunnel port",
    "connection.modal.network.httpTunnel.user": "Tunnel username",
    "connection.modal.network.httpTunnel.password": "Tunnel password",
    "connection.modal.network.httpTunnel.retained": "saved tunnel password",
    "connection.modal.network.httpTunnel.clearPassword":
      "Clear saved tunnel password",
    "connection.modal.network.httpTunnel.savedDescription":
      "A saved tunnel password exists. Leave blank to keep it, or enter a new value to replace it.",
    "connection.modal.network.httpTunnel.exclusiveHint":
      "Mutually exclusive with Use proxy. When enabled, an independent tunnel is created through HTTP CONNECT.",
    "connection.modal.validation.ssl.damengRequired":
      "Certificate and private key paths are required when Dameng SSL is enabled.",
    "connection.modal.validation.ssl.clientPairRequired":
      "TLS client certificate and private key paths must be provided together.",
    "connection.modal.validation.httpTunnel.hostRequired":
      "HTTP tunnel host is required.",
    "connection.modal.validation.httpTunnel.portRange":
      "HTTP tunnel port must be between 1 and 65535.",
    "connection.modal.network.advanced.title": "Advanced connection",
    "connection.modal.network.timeout.label": "Connection timeout (seconds)",
    "connection.modal.network.timeout.help":
      "Database connection timeout. Default is 30 seconds.",
    "connection.modal.network.timeout.range":
      "Timeout must be between 1 and 300 seconds.",
    "connection.modal.network.keepAliveEnabled.checkbox":
      "Enable background keep-alive ping",
    "connection.modal.network.keepAliveEnabled.help":
      "Enable this only when a jump-host token or long-lived session needs periodic renewal.",
    "connection.modal.network.keepAliveInterval.label":
      "Keep-alive interval (minutes)",
    "connection.modal.network.keepAliveInterval.help":
      "GoNavi runs Ping or the custom keep-alive SQL on established cached connections at this interval. Default is 240 minutes.",
    "connection.modal.network.keepAliveInterval.range":
      "Keep-alive interval must be between 1 and 1440 minutes.",
    "connection.modal.network.keepAliveSQL.label": "Custom keep-alive SQL",
    "connection.modal.network.keepAliveSQL.help":
      "Leave blank to use the driver Ping. Only one SELECT/WITH statement is allowed; use a lightweight query that returns little data and a database account with read-only permissions. This value is stored in plain text with the connection; do not include credentials.",
    "connection.modal.network.keepAliveSQL.maxLength":
      "Custom keep-alive SQL cannot exceed 4096 characters.",
    "connection.modal.network.keepAliveSQL.readOnly":
      "Custom keep-alive SQL must be one SELECT or WITH statement.",
    "connection.modal.appearance.title": "Appearance",
    "connection.modal.appearance.description": "Custom icon and color",
    "connection.modal.appearance.icon": "Icon",
    "connection.modal.appearance.current": "Current: {name}",
    "connection.modal.appearance.color": "Color",
    "connection.modal.appearance.customColor": "Custom color",
    "connection.modal.appearance.preview": "Preview",
    "connection.modal.appearance.previewName": "Connection name",
    "connection.modal.appearance.reset": "Reset to default",
    "connection.modal.config.sections": "Configuration sections",
    "connection.modal.driver.unavailableAlert":
      "Current data source driver is not enabled",
    "connection.modal.driver.installAction": "Install in Driver Manager",
    "connection.modal.driver.updateAlert":
      "Driver agent reinstall is recommended for this data source",
    "connection.modal.driver.reinstallAction": "Reinstall in Driver Manager",
    "driver.guidance.localImportButton": "Import driver package",
    "driver.guidance.localImportDirectoryHelp":
      "If the in-app download chain fails, download the driver package into this directory first, then use \"Import driver package\" or \"Import driver directory\" to finish installation.",
    "driver.guidance.localImportSingleFileHelp":
      "The inline \"Import driver package\" action only accepts a single driver file or bundle (for example `mariadb-driver-agent`, `mariadb-driver-agent.exe`, `GoNavi-DriverAgents.zip`). It does not import JDBC Jar directly. Use \"Import driver directory\" above for batch import.",
    "driver.guidance.customConnectionDriverHelp":
      "Supported: mysql, starrocks, oceanbase, postgres, opengauss, sqlite, oracle, dm, kingbase, clickhouse; aliases include postgresql/pgx, open_gauss/open-gauss, dm8, kingbase8/kingbasees/kingbasev8. ClickHouse custom connections accept clickhouse://, http(s)://, jdbc:clickhouse://, or jdbc:ch:// DSNs and reuse the GoNavi ClickHouse driver-agent; no JDBC Jar is loaded. For other drivers, enter a Go database/sql driver name already registered by GoNavi, not a system ODBC/JDBC driver name.",
    "driver.modal.title": "Driver Manager",
    "driver.modal.footer.refresh": "Refresh",
    "driver.modal.footer.networkCheck": "Network check",
    "driver.modal.footer.close": "Close",
    "driver.modal.footer.background": "Run in background",
    "driver.modal.header.description.install":
      "Except for MySQL / Redis / Oracle / PostgreSQL, other data sources must be installed and enabled before connecting.",
    "driver.modal.header.description.agent":
      "Driver agents run independently. If GoNavi asks for reinstallation after an upgrade, reinstall the affected driver so the new agent logic is applied.",
    "driver.modal.stats.total": "Total",
    "driver.modal.stats.enabled": "Enabled",
    "driver.modal.stats.needsUpdate": "Reinstall needed",
    "driver.modal.stats.notEnabled": "Not enabled",
    "driver.modal.network.unreachable.downloadChain":
      "Important: driver download chain hosts are unreachable",
    "driver.modal.network.unreachable.general":
      "Important: driver download network is unreachable",
    "driver.modal.network.unreachable.description":
      "GitHub pages may still open, but driver package downloads jump to asset hosts. Enable the global proxy from the GoNavi top bar first by entering the local proxy address and port used by the proxy app.",
    "driver.modal.network.unreachable.proxyButton": "Open global proxy settings",
    "driver.modal.network.unreachable.proxyHint":
      "If it still fails, allow these hosts in the proxy rules: {hosts}. If the rules still cannot be adjusted, consider enabling TUN mode.",
    "driver.modal.network.proxyEnv.detected":
      "Detected proxy environment variables: {keys}",
    "driver.modal.network.details.label": "View network check details",
    "driver.modal.network.details.latency":
      "Proxy path to GitHub latency: {reachability}{latency}{error}",
    "driver.modal.network.details.reachable": "reachable",
    "driver.modal.network.details.unreachable": "unreachable",
    "driver.modal.network.details.noResult": "no result",
    "driver.modal.network.details.noProxyEnv": "No system proxy environment variables detected.",
    "driver.modal.network.pending.checking": "Checking driver download network...",
    "driver.modal.network.pending.idle": "Network check has not run yet",
    "driver.modal.directory.title": "Driver directory and manual import guide",
    "driver.modal.directory.description":
      "Both auto-downloaded and manually imported drivers are stored in the directory below, and downloaded drivers can be reused after later upgrades.",
    "driver.modal.directory.root": "Driver root directory: {path}",
    "driver.modal.directory.logPath": "Runtime log file: {path}",
    "driver.modal.toolbar.searchPlaceholder":
      "Search driver name/type (for example DuckDB, clickhouse)",
    "driver.modal.toolbar.forceOverwrite": "Overwrite installed",
    "driver.modal.toolbar.installAll": "Install all drivers",
    "driver.modal.toolbar.reinstallUpdates": "Reinstall outdated drivers",
    "driver.modal.toolbar.removeAll": "Remove all drivers",
    "driver.modal.toolbar.openDirectory": "Open driver directory",
    "driver.modal.toolbar.importDirectory": "Import driver directory",
    "driver.modal.batch.action.installAll": "Install all drivers",
    "driver.modal.batch.action.reinstallUpdates": "Reinstall outdated drivers",
    "driver.modal.batch.action.removeAll": "Remove all drivers",
    "driver.modal.batch.action.default": "Batch action",
    "driver.modal.batch.running": "Batch task running",
    "driver.modal.batch.processed": "Processed {completed} / {total}",
    "driver.modal.batch.success": "Success {count}",
    "driver.modal.batch.failed": "Failed {count}",
    "driver.modal.batch.skipped": "Skipped {count}",
    "driver.modal.batch.current": "Current: {name}",
    "driver.modal.summary.total": "{count} drivers total",
    "driver.modal.summary.match": "Matched {matched} / {total}",
    "driver.modal.status.refreshing": "Refreshing status...",
    "driver.modal.empty.noData": "No drivers available",
    "driver.modal.empty.noMatch": "No drivers matched \"{keyword}\"",
    "driver.modal.log.title": "Driver Logs - {name}",
    "driver.modal.log.installDir": "Installation directory: {path}",
    "driver.modal.log.executablePath": "Driver executable: {path}",
    "driver.modal.log.empty": "No operation logs for this driver.",
    "driver.modal.card.packageSize": "Size: {size}",
    "driver.modal.card.version": "Version: {version}",
    "driver.modal.card.affectedConnections": "Affects {count} saved connections",
    "driver.modal.card.needsUpdate": "Reinstall required",
    "driver.modal.card.expandReason": "Show reason",
    "driver.modal.card.expand": "Expand",
    "driver.modal.card.versionLabel": "Driver version",
    "driver.modal.card.progressLabel": "Status progress",
    "driver.modal.card.noInstallNeeded": "No installation needed",
    "driver.modal.card.versionPlaceholder.load": "Click to load versions",
    "driver.modal.card.versionPlaceholder.select": "Select driver version",
    "driver.modal.card.versionSizeCalculating": "Calculating...",
    "driver.modal.card.fullOnly": "Unavailable in slim build. Use the Full build",
    "driver.modal.card.logs": "Logs",
    "driver.modal.card.builtInUsable": "Built-in",
    "driver.modal.card.installing": "Installing {percent}%",
    "driver.modal.card.enabled": "Enabled",
    "driver.modal.card.installed": "Installed",
    "driver.modal.card.notEnabled": "Not enabled",
    "driver.modal.card.status.builtIn": "Built-in driver, ready to connect.",
    "driver.modal.card.status.runtimeAvailable": "Pure Go driver is enabled and ready to connect.",
    "driver.modal.card.status.needsUpdate":
      "Reinstall required to apply driver updates.",
    "driver.modal.card.status.installedRevision":
      "installed revision {revision}.",
    "driver.modal.card.status.expectedRevision":
      "expected revision {revision}.",
    "driver.modal.card.status.installedPending": "Installed, pending activation.",
    "driver.modal.card.status.installedPendingVersion":
      "Installed, pending activation (version: {version}).",
    "driver.modal.card.status.notEnabledVersion":
      "Not enabled (version: {version}).",
    "driver.modal.card.status.notEnabled": "Not enabled.",
    "driver.modal.punctuation.comma": ", ",
    "driver.modal.punctuation.listSeparator": ", ",
    "driver.modal.localSource.file": "file",
    "driver.modal.localSource.directory": "directory",
    "driver.modal.version.default": "Default version",
    "driver.modal.version.tip": " ({version})",
    "driver.modal.version.group.year": "{year}",
    "driver.modal.version.group.other": "Other",
    "driver.modal.network.completed": "Driver network check completed",
    "driver.modal.network.summary.reachable":
      "Driver download network check passed. Drivers can be installed directly.",
    "driver.modal.network.summary.downloadChainUnreachable":
      "GitHub API is reachable, but driver download chain hosts are unreachable.",
    "driver.modal.network.summary.unreachableProxyConfigured":
      "Some driver download addresses are unreachable. Verify the configured system proxy and retry.",
    "driver.modal.network.summary.proxyRecommended":
      "Some driver download addresses are unreachable. Configure an HTTP/HTTPS/SOCKS5 proxy before installing drivers.",
    "driver.modal.error.statusFetch": "Failed to fetch driver status",
    "driver.modal.error.statusFetchWithDetail": "Failed to fetch driver status: {detail}",
    "driver.modal.error.networkCheck": "Driver network check failed",
    "driver.modal.error.networkCheckWithDetail": "Driver network check failed: {detail}",
    "driver.modal.error.versionList": "Failed to load versions for {name}",
    "driver.modal.error.versionListLoad": "Failed to load versions for {name}: {detail}",
    "driver.modal.error.installDriver": "Failed to install {name}",
    "driver.modal.error.invalidLocalImport": "No valid local import {source} selected",
    "driver.modal.error.localImportDriver": "Failed to import local driver package for {name}",
    "driver.modal.error.selectPackageFile": "Failed to select local driver package file",
    "driver.modal.error.invalidPackageFile": "No valid driver package file selected",
    "driver.modal.error.selectPackageDirectory": "Failed to select local driver package directory",
    "driver.modal.error.invalidPackageDirectory": "No valid driver package directory selected",
    "driver.modal.error.openDirectory": "Failed to open driver directory",
    "driver.modal.error.openDirectoryWithDetail": "Failed to open driver directory: {detail}",
    "driver.modal.error.removeDriver": "Failed to remove {name}",
    "driver.modal.error.unknown": "Unknown error",
    "driver.modal.success.installDriver": "{name}{version} installed and enabled",
    "driver.modal.success.localImportDriver": "{name}{version} local driver package installed and enabled",
    "driver.modal.success.removeDriver": "{name} removed",
    "driver.modal.progress.install.start": "Starting installation",
    "driver.modal.progress.localImport.start": "Starting local driver package import",
    "driver.modal.operationLog.versionTip": " ({version})",
    "driver.modal.operationLog.autoInstall.start": "[START] Starting automatic installation",
    "driver.modal.operationLog.autoInstall.done": "[DONE] Automatic installation completed{version}",
    "driver.modal.operationLog.autoInstall.slimSkipped": "[WARN] Current release package is a slim build, skipped automatic installation",
    "driver.modal.operationLog.localImport.start": "[START] Starting local import{version} ({source}): {path}",
    "driver.modal.operationLog.localImport.done": "[DONE] Local import installation completed{version}",
    "driver.modal.operationLog.directoryImport.skipInstalled": "[SKIP] Driver is already installed, skipped duplicate directory import",
    "driver.modal.operationLog.directoryImport.forceOverwrite": "[INFO] Overwrite installed mode is enabled, running reinstall import",
    "driver.modal.operationLog.directoryImport.slimSkipped": "[WARN] Current release package is a slim build, skipped directory import",
    "driver.modal.operationLog.remove.start": "[START] Starting driver removal",
    "driver.modal.operationLog.remove.done": "[DONE] Driver removal completed",
    "driver.modal.info.noImportableDrivers": "No external drivers can be imported",
    "driver.modal.info.noReinstallableDrivers": "No external drivers need reinstallation",
    "driver.modal.info.noInstallableDrivers": "No external drivers need installation or enabling",
    "driver.modal.info.noRemovableDrivers": "No external drivers can be removed",
    "driver.modal.batch.skip.dedupe": "dedupe skipped {count}",
    "driver.modal.batch.skip.slim": "slim build skipped {count}",
    "driver.modal.batch.skip.summary": ", {summary}",
    "driver.modal.batch.forceOverwriteTip": " (overwrite installed)",
    "driver.modal.batch.directoryImport.success": "Directory import completed{force}: success {success}{skip}",
    "driver.modal.batch.directoryImport.partial": "Directory import completed{force}: success {success}, failed {failed}{skip}",
    "driver.modal.batch.directoryImport.failed": "Directory import failed{force}: failed {failed}{skip}",
    "driver.modal.batch.prepare": "Preparing {action}",
    "driver.modal.batch.prepareRemoveAll": "Preparing to remove all drivers",
    "driver.modal.batch.driverSkipped": "Skipped {name}",
    "driver.modal.batch.driverRunning": "Running {action}: {name}",
    "driver.modal.batch.driverCompleted": "Completed {name}",
    "driver.modal.batch.driverFailed": "Failed {name}",
    "driver.modal.batch.driverRemoving": "Removing: {name}",
    "driver.modal.batch.driverRemoveFailed": "Remove failed {name}",
    "driver.modal.batch.actionResult.success": "{action} completed: success {success}{skip}",
    "driver.modal.batch.actionResult.partial": "{action} completed: success {success}, failed {failed}{skip}",
    "driver.modal.batch.actionResult.failed": "{action} failed: failed {failed}{skip}",
    "driver.modal.batch.removeAll.success": "Remove all drivers completed: success {success}",
    "driver.modal.batch.removeAll.partial": "Remove all drivers completed: success {success}, failed {failed}",
    "driver.modal.batch.removeAll.failed": "Remove all drivers failed: failed {failed}",
    "driver.modal.card.versionLock.reinstallSuffix": ", reinstall needed",
    "driver.modal.card.versionLock.installedVersion": "{version} (installed{suffix})",
    "driver.modal.card.versionLock.installed": "Installed{suffix}",
    "driver.modal.card.mongodbVersionHint": "Only MongoDB 1.17.x and 2.x are supported. Older 1.x releases are not available for installation.",
    "driver.modal.card.action.reinstall": "Reinstall driver",
    "driver.modal.card.action.remove": "Remove",
    "driver.modal.card.action.install": "Install and enable",
    "driver.modal.search.builtIn": "built-in",
    "driver.modal.search.external": "external",
    "driver.modal.search.reinstallRecommended": "reinstallation strongly recommended",
    "driver.modal.confirm.removeAll.title": "Remove all installed external drivers?",
    "driver.modal.confirm.removeAll.content": "This will remove {count} external driver packages. They must be reinstalled before connecting to the corresponding data sources again.",
    "driver.modal.confirm.removeAll.ok": "Remove all",
  },
};
