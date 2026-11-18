# GoNavi Go 编码手册

Java 小工具跟《阿里巴巴 Java 开发手册》。**Go 不套那本手册**（没有 package、error、goroutine、interface 这套模型）。

GoNavi Go 的专属底本，按冲突时的优先级：

1. **本手册的 GoNavi 叠加条款**（Wails 绑定、驱动、i18n、拆分限额）
2. [Uber Go Style Guide](https://github.com/uber-go/guide/blob/master/style.md)
3. [Google Go Style Guide](https://google.github.io/styleguide/go/) 与 [Code Review Comments](https://go.dev/wiki/CodeReviewComments)
4. [Effective Go](https://go.dev/doc/effective_go)

标记：**【强制】** 必须执行；**【推荐】** 默认执行；**【参考】** 有充分理由才可偏离。  
范围：仓库内自有 Go 代码。`third_party/`、生成代码、`frontend/wailsjs` 生成绑定除外。

AI 入口：`AGENTS.md`、`CLAUDE.md`、`.cursor/rules/gonavi-go.mdc` 均指向本文件，不要另写一套。

---

## 1. 包、目录、文件

**【强制】**

1. 包名：全小写、单数、短、不含下划线/驼峰。用 `db`、`app`、`sqlaudit`，不用 `db_utils`、`common`、`util` 当垃圾桶包。
2. 包名不要和导出类型抢词：`package redis` + `type Client`，不要 `package redis` + `type RedisClient`（已有历史名保持兼容，**新增禁止口吃**）。
3. 标准布局：
   - `internal/app`：Wails/`App` 绑定，保持薄
   - `internal/db`：`Database` 契约与 `*_impl.go` 驱动
   - `internal/connection`：跨层 DTO（含 `QueryResult`）
   - 其余领域包：`internal/ai`、`internal/sync`、`internal/logger`、`internal/sqlaudit` 等
4. 文件命名：`methods_<领域>.go`、`<引擎>_impl.go`、`<主题>_<平台>.go`。平台后缀只用 `windows` / `darwin` / `linux` / `stub` / `nonwindows` 这类已有约定。
5. 一个文件一个主题。新建生产文件建议 ≤400 行、硬上限 800 行；函数体建议 ≤80 行、硬上限 120 行。
6. 禁止继续膨胀：`internal/app/methods_file.go`、`methods_db.go`、`app.go`。新逻辑进新文件，旧文件只接线。

**【推荐】** 驱动过大时按 catalog / query / exec / ssh / ddl 拆文件，**包名仍为 `db`**，不要为拆文件新建循环依赖包。

---

## 2. 命名

**【强制】**

1. 导出用 MixedCaps，未导出用 mixedCaps。缩写保持惯用大小写：`HTTP`、`URL`、`ID`、`JSON`、`SQL`、`SSH`、`DSN`、`TTL`（`httpURL` 不是 `httpUrl`）。
2. 接收者短、一致：`func (a *App)`、`func (m *MySQLDB)`，全文件同一类型不要混用 `this`/`self`。
3. Getter 不加 `Get`：`func (c Config) Timeout()`，不是 `GetTimeout()`。Wails 已有 `DBGetTables` 这类对外 RPC 名**保持不变**；内部新 API 不要再造 `GetXxx`。
4. 错误变量 `errXxx`；哨兵错误 `var ErrXxx = errors.New(...)`。
5. 测试：`TestXxx`、`BenchmarkXxx`、`ExampleXxx`。表驱动用例名能说明场景。

**【推荐】** 布尔 `ok`/`found`/`enabled`；避免 `data`、`info`、`tmp`、`handle` 当公共名。

---

## 3. 错误处理

**【强制】**

1. 领域层用 `error`，禁止用 panic 当控制流。`internal/app`、`internal/db` 禁止 `panic`（测试里的 `t.Fatal` 除外）。
2. 只包装一次语义：`fmt.Errorf("connect mysql: %w", err)`。能判定用 `errors.Is` / `errors.As`，禁止字符串匹配 errno。
3. 禁止 `_ = err`、`err.Error()` 后丢类型、空 `if err != nil {}`。
4. 错误字符串：小写开头、不以标点结尾（Go 惯例）。**给 UI 的句子**不要当 `error` 原文；走 i18n 后放进 `QueryResult.Message`。
5. Wails 绑定边界：返回 `connection.QueryResult`。失败：`Success: false` + 可展示 `Message`。不要把未包装的 `error` 丢给前端。
6. 失败时先 `logger.Error(err, ...)`（可带 `formatConnSummary`），再返回。摘要不得含密码、token、完整 DSN。

```go
// ❌
rows, _ := inst.Query(q)
return fmt.Sprintf("%v", rows)

// ✅
data, fields, err := a.runQuery(ctx, config, q)
if err != nil {
    logger.Error(err, "DBQuery failed: %s", formatConnSummary(config))
    return connection.QueryResult{
        Success: false,
        Message: a.appText("db.backend.error.query_failed", map[string]any{"detail": err.Error()}),
    }
}
return connection.QueryResult{Success: true, Data: data, Fields: fields}
```

**【推荐】** 同一错误不要既 log 又 wrap 三次。绑定层 log 一次即可；内部 helper 只返回 `error`。

---

## 4. Context

**【强制】**

1. `context.Context` 必须是第一个参数，变量名 `ctx`。禁止塞进结构体长期存放（请求级 ctx 除外，且生命周期随请求结束）。
2. 查询、元数据、HTTP、驱动 agent 必须把取消传到最底层（`QueryContext`、http.Request、gRPC）。见 `BindMetadataContext` / `metadataContextFor`。忽略 ctx 会导致取消失效、连接与 goroutine 泄漏。
3. 连接超时与查询超时分开：建连 deadline ≠ 查询 deadline（见 `newQueryExecutionContextWithParent`）。
4. 禁止 `context.Background()` 冒充用户请求；只有进程级后台任务才用 Background，且必须有停止条件。
5. 不要用 `context.WithValue` 传可选业务参数（连接配置、logger）。Value 仅限请求追踪等横切 ident。

---

## 5. 接口与实现

**【强制】**

1. 接口由消费方定义，小而精。本仓库公共数据源契约是 `db.Database`；**特有能力用可选接口**（`TableExistsChecker`、`ElasticsearchConsoleExecutor`），禁止把所有驱动方法塞进 `Database`。
2. 用编译期断言锁定实现：`var _ db.Database = (*MySQLDB)(nil)`。
3. 接受接口、返回结构体。绑定层不要为了“好 mock”返回巨大 interface。
4. 不要为单实现去抽象。第二个实现出现再抽接口。
5. 指针是否实现接口以方法集为准；不要无意义地一律 `*T`。

**【推荐】** 可选接口类型断言失败时走已有慢路径或明确错误，不要静默当成功。

---

## 6. 结构体、零值、拷贝

**【强制】**

1. 结构体字面量：有多个字段时用 keyed fields。
2. Mutex 不要拷贝。`sync.Mutex` / `sync.WaitGroup` 放结构体里用指针传递，或 Mutex 放在拷贝不到的位置。
3. 含 `sync.Mutex`、`sql.DB`、连接句柄的类型禁止值拷贝；方法用指针接收者。
4. Slice / map 作为返回值时，调用方视为只读或自行拷贝；内部复用 buffer 必须写明，禁止把共享 backing array 漏出后再改。
5. 不要用嵌入来“继承”行为。嵌入只为真正的 is-a 或样板转发，且不嵌入会泄漏未导出互斥量的类型。

**【推荐】** 零值可用（`var mu sync.Mutex`、`var sb strings.Builder`）。构造函数只在零值不安全时才需要。

---

## 7. 控制流与函数

**【强制】**

1. 提前返回，减少嵌套。`if err != nil { return }` 优先于 `else`。
2. 禁止无意义 `else`：if 分支已 return 时不要 else。
3. 函数只做一件事。超过 120 行必须拆；绑定方法超过 80 行优先抽未导出 helper。
4. 避免裸参数：`copyRange(start, end, true /* inclusive */)` 应改成 `copyRange(Range{...})` 或具名常量。
5. 不要用命名返回值来回避 `err` 处理；仅在能明显提升文档性时使用，并避免 `naked return` 与阴影 `err`。

**【推荐】** 声明靠近使用；`if v, err := f(); err != nil` 缩小作用域。

---

## 8. 并发

**【强制】**

1. 不 fire-and-forget。每个 goroutine 必须有退出条件（`ctx.Done()`、`WaitGroup`、生命周期跟 `App`/连接绑定）。
2. Channel 默认无缓冲。有缓冲必须注释容量为什么是那个数。
3. 不要用 channel 当互斥锁。共享状态用 `sync.Mutex`。
4. 锁粒度小；禁止在持锁时做网络 IO、跑用户 SQL、调前端事件。
5. 禁止在持锁时再调可能抢同一把锁的公开方法（自死锁）。
6. `time.After` 在循环里会泄漏 timer；用 `time.NewTimer` 并 `Stop`。
7. 竞态用 `go test -race` 能覆盖的路径必须可测；共享 map 必须有锁或改为 sync.Map（仅适合读多写少的缓存）。

**【推荐】** 启动 goroutine 的函数负责等待或登记到已有 supervisor（连接池、keep-alive、sync job）。

---

## 9. Slice、Map、性能

**【强制】**

1. 预先知道长度时 `make([]T, 0, n)` / `make(map[K]V, n)`。
2. 不要用 `append` 到可能共享的 slice 再当新所有权，除非已 `copy` 或证明 cap 独占。
3. 比较切片用 `bytes.Equal` / `slices.Equal`，不要用 `reflect.DeepEqual` 当热路径。
4. 热路径避免无界拼接 SQL 字符串导致内存暴涨；大结果集遵守现有截断字段（`Truncated`、`maxRemoteJSONResponseBytes`）。

**【推荐】** 不必微优化普通元数据路径。先正确，再对 benchmark 证明过的热点动手。

---

## 10. 日志、敏感信息、i18n

**【强制】**

1. 只用 `internal/logger`，不要 `log.Printf` / `fmt.Println` 打运行日志。
2. 禁止输出：密码、密钥、token、私钥、完整 DSN、Authorization 头。连接日志用 `formatConnSummary` 这类已脱敏摘要。SSH 进度事件不含敏感字段，新事件照做。
3. 用户可见文案：`a.appText` / `localizer.T("key", params)`，键在 `shared/i18n`。绑定层不要写死中英文句子（测试夹具除外）。
4. 日志可以中英混合，但必须无密钥、可检索（方法名 + 结果 + 摘要）。
5. 运行日志必须能独立看清「**场景 + 操作 + 结果**」；失败日志再补充「**失败阶段 + 初步判断 + 建议**」。禁止只写「失败」「验证失败」「发生错误」这类无法定位的句子。
6. 级别语义：`INFO` 记录用户动作和状态变化；`DEBUG` 记录内部准备步骤与诊断细节；`WARN` 记录可恢复的重试、冷却或降级；`ERROR` 记录最终失败或需要用户处理的异常。

```text
❌ 建立数据库连接失败：类型=mysql 地址=...
✅ 建立数据库连接失败：场景=建立新连接 | 操作=连接数据库 | 结果=失败 |
   失败阶段=TCP建连 | 初步判断=目标地址和端口在超时时间内未完成TCP连接 |
   建议=检查地址和端口是否可达，以及防火墙、VPN、代理或隧道配置 |
   类型=mysql 网络方式=TCP直连 地址=... 缓存Key=...
```

---

## 11. 测试

**【强制】**

1. 文件 `xxx_test.go`，与实现同包（需测未导出行为时）。
2. 表驱动：`t.Run(name, func(t *testing.T) { ... })`。
3. 禁止单测打真实生产库、真实收费 API。外部依赖用 fake / httptest / 接口 stub。
4. 断言失败用 `t.Fatal` / `t.Fatalf`（后续无效）或 `t.Error`（还可继续）。不要 `panic`。
5. 测试文件建议按场景拆分；不要往已经数千行的 `*_test.go` 继续堆。
6. 抽出来的纯函数必须带单测。

**【推荐】** 用 `t.Helper()`；时间用 fake clock 或短 timeout；并发测试加 `-race`。

---

## 12. 注释与导出文档

**【强制】**

1. 所有导出类型、函数、常量必须有注释，且以名字开头：`// Database 定义统一数据源访问接口。`
2. 注释写为什么，不写把代码念一遍。复杂取消契约、JSON 兼容、平台差异必须写（参考 `BindMetadataContext`）。
3. 不要注释掉大段死代码提交。用 git。

**【推荐】** 包注释放 `doc.go` 或该包主文件顶部。

---

## 13. GoNavi 叠加：Wails 与驱动

**【强制】**

1. `App` 导出方法只做：校验、只读/生产风险策略、调领域包、收成 `QueryResult`（或既有 DTO）。禁止在绑定层写驱动 SQL、拼协议、做 UI 逻辑。
2. 不随意改导出方法名、参数、`QueryResult` JSON 字段。前端、MCP、Web RPC 共用契约。
3. 新驱动：实现 `db.Database` + 需要的可选接口，在工厂注册；lite/full 构建走现有 `database_optional_factories_*.go`，不要破坏 lite 构建标签。
4. SQL 走驱动实现；审计、脱敏走 `internal/sqlaudit`，不得绕过。
5. 资源成对：`Connect`/`Close`、forwarder、`sql.Rows` 必须 `Close`。`defer` 用于清理。
6. 不要引入新的全局可变单例；连接缓存放在 `App` 已有结构里，注意锁与 ping 周期。

---

## 14. 导入、格式、依赖

**【强制】**

1. `gofmt` / `goimports` 后的格式才可提交。import 分组：标准库 / 内部 `GoNavi-Wails/...` / 第三方。
2. 禁止不用的导入、未使用变量。
3. 新增依赖必须有明确理由；不要为一点字符串功能拉重量库。
4. 不要手改 `frontend/wailsjs` 里由 Wails 生成的 Go 绑定 TS。
