# 数据导入

## 职责与边界

- 负责：表数据导入的 CSV / JSON / XLSX 流式解析、列预览、按文件推断建表结构、
  分批写入、导入进度与错误记录。
- 不负责：连接管理、驱动 SQL 生成、SQL 文件执行、数据同步、连接包导入；
  这些入口各有独立实现。

## 真源

- 绑定层：`internal/app/methods_file_import_data.go`、`internal/app/methods_file_import_schema.go`
- 解析与执行：`internal/app/import_pipeline_stream.go`、`internal/app/import_pipeline_batch.go`
- XLSX：`internal/app/xlsx_import_stream.go`、`internal/app/xlsx_import_rows.go`
- 建表推断：`internal/app/import_schema_inference.go`
- 跨层契约：`ImportFileOptions`、`ImportTableSchemaInference`、
  `frontend/src/components/dataImport/importTableTypeMapping.types.ts`
- 前端入口：`frontend/src/components/DataImportWorkbench.tsx`、
  `frontend/src/components/dataImport/hooks/useImportTableCreateInference.ts`

## 运行时路径

```text
DataImportWorkbench
  -> SelectDataImportFile
  -> 按文件新建表：InferImportTableSchema
  -> inferImportTableSchema -> 读取表头/类型行/注释行 -> 采样数据行
  -> 前端生成 CREATE TABLE SQL 并提交 AutoCreateTable
  -> ImportDataWithProgressOptions
  -> streamImportFileWithOptionsContext
  -> CSV / JSON / XLSX 解析器逐行调用 importBatchConsumer
  -> importRowWriter 按批或逐行写入目标表
```

## 状态与不变量

- 结构推断只读取前 500 个数据行；`sampledRows <= sampleLimit`。
- 达到采样上限是正常结束，不是解析失败。格式解析层可能包装哨兵错误，
  调用方必须用 `errors.Is` 判断。
- 500 行只限制类型推断；确认建表后，正式导入会继续流式读取全文件。
- 类型行和注释行只作为元数据读取，不进入数据导入。
- 正式导入按 `defaultImportApplyBatchSize` 和字节上限分批；大文件不应整文件
  解析成 `[]map[string]interface{}` 后再写库。
- 列名、逻辑类型与 `ImportFileOptions` JSON 字段是前端、Wails 绑定和 Web RPC 共用契约。

## 失败语义

- 文件打不开、格式不支持、表头缺失：返回失败并中止，不进入写库阶段。
- 采样达到上限：停止继续解析，保留已采样列类型并返回成功。
- 解析错误：带格式和行号返回；正式导入会把解析失败记录为错误产物。
- 取消/超时：`context.Context` 传到解析器与写入层；取消不当作成功。
- 写入模式：支持批量且 fail-fast 时按批提交；开启 `continueOnError` 时逐行写入，
  以便定位具体失败行。

## 验证

```bash
go test ./internal/app -run '^(TestInferImportTableSchema|TestImportHeaderMetadata|TestXLSX)' -count=1
go test ./internal/app -count=1
go vet ./internal/app
```

前端涉及按文件新建表或导入弹窗时：

```bash
cd frontend
npx vitest run src/components/dataImport src/components/DataImportWorkbench.auto-create.test.tsx
npx tsc --noEmit
```

## 已知边界 / 未确认

- `.xls` 二进制工作簿不支持，需先转为 `.xlsx` 或 CSV。
- XLSX 仍受压缩包条目、总解压大小、共享字符串数量/字节数和单行/单元格字节上限约束。
- 700,000 行真实工作簿尚未在当前开发机做端到端导入；回归用例覆盖了 500 行采样边界。
