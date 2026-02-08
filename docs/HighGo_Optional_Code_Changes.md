# HighGo 可选代码优化建议

## 一、sslmode 配置优化

### 当前状态

**文件**：`internal/db/highgo_impl.go:43`

**当前代码**：
```go
q.Set("sslmode", "disable")
```

### 建议修改

根据瀚高官方文档，sslmode 的默认值应该是 `require`。建议修改为：

```go
q.Set("sslmode", "require")
```

### 修改原因

1. **符合官方规范**：瀚高官方文档明确指出默认 sslmode 为 `require`
2. **安全性提升**：启用 SSL 加密可以保护数据传输安全
3. **生产环境最佳实践**：生产环境应该启用 SSL 连接

### 是否需要修改？

**不一定需要修改**，取决于您的实际环境：

#### 保持 `disable` 的场景：
- ✅ 开发/测试环境
- ✅ HighGo 服务器未配置 SSL 证书
- ✅ 内网环境，不需要加密传输
- ✅ 快速测试连接功能

#### 修改为 `require` 的场景：
- ✅ 生产环境
- ✅ HighGo 服务器已配置 SSL 证书
- ✅ 跨网络连接，需要加密保护
- ✅ 符合安全合规要求

### 如何修改

如果您决定修改，可以使用以下命令：

**方式 1：直接修改（固定为 require）**
```go
// 文件：internal/db/highgo_impl.go 第 43 行
q.Set("sslmode", "require")
```

**方式 2：可配置（推荐）**

如果希望让用户可以选择 sslmode，可以修改为：

```go
// 在 getDSN 方法中
sslmode := "disable" // 默认值
if config.SSLMode != "" {
    sslmode = config.SSLMode
}
q.Set("sslmode", sslmode)
```

然后在 `internal/connection/connection.go` 的 `ConnectionConfig` 结构体中添加字段：

```go
type ConnectionConfig struct {
    // ... 现有字段
    SSLMode string `json:"sslMode,omitempty"` // SSL 模式：disable, require, verify-ca, verify-full
}
```

前端 UI 也需要相应添加 sslmode 选择控件。

### 测试建议

修改后请务必测试：

1. **SSL 启用测试**：
   - 连接配置了 SSL 的 HighGo 服务器
   - 验证连接成功

2. **SSL 禁用测试**：
   - 连接未配置 SSL 的 HighGo 服务器
   - 验证是否会报错（如果设置为 `require` 会报错）

3. **兼容性测试**：
   - 测试现有的 HighGo 连接配置是否仍然可用

## 二、其他可选优化

### 1. 默认端口提示优化

**文件**：`frontend/src/components/ConnectionModal.tsx`

**当前状态**：HighGo 的默认端口已正确设置为 5866

**建议**：无需修改，已符合官方规范

### 2. 默认数据库名称

**文件**：`internal/db/highgo_impl.go:33`

**当前代码**：
```go
if dbname == "" {
    dbname = "highgo" // HighGo default database
}
```

**建议**：无需修改，已符合官方规范（默认数据库为 `highgo`）

### 3. 默认用户名

**当前状态**：未在代码中硬编码默认用户名

**瀚高官方默认**：`sysdba`

**建议**：
- 可以在前端 UI 的 HighGo 连接表单中，将用户名输入框的 placeholder 设置为 `sysdba`
- 但不建议硬编码默认值，让用户自行输入更安全

## 三、总结

### 必须修改的项目
- ✅ **无**（当前代码已基本符合规范）

### 建议修改的项目
1. **sslmode 配置**（根据实际环境决定）
   - 开发环境：保持 `disable`
   - 生产环境：修改为 `require`

### 可选优化的项目
1. 将 sslmode 改为可配置（需要修改前后端）
2. 前端 UI 添加 sslmode 选择控件
3. 用户名输入框添加 `sysdba` 提示

## 四、修改优先级

**优先级 1（高）**：
- 集成瀚高 SM3 驱动（参考 `HighGo_SM3_Integration_Guide.md`）

**优先级 2（中）**：
- 根据部署环境调整 sslmode 配置

**优先级 3（低）**：
- 将 sslmode 改为可配置
- UI 优化（placeholder 提示等）

## 五、下一步行动

建议按以下顺序执行：

1. **先集成 SM3 驱动**（参考集成指南）
2. **测试基本连接功能**（使用 sslmode=disable）
3. **如果生产环境需要 SSL**，再修改 sslmode 配置
4. **验证所有功能正常**后，考虑可选优化项

---

**注意**：所有代码修改都应该在集成 SM3 驱动并验证基本功能正常后再进行。
