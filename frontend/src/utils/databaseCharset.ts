// MySQL 系数据源可用的字符集与排序规则选项。
//
// 注意：不要从 wailsjs/go/models 导入这两个类型——ListDatabaseCharsets /
// ListDatabaseCollations 返回的是 connection.QueryResult（Data 为
// interface{}），wails generate module 不会为它们生成 TS 类，CI 重新生成
// 绑定后 import 会直接编译失败。这里在前端本地声明，与后端 Go 结构体
// （connection.DatabaseCharset / connection.DatabaseCollation）字段保持一致。
export interface DatabaseCharsetOption {
  name: string;
  description?: string;
  defaultCollation?: string;
  maxLength?: number;
}

export interface DatabaseCollationOption {
  name: string;
  charset: string;
}
