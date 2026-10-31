# 数据库作业对象支持

本功能包含**对象浏览和原生作业管理**。作业定义页与对象右键菜单可打开管理面板，
作业组右键可新建；MySQL/MariaDB 继续使用既有的事件入口，不重复建立作业组。

管理面板提供新建、编辑、启用/暂停、立即执行、停止、删除、状态与运行记录，
**按各引擎真实支持的操作开放**。新建填写基本参数后生成 SQL；编辑基于最新目录信息生成
可修改的原生 SQL，并提供步骤、调度、例外日期和参数等操作模板。此交互是 SQL 编辑器，
不是所有引擎属性的可视化表单设计器。不自动安装插件或启动服务器调度服务，
也不把直接执行作业正文、删除重建或修改共享对象冒充原生管理操作。

## 已接入的查询适配器

| 数据源 | 机制 | 入口和范围 | 前提及限制 |
| --- | --- | --- | --- |
| Oracle | DBMS_SCHEDULER、DBMS_JOB | schema 下的作业 | 遵循目录可见性；解析关联程序、调度 |
| 达梦 | SYSJOB 作业代理、兼容 DBMS_JOB | schema 下的作业 | 系统表不可读时尝试同所有者的 USER_*_VIEW；不初始化作业环境 |
| SQL Server | SQL Server Agent | **msdb** 下的作业 | 实例级目录；显示步骤、跳转、重试及调度原始字段；不重复挂入每个业务库 |
| PostgreSQL、TimescaleDB | pg_cron、pgAgent | **插件安装所在数据库**下的作业 | 先探测表是否存在；不把执行目标数据库误当作目录所在库；未安装不显示虚假的空作业组 |
| KingbaseES | KDB_SCHEDULE | 当前数据库下的作业 | 兼容视图建在 `kdb_schedule` 扩展 schema 下、`search_path` 不含它，故所有引用都带 `kdb_schedule.` 前缀（探测同时兼容旧部署的无前缀写法）；只在 Oracle 兼容模式存在，PG/MySQL 兼容模式仅有 `kdb_schedule.kdb_schedule` 视图、按不可用处理；owner 可能为空，因此不套用 Oracle 所有者过滤；关联程序/调度读取失败保留主体并警告 |
| openGauss | PG_JOB、PG_JOB_PROC | 当前数据库下的作业 | dbname 使用 current_database() 过滤；较旧版本缺少命名/enable 字段时降级读取基本字段 |
| GaussDB | PG_JOB、PG_JOB_PROC | 当前数据库下的作业 | 同上，独立来源标识；需要目录读取权限 |
| OceanBase Oracle 模式 | DBA_SCHEDULER_JOBS | schema 下的作业 | 独立 SQL，不能按 Oracle 方言直接复用；旧版不公开执行内容时明确显示部分定义提示 |
| OceanBase MySQL 模式 | oceanbase.DBA_SCHEDULER_JOBS | 所选数据库下的**租户级**作业 | 不按业务库过滤 OWNER；定义按目录返回的 OWNER 和 JOB_NAME 精确查询 |
| Doris | JOBS('type'='insert') | 所选数据库下的**集群级**作业 | Doris 2.1+；需对应目录权限；当前为 INSERT 作业，不包含其他专用后台任务 |
| StarRocks | information_schema.tasks | 当前数据库下的任务，归入作业组 | 包含目录中可见的任务；周期任务需支持 SCHEDULE 的版本（3.3+） |
| MySQL、MariaDB | Event Scheduler | 既有**事件**入口 | 沿用事件列表与定义，不另建重复的作业组；查看事件不等于开启 Event Scheduler |

这些是**代码适配范围，不是所有版本/实库已验收的声明**。数据库版本、插件位置和目录权限仍影响可用性。
数据库未公开的字段不推断、不伪造；权限/版本查询失败与“插件未安装”分开处理。

达梦先通过 `SYS.ALL_OBJECTS` 探测当前账号可见的 `SYSJOB` 作业目录。兼容 DBMS_JOB
使用 `SYSJOB.DBA_JOBS`，读取失败时回退到 `SYSJOB.USER_JOBS`，列表、定义和管理快照
均保留请求的所有者过滤。未初始化或没有可见目录时跳过对应来源；探测或查询明确返回的
权限、网络和 SQL 错误继续提示，不自动执行 `SP_INIT_JOB_SYS` 或修改数据库环境。
管理面板的状态查询沿用快照读取成功时的目录或字段变体，避免回退成功后又重新执行
不可读的首选目录或旧版本不支持的字段查询。

## 原生管理能力

所有来源均提供状态/属性查询。下表的“不提供”表示不虚构未核实的原生 API；UI 显示禁用项及原因。

| 来源 | 写入操作 | 编辑与运行边界 |
| --- | --- | --- |
| Oracle DBMS_SCHEDULER | 新建、编辑、启停、运行、停止、删除 | 属性/参数模板；保留共享 program/schedule 引用；运行记录 |
| Oracle/达梦 DBMS_JOB | 新建、编辑、启停、运行、删除 | WHAT/INTERVAL/NEXT_DATE；不提供停止或不存在的统一历史接口 |
| 达梦作业代理 | 新建、编辑、启停、运行、停止、删除 | 步骤/调度增删改、重命名、通知设置；配置在单次驱动请求内提交；运行记录 |
| SQL Server Agent | 新建、编辑、启停、运行、停止、删除 | 步骤/调度增删改；检查存储过程返回码；共享调度保护；运行记录 |
| pg_cron | 新建、编辑、启停、删除 | 调度、正文、目标库；不伪造 Run now；运行记录 |
| pgAgent | 新建、编辑、启停、请求运行、删除 | 步骤/调度/例外日期模板；不重建连接字符串；不提供原生停止；运行记录 |
| Kingbase KDB_SCHEDULE | 引用已有 program/schedule 新建、启停、运行、删除 | 未核实公开 ALTER/STOP API，不生成替代写法；运行记录 |
| openGauss / GaussDB | 新建、编辑、启停、删除 | 分别使用 PKG_SERVICE / DBE_TASK；不提供未核实的立即运行/停止/统一历史 |
| OceanBase Oracle | 新建、有限属性编辑、启停、运行、停止、删除 | 独立适配租户原生名称；SET_ATTRIBUTE 仅限引擎公开的属性，不能按 Oracle 任意编辑正文/调度；运行记录 |
| OceanBase MySQL | 有限属性编辑、启停 | 仅使用公开的 ENABLE / DISABLE / SET_ATTRIBUTE 包接口 |
| Doris INSERT 作业 | 新建、暂停、恢复、删除 | 不套用 Streaming Job 的 ALTER JOB，不支持原地改正文；运行记录 |
| StarRocks | 新建、删除；4.1+ 属性编辑、暂停、恢复 | 用 current_version() 检测版本；ALTER TASK 仅改 properties/状态，不改正文/调度；运行记录 |
| MySQL/MariaDB Event | 新建、编辑、启停、删除 | 从 SHOW CREATE 保留精确 DEFINER；不模拟立即执行/停止/历史，不切换全局 Event Scheduler |

新建尽量默认禁用。openGauss/GaussDB、Doris、StarRocks 的原生行为在界面中单独警告；
达梦配置过程可能隐式提交，失败后要求检查真实状态，不宣称跨所有引擎原子回滚。

## 待接入

用户已确认：**Db2 和 Snowflake 先列为待接入驱动**。
仓库尚无这两种连接驱动，不能把 SQL 模板或静态能力开关当作可用支持；后续应先完成连接和查询链路，再接入 Db2 Administrative Task Scheduler / Snowflake Tasks。

## 身份和安全边界

- 作业节点和标签页身份包含连接、数据库、来源、所有者及原生名称/ID。
- ID 型目录保留字符串 ID，不用显示名作为身份；pg_cron 与 pgAgent 的同名同 ID 作业也能区分。
- 数据库/实例级作业挂在数据库根部，不创建假的 schema；定位、刷新和会话恢复使用相同范围。
- 状态/历史走 DBQuery；所有管理写入统一走 DBQueryAudited，审计来源为 `database_jobs`。
- 管理写入同时检查旧版 readOnly 和四项连接保护，前后端双层拦截；执行前有普通确认和既有生产风险确认。
- MySQL/MariaDB 修改事件时检查当前会话 SQL_MODE/时区与事件一致，避免改变原有 SQL 语义或调度时间；不在连接池里遗留临时 SET SESSION。
- 确认后重新核对连接配置；编辑重新读取元数据、核对生成基线。此检查不是数据库事务锁，不保证排除核对之后发生的外部变更。
- 不从读取失败或缺失关键字段的元数据生成编辑；未替换的模板占位符阻止提交。切换/关闭已修改 SQL 时确认放弃。
- 写入发出后不自动重试，未知结果提示检查实际状态。所有 `database_jobs` 写入（包括用户编辑的 SELECT）禁用只读重连重试路径。
- cron/DBMS_SCHEDULER/DBMS_JOB/DBE_TASK/PKG_SERVICE 等 SELECT 调用按副作用识别，不能因 SELECT 外壳绕过只读保护。
- pgAgent 步骤只读取需要的列，不读取可能包含密码的 `jstconnstr`。
- OceanBase MySQL / StarRocks 名称使用 HEX 比较，避免依赖反斜杠字符串转义模式。
- 显式识别引擎及自定义驱动别名，不因为借用 MySQL/PostgreSQL/Oracle 方言就声明调度能力。

## 验证记录（2026-10-14）

- 新增查询、探测、名称转义、版本降级、部分失败、定义展示、标签恢复和定位测试。
- 26 个相关测试文件、398 项测试通过；不代表完整测试套件通过。
- Go 作业保护、审计来源、直连查询防绕过与既有 DBQueryAudited 相关测试通过。
- TypeScript 检查、Vite 生产构建及 Brotli 打包通过；构建仍有分块体积警告。
- 覆盖数据库根部作业与 schema 懒加载共存；刷新重新探测插件，不会在读取作业时自动安装扩展。
- PostgreSQL 实库：只读探测成功，当前 `postgres` 数据库没有 pg_cron / pgAgent 目录；这只证明缺失插件检测，不证明真实作业读取。
- Kingbase 实库：连接建立后的验证被远端关闭，未执行成功元数据查询；未修改连接、TLS 或服务器配置。
- 其他数据库没有对应可用实例，真实作业列表、定义及跨版本验收未运行。
- 浏览器 Mock RPC：作业浏览原有路径已验证；管理面板补验 pg_cron 新建/编辑、取消确认不写入、确认禁用仅一次审计 RPC、运行记录、只读连接禁写，以及 SQL Server 步骤/调度编辑与 MySQL 事件编辑。
- 本次管理能力未进行真实数据库新建/修改/执行/删除验收，不对保存的真实连接执行试验性写入。
- Mock RPC 浏览器与单测不能替代原生 Wails/实库验收。

## 官方依据

- PostgreSQL pg_cron：https://github.com/citusdata/pg_cron
- pgAgent 目录定义：https://github.com/pgadmin-org/pgagent/blob/master/sql/pgagent.sql
- SQL Server Agent：https://learn.microsoft.com/en-us/ssms/agent/sql-server-agent
- Kingbase KDB_SCHEDULE：https://help.kingbase.com.cn/v8/admin/reference/ref-extended-plug-in/kdb_schedule.html
- openGauss PG_JOB / PG_JOB_PROC：openGauss 官方《数据库参考》系统表章节。
- GaussDB PG_JOB / PG_JOB_PROC：华为云官方《GaussDB SQL 参考》系统表章节。
- OceanBase DBA_SCHEDULER_JOBS / DBA_SCHEDULER_PROGRAM：OceanBase 官方文档对应租户模式、版本的系统视图章节。
- 目录字段复核：OceanBase 官方仓库 `src/share/inner_table/ob_inner_table_schema.28101_28150.cpp`、`ob_inner_table_schema.21251_21300.cpp`；openGauss 官方仓库 `src/include/catalog/pg_job.h`、`pg_job_proc.h`。
- Doris JOBS：https://doris.apache.org/docs/3.x/sql-manual/sql-functions/table-valued-functions/jobs/
- StarRocks TASKS：https://docs.starrocks.io/docs/sql-reference/information_schema/tasks/
- Oracle DBMS_SCHEDULER：https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_SCHEDULER.html
- 达梦作业管理：https://eco.dameng.com/document/dm/zh-cn/pm/job.html
- 达梦作业巡检目录：https://eco.dameng.com/document/dm/zh-cn/ops/check-instance
- 达梦 DBMS_JOB 视图与初始化边界：https://eco.dameng.com/document/dm/zh-cn/pm/dbms_job-package.html
- openGauss PKG_SERVICE：https://docs.opengauss.org/en/docs/7.0.0-RC2/docs/SQLReference/pkg_service.html
- OceanBase 包与实现：官方仓库 `src/share/inner_table/sys_package/dbms_scheduler_mysql.sql`、`src/pl/sys_package/ob_dbms_scheduler.cpp`、`src/observer/dbms_scheduler/ob_dbms_sched_job_utils.cpp`。
- StarRocks ALTER TASK：官方仓库 `docs/en/sql-reference/sql-statements/loading_unloading/ETL/ALTER_TASK.md`、`fe/fe-grammar/src/main/antlr/com/starrocks/grammar/StarRocks.g4`。
- Doris INSERT 与 Streaming Job 区分：官方 doris-website 仓库 `docs/sql-manual/sql-statements/job/`。
- MySQL ALTER EVENT：https://dev.mysql.com/doc/refman/8.4/en/alter-event.html
